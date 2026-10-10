/* QTC Chain Console — the JSON-RPC developer workbench.
 * Connects to any Substrate WebSocket RPC (default: the upstream-documented
 * mainnet endpoint wss://rpc.quantus.network). Everything is live: no mocks,
 * no snapshots — if the endpoint is unreachable the console says so.
 */
import {
  QUANTUS_SS58_PREFIX, MAINNET_RPC, LOCAL_RPC, ENDPOINT_PRESETS,
  validateEndpoint, parseParamsJson, explainError, shortHex, formatMs, formatNumber,
  parseAddressInput, decodeBalanceStorage, buildMapKeyHex, accountStorageKeyHex,
  summarizeHeader, summarizeBlock, summarizePeers, summarizeHealth, summarizeRuntimeVersion,
  historyEntry, loadHistory, saveHistory, normalizeHex, isHex, formatPartialFeeQtc,
  parseBlockNumber, isHash32, validPlanckField,
} from './core.js';
import { ConsoleRpc } from './rpc-client.js';
import { RECIPES, RECIPE_CATEGORIES, getRecipe } from './recipes.js';
import { METHOD_GROUPS, allMethods } from './methods.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- syntax highlighting + hex folding ---------- */
function highlightJson(obj) {
  let json = JSON.stringify(obj, null, 2);
  json = esc(json);
  json = json.replace(/(&quot;(\\u[a-f0-9]{4}|\\[^u]|[^\\&])*?&quot;)(\s*:)?/g, (m, str, _inner, colon) => {
    const cls = colon ? 'jk' : 'js';
    return `<span class="${cls}">${str}</span>${colon || ''}`;
  });
  json = json.replace(/\b(-?\d[\d.]*)\b/g, '<span class="jn">$1</span>');
  json = json.replace(/\b(true|false|null)\b/g, '<span class="jb">$1</span>');
  // fold very long hex strings
  json = json.replace(/<span class="js">(&quot;0x[0-9a-fA-F]{130,}&quot;)<\/span>/g,
    (m, s) => `<span class="js fold" data-full="${s}">${esc(shortHex(s.replace(/&quot;/g, ''), 24))} <em>[folded — click]</em></span>`);
  return json;
}

function kvRow(k, v, mono) {
  return `<div class="kv"><span class="k">${esc(k)}</span><span class="v${mono ? ' mono' : ''}">${v}</span></div>`;
}

/* ---------- result summarizers ---------- */
const SUMMARIZERS = {
  header(r) {
    const h = summarizeHeader(r);
    if (!h) return null;
    return kvRow('Block', `#${formatNumber(h.number)}`) + kvRow('Hash', esc(h.hash || '—'), true)
      + kvRow('Parent', esc(shortHex(h.parentHash || '—', 16)), true) + kvRow('State root', esc(shortHex(h.stateRoot || '—', 16)), true);
  },
  hash(r) {
    if (!isHash32(r)) return null; // a "hash" that is not 32 bytes of hex is not presented as one
    return kvRow('Hash', esc(r), true);
  },
  block(r) {
    const b = summarizeBlock(r);
    if (!b) return null;
    return kvRow('Block', `#${formatNumber(b.number)}`) + kvRow('Extrinsics', formatNumber(b.extrinsicCount))
      + kvRow('Total extrinsic bytes', formatNumber(Math.round(b.totalBytes)) + ' B');
  },
  balance(r, ctx) {
    if (r === null) return `<div class="note warn">No storage at this key — the account was never funded, or was reaped below the existential deposit.</div>`;
    const d = decodeBalanceStorage(r);
    if (!d.ok) return `<div class="note warn">${esc(d.error)}</div>`;
    return kvRow('Address', esc(ctx.address), true)
      + kvRow('Free', `<b>${esc(d.freeQtc)} QTC</b>`) + kvRow('Reserved', `${esc(d.reservedQtc)} QTC`)
      + kvRow('Frozen', `${esc(d.frozenQtc)} QTC`) + kvRow('Total', `${esc(d.totalQtc)} QTC`)
      + (d.belowEd ? `<div class="note warn">Below the 0.001 QTC existential deposit — this account can be reaped.</div>` : '');
  },
  nonce(r) {
    const n = parseBlockNumber(r);
    if (n === null) return null; // a nonce that is not a non-negative integer is not a nonce
    return kvRow('Next nonce', `<b>${formatNumber(n)}</b>`);
  },
  storage(r) {
    if (r === null) return `<div class="note warn">Empty — nothing stored at this key.</div>`;
    if (typeof r !== 'string' || !isHex(r) || r.length % 2 !== 0) return null; // storage bytes are even-length 0x-hex or they are not bytes
    return kvRow('Bytes', formatNumber(r.length / 2 - 1) + ' B') + kvRow('Value', esc(shortHex(r, 40)), true);
  },
  runtime(r) {
    const v = summarizeRuntimeVersion(r);
    if (!v) return null;
    const ver = (x) => (x === null ? '—' : String(x));
    return kvRow('Spec', esc(`${v.specName} v${v.specVersion}`), true)
      + kvRow('Impl', v.implName ? esc(`${v.implName} v${ver(v.implVersion)}`) : '—', true)
      + kvRow('Transaction version', esc(ver(v.transactionVersion))) + kvRow('State version', esc(ver(v.stateVersion)));
  },
  properties(r) {
    if (!r || typeof r !== 'object') return null;
    // Each property is display-only here: a malformed one dashes instead of
    // rendering String(x) — "[object Object]" is not a chain property.
    const int = (v) => { const n = parseBlockNumber(v); return n === null ? '—' : String(n); };
    const sym = typeof r.tokenSymbol === 'string' && r.tokenSymbol.length <= 16 ? r.tokenSymbol : '—';
    return kvRow('SS58 prefix', esc(int(r.ss58Format))) + kvRow('Decimals', esc(int(r.tokenDecimals)))
      + kvRow('Symbol', esc(sym));
  },
  metadata(r) {
    if (typeof r !== 'string' || !isHex(r) || r.length % 2 !== 0) return null;
    const bytes = r.length / 2 - 1;
    return kvRow('Metadata size', `<b>${formatNumber(bytes)} bytes</b>`)
      + `<div class="note">Full metadata is a multi-megabyte SCALE blob — decode it in Polkadot-JS Apps, not here. The console fetched it only to prove the node serves it.</div>`;
  },
  health(r) {
    const h = summarizeHealth(r);
    if (!h) return null;
    return kvRow('Syncing', h.isSyncing ? '<b class="amber">yes</b>' : '<b class="green">no</b>')
      + kvRow('Peers', formatNumber(h.peers)) + kvRow('Should have peers', String(h.shouldHavePeers));
  },
  peers(r) {
    const rows = summarizePeers(r);
    if (!rows) return null;
    if (!rows.length) return `<div class="note warn">No peers connected. If this persists, check the P2P port (30333/tcp) and bootnodes — see the Node Operator Desk.</div>`;
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Peer</th><th>Roles</th><th>Best #</th><th>Best hash</th></tr></thead><tbody>`
      + rows.slice(0, 25).map((p) => `<tr><td class="mono">${esc(shortHex(p.peerId || '—', 12))}</td><td>${esc(p.roles || '—')}</td><td class="num">${formatNumber(p.bestNumber ?? '—')}</td><td class="mono">${esc(p.bestHash || '—')}</td></tr>`).join('')
      + `</tbody></table></div>` + (rows.length > 25 ? `<div class="note">${rows.length - 25} more peers in raw JSON.</div>` : '');
  },
  sync(r) {
    if (!r || typeof r !== 'object') return null;
    const start = parseBlockNumber(r.startingBlock);
    const cur = parseBlockNumber(r.currentBlock);
    const high = parseBlockNumber(r.highestBlock);
    if (start === null || cur === null || high === null) return null; // a gap computed from garbage is a lie in both directions
    const gap = high - cur;
    return kvRow('Starting block', formatNumber(start)) + kvRow('Current block', formatNumber(cur))
      + kvRow('Highest known', formatNumber(high))
      + kvRow('Gap', gap <= 0 ? '<b class="green">synced</b>' : `<b class="amber">${formatNumber(gap)} blocks behind</b>`);
  },
  fee(r) {
    if (!r || typeof r !== 'object') return null;
    const pf = r.partialFee;
    const qtc = formatPartialFeeQtc(pf);
    const raw = validPlanckField(pf);
    const weight = r.weight && typeof r.weight === 'object' ? JSON.stringify(r.weight) : null;
    return kvRow('Partial fee', `<b>${esc(qtc)} QTC</b>`) + kvRow('Raw (planck)', esc(raw ?? '—'), true)
      + kvRow('Weight', esc(weight ?? '—')) + kvRow('Class', esc(typeof r.class === 'string' ? r.class : '—'));
  },
  feedetails(r) {
    if (!r || typeof r !== 'object') return null;
    const inc = r.inclusionFee && typeof r.inclusionFee === 'object' ? r.inclusionFee : {};
    const amt = (v) => esc(validPlanckField(v) ?? '—');
    return kvRow('Base fee', amt(inc.baseFee), true) + kvRow('Length fee', amt(inc.lenFee), true)
      + kvRow('Weight fee', amt(inc.adjustedWeightFee), true) + kvRow('Tip', amt(r.tip), true);
  },
  submit(r) {
    // The one write path in the console: only a real 32-byte hash may be
    // presented as an accepted transaction. Anything else means the
    // broadcast's fate is unknown — say so, never invent a hash.
    if (!isHash32(r)) {
      return `<div class="note warn">The node answered, but not with a transaction hash — treat this broadcast as <b>unconfirmed</b> and check the Mempool Desk / explorer before re-sending (a re-send could double-spend the nonce). The raw response is below.</div>`;
    }
    return `<div class="note ok">Accepted by the node. Transaction hash:</div>` + kvRow('Tx hash', esc(r), true)
      + `<div class="note">Watch it in the Mempool Desk or the explorer — acceptance is not finality.</div>`;
  },
};

/* ---------- state ---------- */
let rpc = null;
let connectedUrl = null;
let history = loadHistory(localStorage);
let stats = { calls: 0, errors: 0, totalMs: 0 };
let activeSubs = new Map(); // key -> {subId, method, unsub, stop}
let startingSubs = new Set(); // keys whose subscribe RPC is still in flight
let subStartSeq = new Map(); // key -> latest start token; only that token may register/report
let currentTab = 'console';
let selectedRecipe = null;
let pendingBroadcast = null;
let connGen = 0;      // bumped on every connect / disconnect / socket teardown — continuations pinned to an older generation are superseded
let handshakeSeq = 0; // latest handshake token; only it may render the identity card
let callSeq = 0;      // latest result-pane call token (runCall + node-identity recipe); only it may render / log / count

/* ---------- connection ---------- */

function setConnPill(state, label) {
  const pill = $('conn-pill');
  pill.className = 'pill ' + state;
  pill.innerHTML = `<span class="dot"></span>${esc(label)}`;
}

async function connect(url) {
  const v = validateEndpoint(url);
  if (!v.ok) { toast(v.error, 'err'); return; }
  disconnect(false);
  const myGen = ++connGen;
  setConnPill('busy', 'connecting…');
  const myRpc = new ConsoleRpc(v.url);
  rpc = myRpc;
  myRpc.onStatus = (s) => {
    if (rpc !== myRpc) return; // a superseded socket must not tear down its replacement
    if (s === 'open') { /* handshake drives the pill */ }
    if (s === 'closed' || s === 'error') {
      if (connectedUrl) {
        connectedUrl = null;
        voidPendingBroadcast('the connection was lost');
        // The socket is gone: any handshake/call still in flight on it is
        // superseded, and this teardown owns the busy indicator it leaves.
        connGen++; handshakeSeq++; callSeq++;
        setBusy(false);
        setConnPill('down', 'disconnected'); renderHandshake(null); toast('Connection lost.', 'err');
      }
    }
  };
  const t0 = performance.now();
  try {
    await myRpc.connect();
    if (myGen !== connGen || rpc !== myRpc) { try { myRpc.close(); } catch {} return; }
    const ms = performance.now() - t0;
    connectedUrl = v.url;
    setConnPill('up', `connected · ${formatMs(ms)}`);
    toast(`Connected to ${shortHex(v.url, 30)}`, 'ok');
    await handshake(myRpc, myGen);
  } catch (e) {
    if (myGen !== connGen || rpc !== myRpc) return; // superseded failure discards itself silently
    const x = explainError(e);
    setConnPill('down', 'failed');
    renderHandshake(null);
    showBanner(x.title, x.hint);
    rpc = null;
  }
  renderHistory();
}

function disconnect(silent = true) {
  // Invalidate everything still in flight for this connection — subscribe
  // starts (below), the handshake, and any result-pane call: their
  // continuations must not register, render, or report for a dead
  // connection, and this path owns the busy indicator they leave behind.
  // A pending broadcast review was made against THIS connection: void it,
  // so it cannot be confirmed against a different node after a reconnect.
  voidPendingBroadcast('the connection');
  connGen++;
  handshakeSeq++;
  callSeq++;
  setBusy(false);
  for (const k of startingSubs) subStartSeq.set(k, (subStartSeq.get(k) || 0) + 1);
  startingSubs.clear();
  for (const [, s] of activeSubs) { try { s.stop(); } catch {} }
  activeSubs.clear();
  renderSubs();
  if (rpc) { try { rpc.close(); } catch {} rpc = null; }
  connectedUrl = null;
  setConnPill('down', 'disconnected');
  renderHandshake(null);
  if (!silent) toast('Disconnected.', '');
}

async function handshake(myRpc = rpc, gen = connGen) {
  if (!myRpc) return;
  const token = ++handshakeSeq;
  const isCurrent = () => token === handshakeSeq && gen === connGen && rpc === myRpc;
  try {
    const [chain, name, version, props, headHash] = await Promise.all([
      myRpc.call('system_chain'), myRpc.call('system_name'), myRpc.call('system_version'),
      myRpc.call('system_properties').catch(() => null),
      myRpc.call('chain_getBlockHash', [0]).catch(() => null),
    ]);
    if (!isCurrent()) return; // superseded (disconnect / reconnect): the newer state owns the card
    // The identity card is only as good as its types: a node (or a broken
    // proxy) answering system_chain with an object must not be rendered as
    // a chain named "[object Object]".
    if (typeof chain !== 'string' || !chain || typeof name !== 'string' || !name || typeof version !== 'string' || !version) {
      renderHandshake({ error: { title: 'Malformed node identity', hint: 'The endpoint answered the identity calls with unexpected types — system_chain, system_name and system_version must be strings. Do not trust this endpoint.' } });
      return;
    }
    renderHandshake({ chain, name, version, props, headHash });
  } catch (e) {
    if (!isCurrent()) return; // a dead connection's handshake error must not repaint the card
    renderHandshake({ error: explainError(e) });
  }
}

function renderHandshake(h) {
  const el = $('handshake');
  if (!h) { el.innerHTML = `<div class="hs-empty">Not connected. Pick an endpoint and connect — the node's identity card appears here.</div>`; return; }
  if (h.error) { el.innerHTML = `<div class="note warn">${esc(h.error.title)} — ${esc(h.error.hint)}</div>`; return; }
  const p = h.props && typeof h.props === 'object' ? h.props : {};
  const int = (v) => { const n = parseBlockNumber(v); return n === null ? '—' : String(n); };
  el.innerHTML = `<div class="hs-grid">`
    + kvRow('Chain', esc(String(h.chain))) + kvRow('Node', esc(`${h.name} ${h.version}`))
    + kvRow('SS58', esc(int(p.ss58Format))) + kvRow('Decimals', esc(int(p.tokenDecimals)))
    + kvRow('Symbol', esc(typeof p.tokenSymbol === 'string' && p.tokenSymbol.length <= 16 ? p.tokenSymbol : '—'))
    + kvRow('Genesis', isHash32(h.headHash) ? esc(shortHex(h.headHash, 14)) : '—', true)
    + `</div><div class="hs-foot">Live values, read from the node you connected to — not from this page's source.</div>`;
}

/* ---------- generic call runner ---------- */

async function runCall({ method, params, label, summarizeKey, ctx, onResult }) {
  if (!rpc || !rpc.connected) { toast('Connect to an endpoint first.', 'err'); return null; }
  const myRpc = rpc;
  const gen = connGen;
  const token = ++callSeq;
  const isCurrent = () => token === callSeq && gen === connGen && rpc === myRpc;
  const t0 = performance.now();
  setBusy(true, label || method);
  try {
    const result = await myRpc.call(method, params);
    // Superseded while in flight (a newer call started, or the connection
    // moved): discard silently — the newer call / teardown owns the result
    // pane, the history, the stats, and the busy indicator.
    if (!isCurrent()) return null;
    const ms = performance.now() - t0;
    stats.calls++; stats.totalMs += ms;
    pushHistory(method, params, ms, true);
    renderResult({ method, params, result, ms, ok: true, summarizeKey, ctx, onResult });
    return result;
  } catch (e) {
    if (!isCurrent()) return null; // superseded failure discards itself silently
    const ms = performance.now() - t0;
    stats.errors++; stats.totalMs += ms;
    const x = explainError(e);
    pushHistory(method, params, ms, false, x.title);
    renderResult({ method, params, result: null, ms, ok: false, error: x, summarizeKey, ctx });
    return null;
  } finally {
    if (isCurrent()) {
      setBusy(false);
      renderStats();
    }
  }
}

function setBusy(b, label) {
  const el = $('busy');
  el.style.display = b ? 'flex' : 'none';
  if (b) $('busy-label').textContent = label || 'working…';
}

function renderResult({ method, params, result, ms, ok, error, summarizeKey, ctx }) {
  // Any rendered result supersedes a pending broadcast review (its UI is
  // being overwritten): clear the captured hex silently so no orphaned
  // review state survives without its confirm screen.
  pendingBroadcast = null;
  const el = $('result');
  const req = JSON.stringify({ jsonrpc: '2.0', id: '…', method, params }, null, 2);
  let summaryHtml = '';
  if (ok && summarizeKey && SUMMARIZERS[summarizeKey]) {
    try {
      const s = SUMMARIZERS[summarizeKey](result, ctx || {});
      if (s) summaryHtml = `<div class="summary">${s}</div>`;
    } catch (e) { summaryHtml = `<div class="note warn">Summarizer failed: ${esc(e.message)} — raw JSON below.</div>`; }
  }
  const body = ok
    ? `${summaryHtml}<pre class="json">${highlightJson(result)}</pre>`
    : `<div class="err-card"><div class="err-title">${esc(error.title)}</div><div class="err-hint">${esc(error.hint)}</div></div>`;
  el.innerHTML = `
    <div class="res-head">
      <span class="res-method mono">${esc(method)}</span>
      <span class="res-meta">${ok ? '<b class="green">ok</b>' : '<b class="red">error</b>'} · ${formatMs(ms)}</span>
      <span class="res-actions"><button class="btn small" data-act="copy-res">copy JSON</button></span>
    </div>${body}
    <details class="req"><summary>request</summary><pre class="json dim">${esc(req)}</pre></details>`;
  el.dataset.raw = ok ? JSON.stringify(result) : '';
  el.querySelector('[data-act="copy-res"]').addEventListener('click', () => {
    navigator.clipboard.writeText(el.dataset.raw || '').then(() => toast('Copied.', 'ok'), () => toast('Copy failed.', 'err'));
  });
  el.querySelectorAll('.fold').forEach((f) => f.addEventListener('click', () => {
    f.outerHTML = `<span class="js">${f.dataset.full}</span>`;
  }));
  el.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'nearest' });
}

function showBanner(title, hint) {
  const el = $('banner');
  el.innerHTML = `<div class="banner"><b>${esc(title)}</b><span>${esc(hint)}</span><button class="btn small" id="banner-x">dismiss</button></div>`;
  $('banner-x').addEventListener('click', () => { el.innerHTML = ''; });
}

function toast(msg, kind) {
  const el = $('toasts');
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.textContent = msg;
  el.appendChild(d);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 400); }, 3200);
}

/* ---------- history ---------- */

function pushHistory(method, params, ms, ok, errorTitle) {
  history.unshift(historyEntry(method, params, ms, ok, errorTitle));
  history = history.slice(0, 200);
  saveHistory(localStorage, history);
  renderHistory();
}

function renderHistory() {
  const el = $('history-list');
  if (!history.length) { el.innerHTML = `<div class="hist-empty">No calls yet this browser. Every call you make is logged here.</div>`; return; }
  el.innerHTML = history.map((h, i) => `
    <div class="hist-row" data-i="${i}">
      <span class="hist-dot ${h.ok ? 'ok' : 'bad'}"></span>
      <span class="hist-method mono">${esc(h.method)}</span>
      <span class="hist-params mono">${esc(h.paramsPreview)}</span>
      <span class="hist-ms">${formatMs(h.ms)}</span>
      <button class="btn small ghost" data-rerun="${i}">re-run</button>
    </div>`).join('');
  el.querySelectorAll('[data-rerun]').forEach((b) => b.addEventListener('click', () => {
    const h = history[Number(b.dataset.rerun)];
    if (!h) return;
    // Restore the entry's EXACT params, not just its method — restoring
    // only the method silently re-ran the call with whatever stale params
    // were sitting in the Custom tab's textarea.
    if (!h.params) {
      // Legacy entries (pre-fix, no stored params) and oversized entries
      // (params deliberately not stored) must not be re-run blind.
      switchTab('custom');
      $('custom-method').value = h.method;
      const errEl = $('custom-err');
      errEl.hidden = false;
      errEl.textContent = 'This history entry has no stored params (recorded before params were kept, or too large to store) — re-enter its params here before running, so the re-run cannot silently use stale params.';
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(h.method)) {
      toast('That entry is a composite (multi-call) recipe result — re-run it from its recipe card, not the Custom tab.', 'err');
      return;
    }
    switchTab('custom');
    $('custom-method').value = h.method;
    $('custom-params').value = JSON.stringify(h.params);
    $('custom-err').hidden = true;
    runCustom(true);
  }));
}

function renderStats() {
  const avg = stats.calls ? stats.totalMs / stats.calls : 0;
  $('stat-calls').textContent = formatNumber(stats.calls);
  $('stat-err').textContent = formatNumber(stats.errors);
  $('stat-avg').textContent = stats.calls ? formatMs(avg) : '—';
  $('stat-subs').textContent = String(activeSubs.size);
}

/* ---------- recipes UI ---------- */

function renderRecipeCats() {
  const el = $('recipe-cats');
  el.innerHTML = `<button class="chip on" data-cat="all">All</button>` + RECIPE_CATEGORIES.map((c) =>
    `<button class="chip" data-cat="${c.id}">${esc(c.title)}</button>`).join('');
  el.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll('[data-cat]').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    renderRecipes(b.dataset.cat);
  }));
}

function renderRecipes(cat = 'all') {
  const el = $('recipe-grid');
  const list = RECIPES.filter((r) => cat === 'all' || r.cat === cat);
  el.innerHTML = list.map((r) => `
    <button class="recipe-card" data-recipe="${r.id}">
      <div class="rc-tag mono">${esc(r.tag)}</div>
      <div class="rc-title">${esc(r.title)}</div>
      <div class="rc-proves">${esc(r.proves)}</div>
      ${r.gated ? '<div class="rc-gate">write call · gated</div>' : ''}
    </button>`).join('');
  el.querySelectorAll('[data-recipe]').forEach((b) => b.addEventListener('click', () => selectRecipe(b.dataset.recipe)));
}

function selectRecipe(id) {
  selectedRecipe = getRecipe(id);
  voidPendingBroadcast('the selected recipe');
  document.querySelectorAll('.recipe-card').forEach((c) => c.classList.toggle('sel', c.dataset.recipe === id));
  const r = selectedRecipe;
  const form = $('recipe-form');
  form.innerHTML = `
    <div class="rf-head"><span class="mono dim">${esc(r.method)}</span><h3>${esc(r.title)}</h3><p>${esc(r.proves)}</p></div>
    ${r.fields.map((f) => `
      <label class="field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>
      ${f.textarea
        ? `<textarea id="rf-${f.key}" class="mono" rows="3" placeholder="${esc(f.placeholder || '')}"></textarea>`
        : `<input id="rf-${f.key}" class="${f.mono ? 'mono' : ''}" placeholder="${esc(f.placeholder || '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}>`}
      </label>`).join('')}
    ${r.id === 'storage-read' ? `<div class="keybuilder"><button class="btn small" id="kb-toggle">storage-key builder</button>
      <div id="kb" hidden>
        <div class="kb-grid">
          <label class="field"><span>Pallet</span><input id="kb-pallet" value="System"></label>
          <label class="field"><span>Storage item</span><input id="kb-item" value="Account"></label>
          <label class="field"><span>SS58 address (map key)</span><input id="kb-addr" class="mono" placeholder="qz…"></label>
        </div>
        <button class="btn small" id="kb-build">build key</button>
        <div id="kb-out" class="mono dim"></div>
      </div></div>` : ''}
    ${r.gateNote ? `<div class="note warn">${esc(r.gateNote)}</div>` : ''}
    <div class="rf-actions">
      ${r.gated
        ? `<button class="btn warn" id="rf-run">review broadcast…</button>`
        : `<button class="btn primary" id="rf-run">run</button>`}
    </div>
    <div id="rf-err" class="note warn" hidden></div>`;
  $('rf-run').addEventListener('click', () => runSelectedRecipe());
  // Any edit to the recipe inputs after a broadcast review voids it: the
  // review pinned the values at review time, so a form that no longer
  // matches the review must not be confirmable against it. (Programmatic
  // writes fire no input events, so building a key or running the recipe
  // never self-voids.)
  form.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('input', () => voidPendingBroadcast('the recipe inputs')));
  const kb = $('kb-toggle');
  if (kb) kb.addEventListener('click', () => { $('kb').hidden = !$('kb').hidden; });
  const kbb = $('kb-build');
  if (kbb) kbb.addEventListener('click', () => {
    const res = buildMapKeyHex($('kb-pallet').value, $('kb-item').value, $('kb-addr').value);
    if (!res.ok) { $('kb-out').innerHTML = `<span class="red">${esc(res.error)}</span>`; return; }
    $('kb-out').textContent = res.keyHex;
    $('rf-key').value = res.keyHex;
  });
  form.scrollIntoView({ behavior: (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: 'nearest' });
}

function readForm(r) {
  const f = {};
  for (const fld of r.fields) {
    const el = $('rf-' + fld.key);
    f[fld.key] = el ? el.value : '';
    if (fld.required && !String(f[fld.key]).trim()) return { ok: false, error: `${fld.label.replace(' *', '')} is required.` };
  }
  return { ok: true, values: f };
}

async function runSelectedRecipe() {
  const r = selectedRecipe;
  if (!r) return;
  const fr = readForm(r);
  const errEl = $('rf-err');
  if (!fr.ok) { errEl.hidden = false; errEl.textContent = fr.error; return; }
  errEl.hidden = true;
  const b = r.build(fr.values);
  if (!b.ok) { errEl.hidden = false; errEl.textContent = b.error; return; }

  if (r.custom === 'nodeid') {
    if (!rpc || !rpc.connected) { toast('Connect to an endpoint first.', 'err'); return; }
    // Same result-pane token discipline as runCall: this composite writes
    // the same pane, history, and stats, so it takes a callSeq token too.
    const myRpc = rpc;
    const gen = connGen;
    const token = ++callSeq;
    const isCurrent = () => token === callSeq && gen === connGen && rpc === myRpc;
    setBusy(true, 'node identity');
    const t0 = performance.now();
    try {
      const calls = ['system_chain', 'system_name', 'system_version', 'system_chainType', 'system_nodeRoles'];
      const results = await Promise.all(calls.map((m) => myRpc.call(m)));
      if (!isCurrent()) return; // superseded: discard silently, like runCall
      const ms = performance.now() - t0;
      stats.calls += calls.length; stats.totalMs += ms;
      pushHistory('system_* (×5)', calls, ms, true);
      const [chain, name, version, type, roles] = results;
      // Same identity-type gate as the handshake: garbage types here are a
      // failed call, not an identity card full of "[object Object]".
      if (typeof chain !== 'string' || !chain || typeof name !== 'string' || !name || typeof version !== 'string' || !version
        || typeof type !== 'string' || !Array.isArray(roles) || roles.some((x) => typeof x !== 'string')) {
        throw new Error('the node returned a malformed identity (system_chain / system_name / system_version / system_chainType / system_nodeRoles had unexpected types)');
      }
      pendingBroadcast = null; // this write supersedes any pending review, like renderResult
      const el = $('result');
      el.innerHTML = `<div class="res-head"><span class="res-method mono">node identity</span>
        <span class="res-meta"><b class="green">ok</b> · ${formatMs(ms)}</span></div>
        <div class="summary">${kvRow('Chain', esc(String(chain)))}${kvRow('Node', esc(`${name} ${version}`))}
        ${kvRow('Chain type', esc(String(type)))}${kvRow('Roles', esc(JSON.stringify(roles)))}</div>
        <pre class="json">${highlightJson({ chain, name, version, type, roles })}</pre>`;
      el.dataset.raw = JSON.stringify({ chain, name, version, type, roles });
    } catch (e) {
      if (!isCurrent()) return; // superseded failure discards itself silently
      const x = explainError(e);
      renderResult({ method: 'system_* (×5)', params: [], result: null, ms: performance.now() - t0, ok: false, error: x });
    } finally { if (isCurrent()) { setBusy(false); renderStats(); } }
    return;
  }

  if (r.gated) { return reviewBroadcast(b.params[0]); }

  const ctx = {};
  if (r.id === 'balance') {
    const p = parseAddressInput(fr.values.address);
    if (!p.ok) { errEl.hidden = false; errEl.textContent = p.error; return; }
    ctx.address = p.address;
  }
  await runCall({ method: r.method, params: b.params, label: r.title, summarizeKey: r.summarize, ctx });
}

/* The broadcast review is a pin on (extrinsic hex, connection): its size /
 * head / tail describe the hex captured at review time, on the connection
 * live at review time, and its confirm button broadcasts exactly that hex.
 * If a determinant changes after the review — the recipe inputs are edited,
 * a different recipe is selected, or the connection drops / is replaced —
 * the review no longer describes what would be sent, so it is voided: the
 * captured hex is dropped and, while the review screen is still the one in
 * the result pane, it is replaced with a cleared note naming what changed.
 * Scoped like the fleet's other determinant-voiding fixes: uncommitted
 * typing that changes no determinant (e.g. editing the endpoint field
 * without connecting) does NOT void — only committed changes do. */
function voidPendingBroadcast(what) {
  if (pendingBroadcast === null) return;
  pendingBroadcast = null;
  if ($('bc-go')) {
    $('result').innerHTML = `
      <div class="res-head"><span class="res-method mono">author_submitExtrinsic</span><span class="res-meta"><b class="amber">review cleared</b></span></div>
      <div class="note warn">Broadcast review cleared — ${esc(what)} changed after the review, so the extrinsic that was reviewed is no longer the one that would be sent. Review the current values again before broadcasting.</div>
      ${resultPlaceholder()}`;
  }
}

/* gated broadcast: review → confirm */
function reviewBroadcast(extHex) {
  const bytes = extHex.length / 2 - 1;
  pendingBroadcast = extHex;
  $('result').innerHTML = `
    <div class="res-head"><span class="res-method mono">author_submitExtrinsic</span><span class="res-meta"><b class="amber">awaiting confirmation</b></span></div>
    <div class="summary">
      ${kvRow('Size', `<b>${formatNumber(bytes)} bytes</b>`)}
      ${kvRow('Head', esc(shortHex(extHex, 24)), true)}
      ${kvRow('Tail', esc('…' + extHex.slice(-24)), true)}
    </div>
    <div class="note warn"><b>This broadcasts to the live network.</b> It spends real QTC on fees, it cannot be undone, and the console cannot verify the signature is yours — it only moves bytes. Public RPCs often reject this call; that is their policy.</div>
    <label class="check"><input type="checkbox" id="bc-ack"> I understand this is irreversible and the hex is mine.</label>
    <div class="rf-actions"><button class="btn danger" id="bc-go" disabled>confirm broadcast</button>
    <button class="btn ghost" id="bc-cancel">cancel</button></div>`;
  $('bc-ack').addEventListener('change', (e) => { $('bc-go').disabled = !e.target.checked; });
  $('bc-cancel').addEventListener('click', () => { pendingBroadcast = null; $('result').innerHTML = resultPlaceholder(); });
  $('bc-go').addEventListener('click', async () => {
    const hex = pendingBroadcast;
    pendingBroadcast = null;
    await runCall({ method: 'author_submitExtrinsic', params: [hex], label: 'broadcasting…', summarizeKey: 'submit' });
  });
}

function resultPlaceholder() {
  return `<div class="res-empty">Run a recipe or a custom method — the request, the summary, and the raw JSON land here.</div>`;
}

/* ---------- custom method ---------- */

function renderMethodDatalist() {
  $('method-list').innerHTML = allMethods().map((m) => `<option value="${m.name}">`).join('');
}

async function runCustom(fromHistory) {
  const method = $('custom-method').value.trim();
  const errEl = $('custom-err');
  if (!method) { errEl.hidden = false; errEl.textContent = 'Enter a method name.'; return; }
  if (!/^[a-zA-Z0-9_]+$/.test(method)) { errEl.hidden = false; errEl.textContent = 'Method names are alphanumeric + underscore.'; return; }
  const p = parseParamsJson($('custom-params').value);
  if (!p.ok) { errEl.hidden = false; errEl.textContent = p.error; return; }
  errEl.hidden = true;
  await runCall({ method, params: p.params, label: method });
}

/* ---------- subscriptions ---------- */

const SUB_DEFS = [
  {
    key: 'newHeads', title: 'New heads', sub: 'chain_subscribeNewHeads', unsub: 'chain_unsubscribeNewHeads',
    blurb: 'Every new block, live, with block times.',
    render(n, prev) {
      // A notification is untrusted like any other result: a head whose
      // number does not parse is not logged as "#NaN" chain fact — the
      // render returns null and the caller skips the feed row entirely.
      if (!n || typeof n !== 'object') return null;
      const num = parseBlockNumber(n.number);
      if (num === null) return null;
      const dt = prev && prev.t ? ` · +${((Date.now() - prev.t) / 1000).toFixed(1)}s` : '';
      const hash = isHash32(n.hash) ? ` · <span class="mono dim">${esc(shortHex(n.hash, 12))}</span>` : '';
      return `#${formatNumber(num)}${dt}${hash}`;
    },
  },
  {
    key: 'finalized', title: 'Finalized heads', sub: 'chain_subscribeFinalizedHeads', unsub: 'chain_unsubscribeFinalizedHeads',
    blurb: 'Only the heads the network irreversibly agrees on.',
    render(n) {
      if (!n || typeof n !== 'object') return null;
      const num = parseBlockNumber(n.number);
      if (num === null) return null;
      const hash = isHash32(n.hash) ? ` · <span class="mono dim">${esc(shortHex(n.hash, 12))}</span>` : '';
      return `#${formatNumber(num)} finalized${hash}`;
    },
  },
];

function renderSubs() {
  const el = $('subs');
  let html = SUB_DEFS.map((d) => {
    const active = activeSubs.has(d.key);
    const starting = !active && startingSubs.has(d.key);
    return `<div class="sub-card${active ? ' live' : ''}">
      <div class="sub-head"><b>${esc(d.title)}</b><span class="pill ${active ? 'up' : starting ? 'busy' : 'down'}"><span class="dot"></span>${active ? 'live' : starting ? 'starting' : 'off'}</span></div>
      <p>${esc(d.blurb)}</p><div class="mono dim small">${esc(d.sub)}</div>
      <div class="rf-actions">${active || starting
        ? `<button class="btn small" data-stop="${d.key}">stop</button>`
        : `<button class="btn small primary" data-start="${d.key}">start</button>`}</div>
    </div>`;
  }).join('');
  const wActive = activeSubs.has('storageWatch');
  const wStarting = !wActive && startingSubs.has('storageWatch');
  html += `<div class="sub-card${wActive ? ' live' : ''}">
      <div class="sub-head"><b>Storage watch</b><span class="pill ${wActive ? 'up' : wStarting ? 'busy' : 'down'}"><span class="dot"></span>${wActive ? 'live' : wStarting ? 'starting' : 'off'}</span></div>
      <p>Watch an account's balance move in real time.</p>
      <label class="field"><span>SS58 address</span><input id="sw-addr" class="mono" placeholder="qz…" ${wActive || wStarting ? 'disabled' : ''}></label>
      <div class="mono dim small">state_subscribeStorage</div>
      <div class="rf-actions">${wActive || wStarting
        ? `<button class="btn small" data-stop="storageWatch">stop</button>`
        : `<button class="btn small primary" data-start="storageWatch">start</button>`}</div>
    </div>`;
  el.innerHTML = html;
  el.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => startSub(b.dataset.start)));
  el.querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', () => stopSub(b.dataset.stop)));
}

async function startSub(key) {
  if (!rpc || !rpc.connected) { toast('Connect to an endpoint first.', 'err'); return; }
  // A start already in flight owns this key: a second click must not open a
  // second node subscription (the first would be overwritten in activeSubs
  // and leaked — never unsubscribed, feeding forever).
  if (activeSubs.has(key) || startingSubs.has(key)) return;
  const def = SUB_DEFS.find((d) => d.key === key);
  // Validate the storage key BEFORE marking the start: renderSubs() below
  // re-creates the (now disabled) address input, wiping its value.
  let storageKeyHex = null;
  if (!def && key === 'storageWatch') {
    const k = accountStorageKeyHex($('sw-addr').value);
    if (!k.ok) { toast(k.error, 'err'); return; }
    storageKeyHex = k.keyHex;
  }
  const myRpc = rpc;
  const token = (subStartSeq.get(key) || 0) + 1;
  subStartSeq.set(key, token);
  const isCurrent = () => subStartSeq.get(key) === token && rpc === myRpc;
  startingSubs.add(key);
  renderSubs();
  try {
    let subId = null;
    let unsubMethod = null;
    if (def) {
      unsubMethod = def.unsub;
      subId = await myRpc.subscribe(def.sub, [], (n) => {
        const html = def.render(n, activeSubs.get(key)?.prev);
        if (html) feedLog(key, html, n); // null render = malformed notification: no feed row, no fake head
      });
    } else if (key === 'storageWatch') {
      unsubMethod = 'state_unsubscribeStorage';
      subId = await myRpc.subscribe('state_subscribeStorage', [[storageKeyHex]], (cs) => {
        // A storage change set is { block: <32-byte HASH>, changes: [[key,
        // value|null]] } — the block field is a hash, never a height:
        // Number(hash) used to print a 77-digit invented "block number".
        // Malformed change sets are skipped, not narrated.
        if (!cs || typeof cs !== 'object' || !Array.isArray(cs.changes) || !cs.changes.length) return;
        const ch = cs.changes[0];
        if (!Array.isArray(ch)) return;
        const val = ch[1];
        if (val !== null && !(typeof val === 'string' && isHex(val))) return;
        const at = isHash32(cs.block) ? ` @ block <span class="mono dim">${esc(shortHex(cs.block, 12))}</span>` : '';
        const txt = val === null
          ? `balance key cleared${at} · <span class="mono dim">value removed</span>`
          : `balance key changed${at} · <span class="mono dim">${esc(shortHex(val, 24))}</span>`;
        feedLog(key, txt);
      });
    } else {
      return;
    }
    if (!isCurrent()) {
      // Superseded while subscribing (stop pressed, disconnect, reconnect):
      // release the just-created subscription on the socket that made it
      // instead of registering it, and say nothing — the user's newer
      // action already owns the UI.
      try { await myRpc.unsubscribe(unsubMethod, subId); } catch {}
      return;
    }
    activeSubs.set(key, { subId, stop: async () => { await myRpc.unsubscribe(unsubMethod, subId); }, prev: null });
    toast('Subscription live.', 'ok');
  } catch (e) {
    if (!isCurrent()) return; // superseded failure discards itself silently
    const x = explainError(e);
    toast(`${x.title}: ${x.hint}`, 'err');
  } finally {
    if (subStartSeq.get(key) === token) startingSubs.delete(key);
    renderSubs();
    renderStats();
  }
}

async function stopSub(key) {
  // Stopping a start that is still in flight cancels it: bumping the token
  // makes its continuation release the subscription instead of going live.
  if (startingSubs.has(key)) {
    subStartSeq.set(key, (subStartSeq.get(key) || 0) + 1);
    startingSubs.delete(key);
    renderSubs();
    renderStats();
    toast('Subscription stopped.', '');
    return;
  }
  const s = activeSubs.get(key);
  if (!s) return;
  try { await s.stop(); } catch {}
  activeSubs.delete(key);
  renderSubs();
  renderStats();
  toast('Subscription stopped.', '');
}

function feedLog(key, html) {
  const el = $('feed');
  const row = document.createElement('div');
  row.className = 'feed-row';
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  row.innerHTML = `<span class="feed-t">${time}</span><span class="feed-k">${esc(key)}</span><span class="feed-b">${html}</span>`;
  el.prepend(row);
  while (el.children.length > 100) el.lastChild.remove();
  const prev = activeSubs.get(key);
  if (prev) prev.prev = { t: Date.now() };
}

/* ---------- reference ---------- */

function renderReference(filter = '') {
  const el = $('ref-groups');
  const q = filter.trim().toLowerCase();
  el.innerHTML = METHOD_GROUPS.map((g) => {
    const ms = g.methods.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q));
    if (!ms.length) return '';
    return `<div class="ref-group"><h4>${esc(g.title)}</h4>` + ms.map((m) => `
      <div class="ref-row">
        <div class="ref-name mono">${esc(m.name)}</div>
        <div class="ref-sig mono dim">${esc(m.name)}(${m.params.join(', ')}) → ${esc(m.returns)}</div>
        <div class="ref-note">${esc(m.note)}</div>
        <div class="ref-act">${m.recipe ? `<button class="btn small ghost" data-recipe-go="${m.recipe}">open recipe →</button>` : ''}</div>
      </div>`).join('') + `</div>`;
  }).join('') || `<div class="note">No methods match.</div>`;
  el.querySelectorAll('[data-recipe-go]').forEach((b) => b.addEventListener('click', () => {
    switchTab('console');
    const catBtn = document.querySelector('#recipe-cats [data-cat="all"]');
    if (catBtn) catBtn.click();
    selectRecipe(b.dataset.recipeGo);
  }));
}

/* ---------- tabs ---------- */

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + name));
}

/* ---------- boot ---------- */

function init() {
  // endpoint presets
  $('endpoint-presets').innerHTML = ENDPOINT_PRESETS.map((p, i) =>
    `<button class="preset" data-i="${i}"><b>${esc(p.label)}</b><span class="mono dim">${esc(p.url)}</span><em>${esc(p.note)}</em></button>`).join('');
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => {
    $('endpoint').value = ENDPOINT_PRESETS[Number(b.dataset.i)].url;
  }));
  $('endpoint').value = MAINNET_RPC;
  $('btn-connect').addEventListener('click', () => connect($('endpoint').value));
  $('btn-disconnect').addEventListener('click', () => disconnect(false));
  $('endpoint').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect($('endpoint').value); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  renderRecipeCats();
  renderRecipes();
  renderMethodDatalist();
  $('btn-custom').addEventListener('click', () => runCustom(false));
  $('custom-params').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runCustom(false);
  });
  $('custom-method').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCustom(false); });
  renderSubs();
  renderReference();
  $('ref-search').addEventListener('input', (e) => renderReference(e.target.value));
  renderHistory();
  renderStats();
  $('result').innerHTML = resultPlaceholder();
  renderHandshake(null);
  setConnPill('down', 'disconnected');

  $('btn-clear-hist').addEventListener('click', () => {
    history = []; saveHistory(localStorage, history); renderHistory(); toast('History cleared.', '');
  });
  $('btn-export-hist').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qtc-console-history.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // footer copy buttons + year
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Address copied.', 'ok'), () => toast('Copy failed.', 'err'));
  }));
}

document.addEventListener('DOMContentLoaded', init);
