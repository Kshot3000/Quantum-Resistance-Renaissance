/* QTC Portfolio Desk — the multi-wallet command center.
 *
 * Aggregate every Quantus address you control into one portfolio: live-first
 * balances, liquid vs vesting-locked splits, allocation chart, transfer
 * activity, mining attribution, and vault export. 100% client-side —
 * the vault never leaves the browser.
 */
(function () {
"use strict";

var INDEXER = "https://sqm.quantus.com/v1/graphql";
var EXPLORER = "https://explorer.quantus.com";
var FETCH_TIMEOUT_MS = 12000;
var LIVE_BATCH = 60; // max addresses per live balance query

/* ---------- tiny helpers ---------- */

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(function () {}); return; }
  var ta = document.createElement("textarea");
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}
function toast(msg, kind) {
  var el = $("desk-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = "form-msg " + (kind || "");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.textContent = ""; }, 7000);
}
function relTime(iso) {
  if (!iso) return "—";
  var ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return "just now";
  return QPORT.formatAge(ms) + " ago";
}
function isoDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* ---------- state ---------- */

function blankChain() {
  return {
    mode: "snapshot",          // "live" | "snapshot"
    height: null, accountsTotal: null,
    liveBalances: new Map(),   // addr -> {free,reserved,frozen}
    snapBalances: new Map(),   // addr -> {free,reserved,frozen} (whales top-200)
    schedules: new Map(),      // addr -> [schedule]
    byAddr: new Map(),         // addr -> {in,out,count,lastTs}
    minedCounts: new Map(),    // addr -> n
    supplyPlancks: null,
    fetchedAt: null, liveAt: null,
  };
}

var vault = QPORT.blankVault();
var chain = blankChain();
var phrases = {};   // addr -> [5 words] cache
var revealPhrases = {}; // addr -> bool (user toggled checkphrase visible)

/* ---------- vault persistence ---------- */

function loadVault() {
  try {
    var raw = localStorage.getItem(QPORT.VAULT_KEY);
    if (!raw) return;
    var v = QPORT.parseVaultJson(raw);
    vault = v;
  } catch (e) { /* corrupted storage: start clean */ }
}
function saveVault() {
  try { localStorage.setItem(QPORT.VAULT_KEY, JSON.stringify(vault)); }
  catch (e) { /* quota */ }
}

/* ---------- validation ---------- */

function validateQuantusAddress(addr) {
  var a = QPORT.normalizeAddress(addr);
  if (!a) return { ok: false, message: "Paste an address first." };
  var d = QSS58.ss58Decode(a);
  if (!d.ok) return { ok: false, message: d.error || "Bad SS58 checksum." };
  if (d.prefix !== 189)
    return { ok: false, message: "Valid checksum, but prefix " + d.prefix + " — not Quantus (189). Do not send QTC to it." };
  if (!d.key || d.key.length !== 32)
    return { ok: false, message: "Valid checksum, but the payload is not a 32-byte account key." };
  return { ok: true, address: a };
}

/* ---------- chain data loading ---------- */

function fetchJson(url, timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .catch(function (e) { clearTimeout(t); throw e; });
}

function liveBalanceQuery(addresses) {
  var sel = addresses.slice(0, LIVE_BATCH).map(function (a, i) {
    return "a" + i + ': account_by_pk(id: "' + a + '") { id free reserved frozen }';
  }).join(" ");
  var q = "query { status: chain_stats_by_pk(id: \"global\") { block_height total_accounts } " + sel + " }";
  return fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (j) {
      if (j.errors) throw new Error(j.errors[0].message);
      return j.data;
    });
}

function indexTransfers(transfers) {
  var byAddr = new Map();
  function push(addr, side, t) {
    var e = byAddr.get(addr);
    if (!e) { e = { "in": [], out: [] }; byAddr.set(addr, e); }
    e[side].push(t);
  }
  (transfers || []).forEach(function (t) {
    if (t.from_id) push(t.from_id, "out", t);
    if (t.to_id) push(t.to_id, "in", t);
  });
  byAddr.forEach(function (e) {
    e["in"].sort(function (a, b) { return b.block_height - a.block_height; });
    e.out.sort(function (a, b) { return b.block_height - a.block_height; });
    var lastTs = null;
    e["in"].concat(e.out).forEach(function (t) {
      if (t.timestamp && (!lastTs || t.timestamp > lastTs)) lastTs = t.timestamp;
    });
    e.count = e["in"].length + e.out.length;
    e.lastTs = lastTs;
  });
  return byAddr;
}

function buildChain(bundle, addrs, nowMs) {
  var c = blankChain();
  // flows.json is stored columnar (format v2, assets/flows-decode.js);
  // decode once here — idempotent, v1 object rows pass through untouched.
  if (bundle.flows && typeof QFlows !== "undefined" && QFlows.decode) bundle.flows = QFlows.decode(bundle.flows);
  c.fetchedAt = new Date().toISOString();
  // Live per-address balances
  if (bundle.liveData && bundle.liveData.status) {
    c.mode = "live";
    c.liveAt = new Date().toISOString();
    c.height = bundle.liveData.status.block_height || null;
    c.accountsTotal = bundle.liveData.status.total_accounts || null;
    Object.keys(bundle.liveData).forEach(function (k) {
      if (k === "status" || k === "__typename") return;
      var row = bundle.liveData[k];
      if (row && row.id) c.liveBalances.set(row.id, { free: row.free, reserved: row.reserved, frozen: row.frozen });
    });
  }
  // Snapshots (same-origin)
  function pickSnap(name, payload) {
    if (payload && payload.ok) return payload;
    return null;
  }
  var live = pickSnap("live", bundle.live);      // data/live.json
  var whales = pickSnap("whales", bundle.whales);
  var vesting = pickSnap("vesting", bundle.vesting);
  // flows.json historically shipped WITHOUT the fleet-standard ok:true
  // envelope, and pickSnap discarded it — the transfer index silently
  // stayed empty (0 transfers, empty activity) on every load. The file
  // now carries ok:true, and this shape check makes the class impossible
  // to reintroduce from the data side again.
  var flows = pickSnap("flows", bundle.flows) ||
    (bundle.flows && Array.isArray(bundle.flows.transfers) && bundle.flows.meta ? bundle.flows : null);
  var miners = pickSnap("miners", bundle.miners);
  if (live && live.data && live.data.status) {
    if (c.height == null) c.height = live.data.status.block_height;
    if (c.accountsTotal == null) c.accountsTotal = live.data.status.total_accounts;
  }
  if (whales) {
    (whales.top || []).forEach(function (a) {
      c.snapBalances.set(a.address, { free: a.free_plancks, reserved: a.reserved_plancks, frozen: a.frozen_plancks });
    });
    if (whales.supply_plancks) {
      var sp = whales.supply_plancks;
      try { c.supplyPlancks = BigInt(typeof sp === "object" ? sp.free : sp); }
      catch (e) { c.supplyPlancks = null; }
    }
    if (whales.block_height && c.height == null) c.height = whales.block_height;
  }
  if (vesting) {
    (vesting.schedules || []).forEach(function (s) {
      if (!s.beneficiary) return;
      var arr = c.schedules.get(s.beneficiary);
      if (!arr) { arr = []; c.schedules.set(s.beneficiary, arr); }
      arr.push(s);
    });
  }
  if (flows) c.byAddr = indexTransfers(flows.transfers);
  if (miners) {
    var wm = miners.window_miners || {};
    Object.keys(wm).forEach(function (addr) {
      c.minedCounts.set(addr, (c.minedCounts.get(addr) || 0) + Number(wm[addr] || 0));
    });
    (miners.all_time || []).forEach(function (m) {
      if (m && m.address) c.minedCounts.set(m.address, (c.minedCounts.get(m.address) || 0) + Number(m.blocks || 0));
    });
  }
  return c;
}

function loadChainData() {
  var bust = "?t=" + Date.now();
  var base = "../../data/";
  var addrs = vault.addresses.map(function (e) { return e.address; });
  var liveP = addrs.length
    ? liveBalanceQuery(addrs).then(function (d) { return { liveData: d }; }).catch(function () { return null; })
    : Promise.resolve(null);
  return liveP.then(function (live) {
    var bundle = live || {};
    return Promise.all([
      fetchJson(base + "live.json" + bust).catch(function () { return null; }),
      fetchJson(base + "whales.json" + bust).catch(function () { return null; }),
      fetchJson(base + "vesting.json" + bust).catch(function () { return null; }),
      fetchJson(base + "flows.json" + bust).catch(function () { return null; }),
      fetchJson(base + "miners.json" + bust).catch(function () { return null; }),
    ]).then(function (r) {
      bundle.live = r[0]; bundle.whales = r[1]; bundle.vesting = r[2];
      bundle.flows = r[3]; bundle.miners = r[4];
      chain = buildChain(bundle, addrs, Date.now());
      return chain;
    });
  });
}

function balanceFor(address) {
  // Live-first, snapshot second, honest null third.
  if (chain.liveBalances.has(address)) return { bal: chain.liveBalances.get(address), src: "live" };
  if (chain.snapBalances.has(address)) return { bal: chain.snapBalances.get(address), src: "snapshot" };
  return { bal: null, src: "unknown" };
}

function ctxForRollup() {
  var balances = new Map();
  vault.addresses.forEach(function (e) {
    var b = balanceFor(e.address);
    if (b.bal) balances.set(e.address, b.bal);
  });
  return { balances: balances, schedules: chain.schedules, byAddr: chain.byAddr, minedCounts: chain.minedCounts };
}

/* ---------- checkphrases ---------- */

function derivePhrase(addr) {
  if (phrases[addr]) return Promise.resolve(phrases[addr]);
  return QTC_CHECK.addressToChecksumAsync(addr, QTC_WORDLIST).then(function (w) {
    phrases[addr] = w;
    return w;
  }).catch(function () { return null; });
}

/* ---------- rendering ---------- */

function modeBadge() {
  if (chain.mode === "live")
    return '<span class="mode-badge live">LIVE indexer</span>';
  return '<span class="mode-badge snap">SNAPSHOT</span>';
}

function srcBadge(src) {
  if (src === "live") return '<span class="src live">live</span>';
  if (src === "snapshot") return '<span class="src snap">snapshot</span>';
  return '<span class="src unknown">unknown</span>';
}

function renderOverview(pf) {
  var el = $("pf-overview");
  var pct = (Number(pf.shareOfCap) / 10000).toFixed(4);
  var nextUnlock = pf.nextUnlockMs
    ? isoDate(pf.nextUnlockMs) + " (" + QPORT.formatAge(pf.nextUnlockMs - Date.now()) + ")"
    : "—";
  var cards = [
    ["Total controlled", QPORT.formatQtc(pf.totalControlled) + " QTC", "on-chain free + claimable vesting"],
    ["Liquid (on-chain)", QPORT.formatQtc(pf.totalFree) + " QTC", pf.knownCount + " of " + pf.totalCount + " balances known"],
    ["Vesting-locked", QPORT.formatQtc(pf.totalLocked) + " QTC", "across " + pf.withVesting + " vesting address" + (pf.withVesting === 1 ? "" : "es")],
    ["Claimable now", QPORT.formatQtc(pf.totalClaimable) + " QTC", "vested but unclaimed — permissionless claim"],
    ["Share of 21M cap", pct + " %", pf.totalTx + " transfers · " + pf.totalMined + " blocks mined"],
    ["Next unlock", nextUnlock, pf.nextUnlockMs ? "nearest schedule end" : "no locked schedules"],
  ];
  el.innerHTML = cards.map(function (c) {
    return '<div class="card"><div class="card-label">' + esc(c[0]) + '</div>' +
      '<div class="card-value">' + esc(c[1]) + '</div>' +
      '<div class="card-sub">' + esc(c[2]) + '</div></div>';
  }).join("");
  $("desk-meta").innerHTML = modeBadge() +
    (chain.height ? ' <span class="meta-chip">height ' + chain.height.toLocaleString() + "</span>" : "") +
    (chain.liveAt ? ' <span class="meta-chip">balances live ' + relTime(chain.liveAt) + "</span>"
                  : ' <span class="meta-chip">balances from snapshot ' + relTime(chain.fetchedAt) + "</span>");
}

var DONUT_COLORS = ["#34d399", "#22d3ee", "#a78bfa", "#f472b6", "#fbbf24", "#60a5fa", "#fb7185", "#a3e635"];

function renderDonut(pf) {
  var canvas = $("alloc-donut");
  var legend = $("alloc-legend");
  var rows = pf.allocation.filter(function (a) { return a.controlled > 0n; });
  var total = pf.totalControlled;
  var dpr = window.devicePixelRatio || 1;
  var size = 220;
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + "px"; canvas.style.height = size + "px";
  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);
  if (!rows.length || total <= 0n) {
    ctx.fillStyle = "#475569";
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0b1220";
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 34, 0, Math.PI * 2); ctx.fill();
    legend.innerHTML = '<div class="muted">No balances yet — add an address to see the allocation.</div>';
    return;
  }
  var cx = size / 2, cy = size / 2, r = size / 2 - 12, ir = size / 2 - 40;
  var ang = -Math.PI / 2;
  rows.forEach(function (a, i) {
    var frac = Number(a.controlled) / Number(total);
    var sweep = frac * Math.PI * 2;
    ctx.fillStyle = DONUT_COLORS[i % DONUT_COLORS.length];
    ctx.beginPath();
    ctx.arc(cx, cy, r, ang, ang + sweep);
    ctx.arc(cx, cy, ir, ang + sweep, ang, true);
    ctx.closePath(); ctx.fill();
    ang += sweep;
  });
  ctx.fillStyle = "#0b1220";
  ctx.beginPath(); ctx.arc(cx, cy, ir - 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "center";
  ctx.font = "600 15px system-ui"; ctx.fillText(QPORT.formatQtc(total), cx, cy - 2);
  ctx.fillStyle = "#94a3b8"; ctx.font = "12px system-ui"; ctx.fillText("QTC controlled", cx, cy + 16);
  legend.innerHTML = rows.slice(0, 12).map(function (a, i) {
    var frac = total > 0n ? Number(a.controlled * 10000n / total) / 100 : 0;
    return '<div class="legend-row"><span class="dot" style="background:' + DONUT_COLORS[i % DONUT_COLORS.length] + '"></span>' +
      '<span class="legend-name">' + esc(a.nick || QPORT.shortAddr(a.address)) + '</span>' +
      '<span class="legend-val">' + QPORT.formatQtc(a.controlled) + " QTC · " + frac.toFixed(1) + "%</span></div>";
  }).join("") + (rows.length > 12 ? '<div class="muted">+ ' + (rows.length - 12) + " more</div>" : "");
}

function phraseHtml(addr) {
  if (!revealPhrases[addr])
    return '<button class="mini-btn" data-act="show-phrase" data-addr="' + esc(addr) + '">show checkphrase</button>';
  var w = phrases[addr];
  if (!w) return '<span class="muted">deriving…</span>';
  return w.map(function (x) { return '<span class="pw">' + esc(x) + "</span>"; }).join("") +
    ' <button class="mini-btn" data-act="hide-phrase" data-addr="' + esc(addr) + '">hide</button>';
}

function renderHoldings(pf) {
  var el = $("holdings-body");
  if (!pf.rows.length) {
    el.innerHTML = '<tr><td colspan="7" class="muted center">The vault is empty. Add your first Quantus address above — balances are read live, nothing is ever signed or moved.</td></tr>';
    return;
  }
  el.innerHTML = pf.rows.map(function (r) {
    var b = balanceFor(r.address);
    var balCell = r.balanceKnown
      ? QPORT.formatQtc(r.free) + " QTC " + srcBadge(b.src)
      : '<span class="muted">balance unknown</span> ' + srcBadge(b.src);
    var tags = [];
    if (r.minedBlocks > 0) tags.push('<span class="tag miner">⛏ ' + r.minedBlocks + " blocks</span>");
    if (r.schedules.length > 0) tags.push('<span class="tag vest">🔒 ' + r.schedules.length + " schedule" + (r.schedules.length > 1 ? "s" : "") + "</span>");
    var name = esc(r.nick || QPORT.shortAddr(r.address));
    return "<tr>" +
      '<td><div class="hname">' + name + '</div><div class="haddr mono">' + esc(QPORT.shortAddr(r.address)) +
      ' <button class="mini-btn" data-act="copy" data-addr="' + esc(r.address) + '">copy</button></div>' +
      '<div class="pcheck">' + phraseHtml(r.address) + "</div></td>" +
      '<td class="num">' + balCell + (tags.length ? "<br>" + tags.join(" ") : "") + "</td>" +
      '<td class="num">' + (r.schedules.length ? QPORT.formatQtc(r.claimable) + " QTC" : '<span class="muted">—</span>') + "</td>" +
      '<td class="num">' + (r.schedules.length ? QPORT.formatQtc(r.locked) + " QTC" : '<span class="muted">—</span>') + "</td>" +
      '<td class="num">' + QPORT.formatQtc(r.controlled) + " QTC</td>" +
      '<td class="num">' + (r.txCount ? r.txIn + " in / " + r.txOut + " out<br><span class=\"muted small\">last " + relTime(r.lastTxTs) + "</span>" : '<span class="muted">—</span>') + "</td>" +
      '<td><button class="mini-btn" data-act="refresh" data-addr="' + esc(r.address) + '">refresh</button> ' +
      '<button class="mini-btn danger" data-act="remove" data-addr="' + esc(r.address) + '">remove</button></td>' +
      "</tr>";
  }).join("");
}

function renderVesting(pf) {
  var el = $("vesting-body");
  var rows = [];
  pf.rows.forEach(function (r) {
    r.schedules.forEach(function (s) { rows.push({ r: r, s: s }); });
  });
  if (!rows.length) {
    el.innerHTML = '<tr><td colspan="6" class="muted center">No vesting schedules matched your addresses. Locked genesis allocations (grants, team, etc.) appear here automatically once an address is added.</td></tr>';
    return;
  }
  rows.sort(function (a, b) { return (b.s.claimable > a.s.claimable ? 1 : -1); });
  el.innerHTML = rows.map(function (x) {
    var pct = x.s.total > 0n ? Number(x.s.claimed * 100n / x.s.total) : 0;
    var vestedPct = x.s.total > 0n ? Number((x.s.claimed + x.s.claimable) * 100n / x.s.total) : 0;
    return "<tr>" +
      '<td><div class="hname">' + esc(x.r.nick || QPORT.shortAddr(x.r.address)) + '</div><div class="haddr mono">' + esc(QPORT.shortAddr(x.r.address)) + "</div></td>" +
      '<td>' + esc(String(x.s.cohort)) + ' <span class="muted small">#' + x.s.id + "</span></td>" +
      '<td class="num">' + QPORT.formatQtc(x.s.total) + " QTC</td>" +
      '<td class="num"><div class="pbar"><div class="pfill" style="width:' + Math.min(100, vestedPct) + '%"></div></div><span class="small">' +
      vestedPct.toFixed(1) + "% vested · " + pct.toFixed(1) + "% claimed</span></td>" +
      '<td class="num hl">' + QPORT.formatQtc(x.s.claimable) + " QTC</td>" +
      '<td class="num">' + (x.s.locked > 0n ? isoDate(x.s.endMs) + '<br><span class="muted small">in ' + QPORT.formatAge(Math.max(0, x.s.endMs - Date.now())) + "</span>" : '<span class="muted">fully vested</span>') + "</td>" +
      "</tr>";
  }).join("");
}

function renderActivity() {
  var el = $("activity-list");
  var addrs = vault.addresses.map(function (e) { return e.address; });
  var acts = QPORT.portfolioActivity(chain.byAddr, addrs, 20);
  if (!acts.length) {
    el.innerHTML = '<div class="muted center pad">No transfers found for these addresses in the indexed window (≥ 1 QTC moves in the last 15,000 blocks plus the largest all-time moves). Quiet vault — or brand-new addresses.</div>';
    return;
  }
  el.innerHTML = acts.map(function (x) {
    var t = x.t;
    var nickMap = {};
    vault.addresses.forEach(function (e) { nickMap[e.address] = e.nick || QPORT.shortAddr(e.address); });
    var me = esc(nickMap[x.addr] || QPORT.shortAddr(x.addr));
    var other = x.side === "in" ? t.from_id : t.to_id;
    var dir = x.side === "in"
      ? '<span class="dir in">← IN</span>'
      : '<span class="dir out">OUT →</span>';
    var blk = '<a class="acct" href="' + EXPLORER + "/blocks/" + t.block_height + '" target="_blank" rel="noopener">#' + Number(t.block_height).toLocaleString() + "</a>";
    return '<div class="act-row">' + dir +
      '<div class="act-main"><b>' + QPORT.formatQtc(BigInt(t.amount)) + ' QTC</b> ' +
      (x.side === "in" ? "to " : "from ") + me +
      ' <span class="muted small">' + (x.side === "in" ? "from " : "to ") + esc(QPORT.shortAddr(other)) + "</span></div>" +
      '<div class="act-meta">' + blk + ' · <span title="' + esc(t.timestamp || "") + '">' + relTime(t.timestamp) + "</span></div></div>";
  }).join("");
}

function renderAll() {
  var pf = QPORT.rollupPortfolio(vault, ctxForRollup(), Date.now());
  renderOverview(pf);
  renderDonut(pf);
  renderHoldings(pf);
  renderVesting(pf);
  renderActivity();
  $("vault-count").textContent = vault.addresses.length + " address" + (vault.addresses.length === 1 ? "" : "es");
  $("btn-export-csv").disabled = !pf.rows.length;
  $("btn-export-json").disabled = !vault.addresses.length;
}

/* ---------- add-address flow ---------- */

var pendingAddr = null;
var validateSeq = 0;       // only the latest validate may render a confirm
var derivingFor = null;    // address a checkphrase KDF is in flight for

function voidPending(explanation) {
  validateSeq++;
  pendingAddr = null;
  derivingFor = null;
  $("add-confirm").hidden = true;
  $("cf-words").innerHTML = "";
  $("cf-verify").checked = false;
  updateAddBtn();
  if (explanation) $("add-msg").textContent = explanation;
}

function onAddrInput() {
  var hadPin = pendingAddr !== null || derivingFor !== null || !$("add-confirm").hidden;
  var wasDeriving = derivingFor !== null;
  voidPending(hadPin
    ? (wasDeriving
      ? "Address changed while its checkphrase was still deriving — that result will be discarded. Validate the new address to see its own words."
      : "Address changed — the checkphrase confirmation was cleared. Validate the new address to see its own words.")
    : "");
  if (!hadPin) $("add-msg").textContent = "";
}

function onValidate() {
  var v = validateQuantusAddress($("in-addr").value);
  if (!v.ok) { toast(v.message, "err"); return; }
  if (vault.addresses.some(function (e) { return e.address === v.address; })) {
    toast("That address is already in the vault.", "err"); return;
  }
  var mySeq = ++validateSeq;
  pendingAddr = v.address;
  derivingFor = v.address;
  $("add-msg").textContent = "";
  derivePhrase(v.address).then(function (w) {
    if (mySeq !== validateSeq) return; // superseded or voided — never render
    derivingFor = null;
    var now = validateQuantusAddress($("in-addr").value);
    if (!now.ok || now.address !== v.address || pendingAddr !== v.address) {
      voidPending("Address changed while its checkphrase was deriving — the result was discarded. Validate the address in the box to see its own words.");
      return;
    }
    $("add-confirm").hidden = false;
    $("cf-words").innerHTML = w
      ? w.map(function (x) { return '<span class="pw big">' + esc(x) + "</span>"; }).join("")
      : '<span class="muted">checkphrase unavailable — you can still add by checksum.</span>';
    $("cf-verify").checked = false;
    updateAddBtn();
  });
}

function updateAddBtn() {
  $("btn-add-confirm").disabled = !(pendingAddr && $("cf-verify").checked);
}

function onAddConfirm() {
  if (!pendingAddr) return;
  var now = validateQuantusAddress($("in-addr").value);
  if (!now.ok || now.address !== pendingAddr) {
    voidPending("Address changed since its checkphrase was shown — the confirmation was cleared. Validate the address in the box to see its own words.");
    return;
  }
  try {
    QPORT.addToVault(vault, pendingAddr, $("in-nick").value);
  } catch (e) { toast(e.message, "err"); return; }
  saveVault();
  $("in-addr").value = ""; $("in-nick").value = "";
  $("add-confirm").hidden = true;
  $("cf-words").innerHTML = "";
  $("cf-verify").checked = false;
  pendingAddr = null;
  derivingFor = null;
  validateSeq++;
  toast("Address added. Refreshing balances…", "ok");
  refreshAll();
}

/* ---------- actions ---------- */

function refreshOne(addr) {
  toast("Refreshing " + QPORT.shortAddr(addr) + "…");
  liveBalanceQuery([addr]).then(function (d) {
    var row = d && d.a0;
    if (row && row.id) {
      chain.liveBalances.set(row.id, { free: row.free, reserved: row.reserved, frozen: row.frozen });
      chain.mode = "live";
      chain.liveAt = new Date().toISOString();
      renderAll();
      toast("Refreshed — live balance loaded.", "ok");
    } else {
      toast("No account row on-chain yet (zero/never-funded). Snapshot says: " +
        (chain.snapBalances.has(addr) ? QPORT.formatQtc(BigInt(chain.snapBalances.get(addr).free)) + " QTC" : "unknown") + ".", "err");
    }
  }).catch(function () { toast("Live refresh failed (indexer unreachable or CORS). Showing snapshot.", "err"); });
}

function refreshAll() {
  $("btn-refresh").disabled = true;
  $("desk-msg").textContent = "Loading chain data…";
  loadChainData().then(function () {
    renderAll();
    toast(chain.mode === "live" ? "Live balances loaded for all vault addresses." : "Indexer unreachable — showing snapshot data. Balances may lag.", chain.mode === "live" ? "ok" : "err");
  }).catch(function (e) {
    toast("Failed to load chain data: " + (e && e.message ? e.message : e), "err");
  }).then(function () { $("btn-refresh").disabled = false; });
}

function exportCsv() {
  var pf = QPORT.rollupPortfolio(vault, ctxForRollup(), Date.now());
  var csv = QPORT.csvExport(pf);
  var blob = new Blob([csv], { type: "text/csv" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "qtc-portfolio-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportJson() {
  var blob = new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "qtc-portfolio-vault.json";
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function importJson(file) {
  var rd = new FileReader();
  rd.onload = function () {
    try {
      var v = QPORT.parseVaultJson(String(rd.result));
      // validate every address before accepting
      v.addresses.forEach(function (e) {
        var r = validateQuantusAddress(e.address);
        if (!r.ok) throw new Error("bad address in file: " + QPORT.shortAddr(e.address));
      });
      vault = v;
      saveVault();
      toast("Imported " + v.addresses.length + " addresses. Refreshing…", "ok");
      refreshAll();
    } catch (e) { toast("Import failed: " + e.message, "err"); }
  };
  rd.readAsText(file);
}

/* ---------- events ---------- */

function bindEvents() {
  $("in-addr").addEventListener("input", onAddrInput);
  $("btn-validate").addEventListener("click", onValidate);
  $("cf-verify").addEventListener("change", updateAddBtn);
  $("btn-add-confirm").addEventListener("click", onAddConfirm);
  $("btn-refresh").addEventListener("click", refreshAll);
  $("btn-export-csv").addEventListener("click", exportCsv);
  $("btn-export-json").addEventListener("click", exportJson);
  $("btn-import").addEventListener("click", function () { $("file-import").click(); });
  $("file-import").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  $("btn-clear").addEventListener("click", function () {
    if (!vault.addresses.length) return;
    if (!confirm("Remove all " + vault.addresses.length + " addresses from the vault? This only clears this browser.")) return;
    vault = QPORT.blankVault();
    saveVault();
    renderAll();
    toast("Vault cleared.", "ok");
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-act]");
    if (!b) return;
    var addr = b.getAttribute("data-addr");
    var act = b.getAttribute("data-act");
    if (act === "copy") { copyText(addr); toast("Address copied.", "ok"); }
    else if (act === "remove") {
      QPORT.removeFromVault(vault, addr);
      saveVault(); renderAll();
      toast("Address removed from vault.", "ok");
    }
    else if (act === "refresh") refreshOne(addr);
    else if (act === "show-phrase") {
      revealPhrases[addr] = true;
      renderAll();
      derivePhrase(addr).then(function () { renderAll(); });
    }
    else if (act === "hide-phrase") { revealPhrases[addr] = false; renderAll(); }
  });
  window.addEventListener("resize", function () {
    var pf = QPORT.rollupPortfolio(vault, ctxForRollup(), Date.now());
    renderDonut(pf);
  });
}

/* ---------- boot ---------- */

loadVault();
bindEvents();
renderAll();          // instant paint from vault
refreshAll();         // then live-first chain data

})();
