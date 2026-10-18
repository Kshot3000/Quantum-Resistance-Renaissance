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

/* Endpoint length bound BEFORE trim/parse (white-hat): validateEndpoint
 * used to trim and WHATWG-parse the WHOLE endpoint paste with no length
 * consulted — a 20,000,006-char paste parsed in ~94–126 ms in Node and
 * was ACCEPTED as valid, so the normalized 20M-char URL was handed to
 * the WebSocket constructor and stored as the connected URL. The cap
 * derives from the largest genuine endpoint: a fully-qualified hostname
 * is at most 253 chars (RFC 1035), and scheme + port + a path/query
 * carrying hosted-RPC key material stays well under 500 chars total —
 * MAX_ENDPOINT_URL_CHARS = 2,048 is >4x that (and the interoperable URL
 * length every browser/server stack accepts). endpointUrlRoom is the
 * pure fail-closed gate, mirroring paramsJsonRoom below. */
export const MAX_ENDPOINT_URL_CHARS = 2048;
export function endpointUrlRoom(chars) {
  if (!Number.isSafeInteger(chars) || chars < 0) return 0;
  return Math.max(0, MAX_ENDPOINT_URL_CHARS - chars);
}

export function validateEndpoint(raw) {
  if (typeof raw === 'string' && raw.length > MAX_ENDPOINT_URL_CHARS) {
    return { ok: false, error: 'Endpoint URL too long (' + raw.length + ' characters) — the cap is ' + MAX_ENDPOINT_URL_CHARS + ' characters; refused before parsing' };
  }
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

/* Params-paste length gate: parseParamsJson used to JSON.parse the
 * WHOLE custom-params paste before any length was consulted — the
 * parsed params then flow into the node request, the history store
 * and a re-stringify, so a 20,000,004-char paste paid a full parse
 * (57.9–170.3 ms in Node) plus the downstream copies, all for params
 * no RPC call can use. The cap derives from the largest legitimate
 * params JSON: a signed 1,000-leg batch_all extrinsic carried as one
 * author_submitExtrinsic string param measures ~98,540 chars
 * (Extrinsic Lab Batch 162: 49,266 bytes = 98,532 hex chars), so
 * MAX_PARAMS_JSON_CHARS = 1,048,576 — the fleet cap for the largest
 * chain object (Extrinsic Lab / Notary Desk hex gates) — is >10x
 * that, and no legitimate input changes outcome. paramsJsonRoom is
 * the pure fail-closed gate (a non-integer, negative, or non-number
 * count gets no room), mirroring the fleet hexInputRoom bounds. */
export const MAX_PARAMS_JSON_CHARS = 1048576;
export function paramsJsonRoom(chars) {
  if (!Number.isSafeInteger(chars) || chars < 0) return 0;
  return Math.max(0, MAX_PARAMS_JSON_CHARS - chars);
}

export function parseParamsJson(text) {
  if (typeof text === 'string' && text.length > MAX_PARAMS_JSON_CHARS) {
    return { ok: false, error: 'Params JSON too long (' + text.length + ' characters) — the cap is ' + MAX_PARAMS_JSON_CHARS + ' characters; refused before parsing' };
  }
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

/* ---------- RPC result validation ----------
 * Everything a node returns is untrusted input: a broken, malicious, or
 * simply non-Quantus endpoint can answer any method with any JSON shape.
 * The summarizers below validate before they summarize — a core field
 * (a block number, a balance, a peer count) that fails validation drops
 * the whole summary (the raw JSON still shows; no figure is invented),
 * while a display-only field (a header's hash, a peer's best hash) is
 * nulled to a dash so its row survives. */

/* Block heights / counts / versions arrive as JSON integers or as hex
 * strings ("0x162e"); anything else (floats, negatives, objects, prose)
 * is not a number the console may present as chain fact. */
export function parseBlockNumber(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(t) || /^[0-9]+$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

/* A 32-byte hash is exactly 0x + 64 hex digits — "not-a-hash", a short
 * hex string, or an object is not a hash, whatever the node claims. */
export function isHash32(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

/* Round 2 — RELATIONS, not just shapes. A block HEIGHT is a block number
 * that could name a block on this chain: the fleet bound is 10,000,000
 * (the chain is at ~204k; a "height" of 99,999,999,999 or 2^53-1 is not
 * a future block, it is a broken or hostile answer). Height 0 IS valid
 * here — over RPC the genesis header/block legitimately sit at 0, unlike
 * the indexer payloads where the fleet's 1..10,000,000 rule applies. */
export const MAX_CHAIN_HEIGHT = 10000000;
export function validChainHeight(v) {
  const n = parseBlockNumber(v);
  return n !== null && n <= MAX_CHAIN_HEIGHT ? n : null;
}

/* An extrinsic is Bytes: even-length 0x hex, at least 1 byte. A block
 * entry of any other shape ("garbage", "0xzz", odd-length hex) is a
 * malformed entry, not an extrinsic — it must not inflate the count or
 * the byte total with length/2 arithmetic on prose. */
export function validExtrinsicHex(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 4;
}

/* A planck amount field is a non-negative integer, as a JSON integer or
 * a pure-digit string; anything else renders as a dash, never String(x). */
export function validPlanckField(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return v.trim();
  return null;
}

/* ---------- result summarizers (one per recipe) ---------- */

export function summarizeHeader(h) {
  if (!h || typeof h !== 'object') return null;
  const number = validChainHeight(h.number);
  if (number === null) return null; // the height is the identity of a header — no valid height, no summary
  const hashField = (v) => (isHash32(v) ? v : null); // display-only: dash a bad hash, keep the block
  return { number, hash: hashField(h.hash), parentHash: hashField(h.parentHash), stateRoot: hashField(h.stateRoot), extrinsicsRoot: hashField(h.extrinsicsRoot) };
}

export function summarizeBlock(block) {
  if (!block || typeof block !== 'object' || !block.header || typeof block.header !== 'object') return null;
  const number = validChainHeight(block.header.number);
  if (number === null) return null;
  if (block.extrinsics !== undefined && !Array.isArray(block.extrinsics)) return null;
  const extrinsics = (block.extrinsics || []).filter(validExtrinsicHex);
  return {
    number,
    hash: isHash32(block.header.hash) ? block.header.hash : null,
    extrinsicCount: extrinsics.length,
    totalBytes: extrinsics.reduce((a, x) => a + x.length / 2 - 1, 0),
  };
}

export function summarizePeers(peers) {
  if (!Array.isArray(peers)) return null;
  const rows = [];
  const seen = new Set();
  for (const p of peers) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.peerId !== 'string' || !p.peerId) continue;   // a row without a usable identity is dropped
    if (seen.has(p.peerId)) continue;                          // one entry per peer — a duplicated identity is one peer, not two
    const bestNumber = validChainHeight(p.bestNumber);
    if (bestNumber === null) continue;                          // its "best block" is the row's fact — garbage/absurd drops the row
    seen.add(p.peerId);
    rows.push({
      peerId: p.peerId,
      roles: typeof p.roles === 'string' ? p.roles : null,
      bestNumber,
      bestHash: isHash32(p.bestHash) ? shortHex(p.bestHash) : null, // display-only: dashed, not fatal
    });
  }
  return rows;
}

/* system_syncState is a relation, not three independent numbers:
 * startingBlock is where this sync session began, currentBlock is the
 * node's head, highestBlock is the highest head it knows of — so
 * starting <= current <= highest BY CONSTRUCTION. An answer that breaks
 * the order (current ABOVE highest painted "synced" pre-fix, because
 * the gap went negative) is malformed wholesale: no gap may be derived
 * from it in either direction. */
export function summarizeSyncState(r) {
  if (!r || typeof r !== 'object') return null;
  const startingBlock = validChainHeight(r.startingBlock);
  const currentBlock = validChainHeight(r.currentBlock);
  const highestBlock = validChainHeight(r.highestBlock);
  if (startingBlock === null || currentBlock === null || highestBlock === null) return null;
  if (!(startingBlock <= currentBlock && currentBlock <= highestBlock)) return null;
  return { startingBlock, currentBlock, highestBlock, gap: highestBlock - currentBlock };
}

export function summarizeHealth(h) {
  if (!h || typeof h !== 'object') return null;
  const peers = parseBlockNumber(h.peers);
  if (peers === null) return null;
  // Strict === true: a truthy string like "false" must not read as syncing.
  return { isSyncing: h.isSyncing === true, peers, shouldHavePeers: h.shouldHavePeers === true };
}

export function summarizeRuntimeVersion(rv) {
  if (!rv || typeof rv !== 'object') return null;
  if (typeof rv.specName !== 'string' || !rv.specName) return null;
  const specVersion = parseBlockNumber(rv.specVersion);
  if (specVersion === null) return null; // spec name+version are the summary's identity
  const ver = (v) => parseBlockNumber(v);
  return {
    specName: rv.specName,
    implName: typeof rv.implName === 'string' && rv.implName ? rv.implName : null,
    specVersion,
    implVersion: ver(rv.implVersion),
    transactionVersion: ver(rv.transactionVersion),
    stateVersion: ver(rv.stateVersion),
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

/* The history is persisted state with more than one possible writer
 * (this app, an older build, a hand edit, an extension), so storage is
 * an untrusted boundary — the same standard the fleet applies to every
 * localStorage load. The old loader returned the parsed array as-is:
 * a null entry crashed renderHistory at h.ok and blanked the panel, a
 * garbage ms painted "NaN ms", and — worst — paramsPreview is only a
 * DISPLAY string while re-run executes params: a stored entry whose
 * preview read "[]" could carry author_submitExtrinsic params, and one
 * click on re-run broadcast a signed extrinsic with none of the gated
 * recipe path's review + acknowledgement. sanitizeHistory therefore:
 * plain objects only; method a bounded string in the charset real
 * entries use (RPC names plus the one composite 'system_* (×5)');
 * ms a finite non-negative number (else the entry drops — it is a
 * core displayed field); ok strictly boolean; error present only on
 * failures, capped; t normalized to 0 when not a finite positive time;
 * params kept only as an array whose JSON fits the SAME 8192-char cap
 * historyEntry enforces, anything else demoted to null
 * (non-rerunnable, never truncated); broadcast methods
 * (author_submitExtrinsic / author_submitAndWatchExtrinsic) ALWAYS
 * demoted to null — a broadcast may only ever leave via the gated
 * review, never a one-click history re-run; and paramsPreview — a
 * DERIVED field — recomputed from the kept params, never trusted
 * from storage (null-params entries show '(params not stored)'). */
export const HISTORY_CAP = 200;
export const BROADCAST_METHODS = ['author_submitExtrinsic', 'author_submitAndWatchExtrinsic'];

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    if (typeof h.method !== 'string' || h.method.length < 1 || h.method.length > 80) continue;
    if (!/^[A-Za-z0-9_ *()×]+$/.test(h.method)) continue;
    if (typeof h.ms !== 'number' || !Number.isFinite(h.ms) || h.ms < 0) continue;
    const ok = h.ok === true;
    let params = null;
    if (Array.isArray(h.params) && !BROADCAST_METHODS.includes(h.method)) {
      try { if (JSON.stringify(h.params).length <= 8192) params = h.params; } catch { params = null; }
    }
    out.push({
      t: (typeof h.t === 'number' && Number.isFinite(h.t) && h.t > 0) ? Math.floor(h.t) : 0,
      method: h.method,
      params,
      paramsPreview: params ? shortHex(JSON.stringify(params), 40) : '(params not stored)',
      ms: Math.round(h.ms),
      ok,
      error: ok ? null : (typeof h.error === 'string' && h.error ? h.error.slice(0, 200) : 'failed'),
    });
    if (out.length >= HISTORY_CAP) break;
  }
  return out;
}

export function loadHistory(store) {
  let parsed = null;
  try { parsed = JSON.parse(store.getItem('qtc-console-history') || '[]'); } catch { return []; }
  const clean = sanitizeHistory(parsed);
  if (JSON.stringify(clean) !== JSON.stringify(parsed)) {
    try { saveHistory(store, clean); } catch { /* store full/blocked — render the clean copy anyway */ }
  }
  return clean;
}

export function saveHistory(store, arr) {
  try { store.setItem('qtc-console-history', JSON.stringify(arr.slice(0, 200))); } catch {}
}

export { PLANCKS_PER_QTC, EXISTENTIAL_DEPOSIT };
