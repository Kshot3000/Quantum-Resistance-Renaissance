/* QTC Chain Console — pure, Node-testable core logic.
 * No DOM, no WebSocket here: request building, validation, formatting,
 * recipe param builders, result summarizers, and the error explainer.
 */
import { ss58Decode, hexEncode, hexDecode } from './lib/quantus-crypto.js';
import { storageKey, SYSTEM_ACCOUNT_KEY } from './lib/xxhash.js';
import { decodeAccountInfo, plancksToQtc, PLANCKS_PER_QTC, EXISTENTIAL_DEPOSIT } from './lib/scale.js';

export const QUANTUS_SS58_PREFIX = 189;
export const MAINNET_RPC = 'wss://rpc.quantus.network';
export const LOCAL_RPC = 'ws://127.0.0.1:9944';

export const ENDPOINT_PRESETS = [
  { label: 'Quantus mainnet (public RPC)', url: MAINNET_RPC, note: 'Rate-limited shared endpoint — be polite.' },
  { label: 'Local node', url: LOCAL_RPC, note: 'Your own quantus-node with --rpc-external or local WS.' },
];

/* ---------- endpoint validation ---------- */

export function validateEndpoint(raw) {
  const url = (raw || '').trim();
  if (!url) return { ok: false, error: 'Enter an endpoint URL.' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'Not a valid URL.' }; }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    return { ok: false, error: 'Endpoint must use ws:// or wss:// — the chain speaks WebSocket JSON-RPC.' };
  }
  return { ok: true, url: u.toString() };
}

/* ---------- JSON-RPC plumbing ---------- */

export function buildRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params: params === undefined ? [] : params });
}

export function parseParamsJson(text) {
  const t = (text || '').trim();
  if (!t) return { ok: true, params: [] };
  try {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) return { ok: false, error: 'Params must be a JSON array.' };
    return { ok: true, params: v };
  } catch (e) {
    return { ok: false, error: 'Invalid JSON: ' + e.message };
  }
}

/* Map JSON-RPC / transport failures to plain English. */
export function explainError(err) {
  const msg = (err && err.message ? err.message : String(err || 'Unknown error')).trim();
  if (/timed out/i.test(msg)) {
    return { title: 'Request timed out', hint: 'The node did not answer in time. Public RPCs throttle heavy calls (state_getMetadata, big storage reads) — retry, or run the call against your own node.' };
  }
  if (/could not reach|connection timed out|connection closed|failed to connect|ECONNREFUSED/i.test(msg)) {
    return { title: 'Could not reach the endpoint', hint: 'Check the URL, make sure the node exposes its WebSocket RPC (quantus-node needs its RPC port open), and that your network allows outbound WebSockets.' };
  }
  const m = msg.match(/-32(\d{3})/);
  if (m) {
    const code = '-32' + m[1];
    const table = {
      '-32700': ['Parse error', 'The node could not parse the request JSON. This is a console bug — report it.'],
      '-32600': ['Invalid request', 'The request object was malformed. Again, likely a console bug — report it.'],
      '-32601': ['Method not found', 'This node does not expose that method. Public RPCs commonly disable author_* and txWatch_* methods — the reference tab marks the usual suspects.'],
      '-32602': ['Invalid params', 'The method exists but the parameters were wrong — check types (hashes are 0x-hex, block numbers are integers, not strings).'],
      '-32603': ['Internal error', 'The node failed while executing the call. Try again; if it repeats, the input may reference state that does not exist (e.g. a storage key for an unknown account).'],
    };
    if (table[code]) return { title: table[code][0], hint: table[code][1] };
  }
  if (/Method not found/i.test(msg)) {
    return { title: 'Method not found', hint: 'This node does not expose that method. Public RPCs commonly disable author_* and txWatch_* methods.' };
  }
  return { title: 'Call failed', hint: msg };
}

/* ---------- hex / formatting helpers ---------- */

export function isHex(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]+$/.test(s.trim());
}

export function normalizeHex(s) {
  const t = (s || '').trim();
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0 && t.length >= 2) return '0x' + t.toLowerCase();
  return t.toLowerCase().startsWith('0x') ? '0x' + t.slice(2).toLowerCase() : t;
}

export function shortHex(hex, keep = 10) {
  if (typeof hex !== 'string' || hex.length <= keep * 2 + 5) return hex;
  return hex.slice(0, keep + 2) + '…' + hex.slice(-keep);
}

export function formatMs(ms) {
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

export function formatNumber(n) {
  try { return Number(n).toLocaleString('en-US'); } catch { return String(n); }
}

/* ---------- address / account ---------- */

export function parseAddressInput(raw) {
  const addr = (raw || '').trim();
  if (!addr) return { ok: false, error: 'Enter an SS58 address.' };
  let decoded;
  try { decoded = ss58Decode(addr); }
  catch (e) { return { ok: false, error: 'Invalid address: ' + e.message }; }
  if (decoded.prefix !== QUANTUS_SS58_PREFIX) {
    return { ok: false, error: `Wrong network prefix ${decoded.prefix} — Quantus mainnet addresses use prefix 189.`, prefix: decoded.prefix };
  }
  return { ok: true, address: addr, accountId: decoded.accountId, prefix: decoded.prefix };
}

export function accountStorageKeyHex(address) {
  const p = parseAddressInput(address);
  if (!p.ok) return p;
  return { ok: true, keyHex: '0x' + hexEncode(SYSTEM_ACCOUNT_KEY(p.accountId)) };
}

export function decodeBalanceStorage(storageHex) {
  if (!isHex(storageHex)) return { ok: false, error: 'Expected 0x-hex storage bytes.' };
  let info;
  try { info = decodeAccountInfo(hexDecode(normalizeHex(storageHex))); }
  catch (e) { return { ok: false, error: 'Could not decode AccountInfo: ' + e.message }; }
  const total = info.free + info.reserved + info.frozen;
  return {
    ok: true,
    free: info.free, reserved: info.reserved, frozen: info.frozen, total,
    freeQtc: plancksToQtc(info.free), reservedQtc: plancksToQtc(info.reserved),
    frozenQtc: plancksToQtc(info.frozen), totalQtc: plancksToQtc(total),
    belowEd: info.free > 0n && info.free < EXISTENTIAL_DEPOSIT,
  };
}

/* Generic map-key builder: Twox128(pallet) ++ Twox128(item) ++ Blake2_128Concat(accountId) */
export function buildMapKeyHex(pallet, item, address) {
  if (!pallet || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pallet.trim())) return { ok: false, error: 'Pallet name must be a valid identifier (e.g. System).' };
  if (!item || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.trim())) return { ok: false, error: 'Storage item must be a valid identifier (e.g. Account).' };
  const p = parseAddressInput(address);
  if (!p.ok) return p;
  return { ok: true, keyHex: '0x' + hexEncode(storageKey(pallet.trim(), item.trim(), p.accountId)) };
}

/* ---------- result summarizers (one per recipe) ---------- */

export function summarizeHeader(h) {
  if (!h || typeof h !== 'object') return null;
  return { number: h.number, hash: h.hash || null, parentHash: h.parentHash, stateRoot: h.stateRoot, extrinsicsRoot: h.extrinsicsRoot };
}

export function summarizeBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const extrinsics = Array.isArray(block.extrinsics) ? block.extrinsics : [];
  return {
    number: block.header ? block.header.number : null,
    hash: block.header ? block.header.hash || null : null,
    extrinsicCount: extrinsics.length,
    totalBytes: extrinsics.reduce((a, x) => a + (typeof x === 'string' ? x.length / 2 - 1 : 0), 0),
  };
}

export function summarizePeers(peers) {
  if (!Array.isArray(peers)) return null;
  return peers.map((p) => ({
    peerId: p.peerId, roles: p.roles,
    bestNumber: p.bestHash ? p.bestNumber : p.bestNumber,
    bestHash: p.bestHash ? shortHex(p.bestHash) : null,
  }));
}

export function summarizeHealth(h) {
  if (!h || typeof h !== 'object') return null;
  return { isSyncing: !!h.isSyncing, peers: h.peers, shouldHavePeers: !!h.shouldHavePeers };
}

export function summarizeRuntimeVersion(rv) {
  if (!rv || typeof rv !== 'object') return null;
  return {
    specName: rv.specName, implName: rv.implName,
    specVersion: rv.specVersion, implVersion: rv.implVersion,
    transactionVersion: rv.transactionVersion, stateVersion: rv.stateVersion,
  };
}

/* ---------- recipe param builders ---------- */

function needHexParam(v, name) {
  const t = (v || '').trim();
  if (!t) return { ok: false, error: `Enter ${name}.` };
  if (!isHex(t) && !/^[0-9a-fA-F]+$/.test(t)) return { ok: false, error: `${name} must be hex (0x…).` };
  return { ok: true, value: normalizeHex(t) };
}

export const RECIPE_BUILDERS = {
  'balance': (f) => {
    const k = accountStorageKeyHex(f.address);
    return k.ok ? { ok: true, params: [k.keyHex] } : k;
  },
  'chain_getHeader': (f) => {
    if (!f.hash || !f.hash.trim()) return { ok: true, params: [] };
    const r = needHexParam(f.hash, 'block hash');
    return r.ok ? { ok: true, params: [r.value] } : r;
  },
  'chain_getBlockHash': (f) => {
    const n = Number((f.number || '').trim());
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: 'Block number must be a non-negative integer.' };
    return { ok: true, params: [n] };
  },
  'chain_getBlock': (f) => {
    const r = needHexParam(f.hash, 'block hash');
    return r.ok ? { ok: true, params: [r.value] } : r;
  },
  'state_getStorage': (f) => {
    const r = needHexParam(f.key, 'storage key');
    if (!r.ok) return r;
    const params = [r.value];
    if (f.atHash && f.atHash.trim()) {
      const h = needHexParam(f.atHash, 'block hash');
      if (!h.ok) return h;
      params.push(h.value);
    }
    return { ok: true, params };
  },
  'system_accountNextIndex': (f) => {
    const p = parseAddressInput(f.address);
    return p.ok ? { ok: true, params: [p.address] } : p;
  },
  'payment_queryInfo': (f) => {
    const r = needHexParam(f.extrinsic, 'extrinsic hex');
    return r.ok ? { ok: true, params: [r.value] } : r;
  },
  'payment_queryFeeDetails': (f) => {
    const r = needHexParam(f.extrinsic, 'extrinsic hex');
    return r.ok ? { ok: true, params: [r.value] } : r;
  },
  'author_submitExtrinsic': (f) => {
    const r = needHexParam(f.extrinsic, 'signed extrinsic hex');
    if (!r.ok) return r;
    if (r.value.length < 2 + 16) return { ok: false, error: 'That hex is far too short to be a signed Quantus extrinsic.' };
    return { ok: true, params: [r.value] };
  },
};

/* ---------- fee formatting ---------- */

/* Exact QTC string for a payment_queryInfo partialFee (planck, string or
 * number from the node). Delegates to the shared scale helper — the app.js
 * summarizer previously hand-rolled this and printed "1." / "0." for
 * whole-QTC and zero fees (its `|| '0'` guard never fired on the truthy
 * "1." string). Missing/garbage input renders as a dash, never a guess. */
export function formatPartialFeeQtc(partialFee) {
  if (partialFee === null || partialFee === undefined || partialFee === '') return '—';
  try { return plancksToQtc(BigInt(partialFee)); } catch { return '—'; }
}

/* ---------- history ---------- */

export function historyEntry(method, params, ms, ok, errorTitle) {
  // Store the full params so the history re-run button can restore the
  // EXACT call — before this, only the method was restored and re-run
  // silently executed with whatever stale params sat in the Custom tab.
  // Cap: multi-KB params (extrinsic/metadata blobs) x 200 entries would
  // blow the localStorage quota; those entries store params === null
  // (marked non-rerunnable) rather than truncated, unparseable JSON.
  let storedParams = null;
  try {
    const arr = Array.isArray(params) ? params : [];
    if (JSON.stringify(arr).length <= 8192) storedParams = arr;
  } catch { storedParams = null; }
  return {
    t: Date.now(), method,
    params: storedParams,
    paramsPreview: shortHex(JSON.stringify(params), 40),
    ms: Math.round(ms), ok: !!ok,
    error: ok ? null : (errorTitle || 'failed'),
  };
}

export function loadHistory(store) {
  try {
    const raw = store.getItem('qtc-console-history');
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.slice(0, 200) : [];
  } catch { return []; }
}

export function saveHistory(store, arr) {
  try { store.setItem('qtc-console-history', JSON.stringify(arr.slice(0, 200))); } catch {}
}

export { PLANCKS_PER_QTC, EXISTENTIAL_DEPOSIT };
