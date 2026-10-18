/* QTC Mempool Desk — core logic (pure, no DOM).
 *
 * Plan: JSON-RPC message builders, planck<->QTC math, txWatch notification
 * parsing, pool statistics, fee ordering, reconnect backoff, and pool
 * staleness classification.
 *
 * Environment-agnostic: browser global QMEMCORE, Node module.exports.
 */
(function (global) {
"use strict";

var PLANCK_PER_QTC = 1000000000000n; // 1e12, per upstream docs (1 UNIT = 10^12 planck)
var EXPECTED_SS58_PREFIX = 189;     // Quantus, per node/src/chain_spec.rs
var MAX_PENDING_LISTED = 200;       // UI listing cap; stats always cover the full pool
var MAX_SUPPLY_PLANCKS = 21000000n * PLANCK_PER_QTC; // 21M QTC hard cap (fleet constant)
var MAX_CHAIN_HEIGHT = 10000000;    // fleet bound on a plausible height
var SS58_189_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/; // strict shape: qz + 47 base58

/* ---------- planck <-> QTC ---------- */

function parseQtcToPlancks(str) {
  // Accepts "1", "1.5", "0.000001", "1,234.5". Returns BigInt plancks. Throws on garbage.
  if (typeof str !== "string") throw new Error("amount must be a string");
  var s = str.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error("invalid QTC amount: " + str);
  var parts = s.split(".");
  var whole = BigInt(parts[0]);
  var frac = parts.length > 1 ? parts[1] : "";
  while (frac.length < 12) frac += "0";
  return whole * PLANCK_PER_QTC + BigInt(frac);
}

function formatQtc(planck) {
  // BigInt plancks -> "1,234.5678" (trims trailing zeros, no exponentials).
  var p = typeof planck === "bigint" ? planck : BigInt(String(planck));
  if (p === 0n) return "0";
  var neg = p < 0n;
  if (neg) p = -p;
  var whole = p / PLANCK_PER_QTC;
  var frac = p % PLANCK_PER_QTC;
  var wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac === 0n) return (neg ? "-" : "") + wholeStr;
  var fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + wholeStr + "." + fracStr;
}

function formatCompact(planck) {
  // Short display for feeds: "1.5K QTC", "2.3M QTC", "450 QTC".
  var p;
  try { p = typeof planck === "bigint" ? planck : BigInt(String(planck)); } catch (e) { return "—"; }
  if (p < 0n) return "—";
  var qtc = Number(p) / 1e12;
  if (!isFinite(qtc)) return "—";
  var abs = Math.abs(qtc);
  var v, unit;
  if (abs >= 1e6) { v = qtc / 1e6; unit = "M"; }
  else if (abs >= 1e3) { v = qtc / 1e3; unit = "K"; }
  else { v = qtc; unit = ""; }
  var str = Math.abs(v) >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return str + unit + " QTC";
}

/* ---------- JSON-RPC builders ---------- */

var _rpcId = 1;

function nextId() { return _rpcId++; }
function resetId() { _rpcId = 1; }

function buildRpc(method, params) {
  if (typeof method !== "string" || !method) throw new Error("method must be a non-empty string");
  return { jsonrpc: "2.0", id: nextId(), method: method, params: params === undefined ? [] : params };
}

function buildTxWatchSubscribe(address) {
  return buildRpc("txWatch_watchAddress", [address]);
}
function buildTxWatchUnsubscribe(subscriptionId) {
  return buildRpc("txWatch_unwatchAddress", [subscriptionId]);
}
function buildPendingExtrinsics() {
  return buildRpc("author_pendingExtrinsics", []);
}
function buildPaymentQueryInfo(extrinsicHex, atHash) {
  var params = [extrinsicHex];
  if (atHash) params.push(atHash);
  return buildRpc("payment_queryInfo", params);
}
function buildNewHeadsSubscribe() {
  return buildRpc("chain_subscribeNewHeads", []);
}
function buildHandshake() {
  return [
    buildRpc("system_chain", []),
    buildRpc("system_version", []),
    buildRpc("chain_getHeader", []),
  ];
}

/* ---------- endpoint ---------- */

/* Endpoint length bound BEFORE the shape regex (white-hat): isWsUrl
 * regex-tested the WHOLE endpoint paste with no length consulted, and
 * the accepted value is persisted to localStorage and handed to
 * `new WebSocket` — a 20,000,000-char paste was regex-scanned, stored
 * (quota throw at best) and socket-attempted. The cap derives from the
 * largest genuine endpoint: a fully-qualified hostname is at most 253
 * chars (RFC 1035), and scheme + port + a path/query carrying
 * hosted-RPC key material stays well under 500 chars total —
 * MAX_ENDPOINT_URL_CHARS = 2,048 is >4x that (and the interoperable
 * URL length every browser/server stack accepts). The length check
 * runs on the raw string before trim/regex, and normalizeEndpoint
 * names the cap when length is the failure. */
var MAX_ENDPOINT_URL_CHARS = 2048;

function isWsUrl(s) {
  if (typeof s !== "string") return false;
  if (s.length > MAX_ENDPOINT_URL_CHARS) return false;
  return /^wss?:\/\/[^/\s]+(\/\S*)?$/.test(s.trim());
}

function normalizeEndpoint(s) {
  if (typeof s === "string" && s.length > MAX_ENDPOINT_URL_CHARS) {
    throw new Error("endpoint URL too long (" + s.length + " characters) — the cap is " + MAX_ENDPOINT_URL_CHARS + " characters; refused before connecting");
  }
  if (!isWsUrl(s)) throw new Error("endpoint must look like ws://host:port or wss://host");
  return s.trim();
}

/* ---------- SS58 ---------- */

function checkAddress(addr, decodeFn) {
  // decodeFn(addr) -> {ok:true, prefix} | {ok:false,...} or throws.
  // Returns {ok, reason}.
  if (typeof addr !== "string" || !addr.trim()) return { ok: false, reason: "empty address" };
  if (typeof decodeFn !== "function") return { ok: false, reason: "no decoder" };
  try {
    var d = decodeFn(addr.trim());
    if (!d || d.ok === false) {
      return { ok: false, reason: (d && d.error) ? d.error : "checksum/decode failed" };
    }
    if (d.prefix !== EXPECTED_SS58_PREFIX) {
      return { ok: false, reason: "SS58 prefix " + d.prefix + " (need " + EXPECTED_SS58_PREFIX + ")" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "checksum/decode failed" };
  }
}

/* ---------- persisted watchers (localStorage is an untrusted boundary) ---------- */

var MAX_WATCHERS = 50;      // each watcher is a live node subscription
var WATCH_LABEL_MAX = 40;   // the add form's own cap, re-enforced at load

/* The add form validates an address with checkAddress (checksum + prefix
 * 189) before a watcher exists, caps the label at 40 chars, and refuses
 * duplicates. The load path must enforce the SAME rules: an entry that
 * bypassed the form (hand-edited storage, an older build, a restored
 * backup) was previously kept on `typeof address === "string"` alone, so
 * a bad-checksum or another chain's address got subscribed and rendered
 * as a watched Quantus address, and duplicates double-subscribed.
 * Keep only plain-object entries whose address passes checkAddress AND
 * the strict SS58-189 shape (49 chars = 32-byte key), dedupe by address,
 * cap the label, and cap the list. Returns [{address, label}]. */
function sanitizeWatchers(raw, decodeFn) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length && out.length < MAX_WATCHERS; i++) {
    var x = raw[i];
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    if (typeof x.address !== "string") continue;
    var addr = x.address.trim();
    if (!SS58_189_RE.test(addr)) continue;
    if (!checkAddress(addr, decodeFn).ok) continue;
    if (seen[addr]) continue;
    seen[addr] = true;
    out.push({ address: addr, label: String(x.label == null ? "" : x.label).slice(0, WATCH_LABEL_MAX) });
  }
  return out;
}

/* Room left under the watcher cap, for CREATION paths: sanitizeWatchers
 * caps the list at load, but addWatcher is the path that actually creates
 * watchers in-session (and each one opens a live txWatch subscription) —
 * a cap that lives only in the load sanitizer let the form grow the list
 * past 50 in-session, with the excess silently trimmed on the next load
 * after the UI had claimed it was added and subscribed. Creation paths
 * ask here first; non-finite counts get no room. */
function watcherRoom(currentCount) {
  var n = Math.floor(Number(currentCount));
  if (!isFinite(n) || n < 0) return 0;
  return Math.max(0, MAX_WATCHERS - n);
}

/* ---------- txWatch notifications ---------- */

var HEX_RE = /^0x[0-9a-fA-F]+$/;

/* ---------- RPC answer validators (the node is an untrusted boundary) ---------- */

function parseBlockNumber(v) {
  // A block height arrives as a JSON integer, a decimal string, or a
  // 0x-hex string — anything else (floats, objects, "garbage", "0xZZ")
  // is not a height and must never render as one (or as NaN).
  // Round 2 (fleet relations): a height is also a chain fact, so it must
  // be one the chain could actually be at — positive (no new head is the
  // genesis block) and under the fleet 10,000,000 ceiling. Round 1 let
  // 99,999,999,999 render as the chain head from a buggy/hostile node.
  var n = null;
  if (typeof v === "number") { if (Number.isSafeInteger(v)) n = v; }
  else if (typeof v === "string") {
    if (/^\d+$/.test(v)) { var d = Number(v); if (Number.isSafeInteger(d)) n = d; }
    else if (/^0x[0-9a-fA-F]+$/.test(v)) { var h = parseInt(v, 16); if (Number.isSafeInteger(h)) n = h; }
  }
  return n !== null && n > 0 && n <= MAX_CHAIN_HEIGHT ? n : null;
}

function isHash32(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

function validSubscriptionId(v) {
  // JSON-RPC subscription ids are strings or integers. Anything else
  // (an object String()'d to "[object Object]") is not a subscription.
  if (typeof v === "string") {
    return v.length > 0 && v.length <= 128 && !/\s/.test(v) ? v : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function validExtrinsicHex(s) {
  // A pool entry is extrinsic Bytes: even-length 0x hex, at least 1 byte.
  return typeof s === "string" && HEX_RE.test(s) && s.length % 2 === 0 && s.length >= 4;
}

function parseTxWatchNotification(raw) {
  // Validates the upstream shape: {tx_hash, from, amount, asset_id}.
  // Returns {txHash, from, amountPlanck:BigInt, assetId|null}. Throws on garbage.
  if (!raw || typeof raw !== "object") throw new Error("notification must be an object");
  if (typeof raw.tx_hash !== "string" || !HEX_RE.test(raw.tx_hash) || raw.tx_hash.length !== 66) {
    throw new Error("bad tx_hash");
  }
  if (typeof raw.amount !== "string" || !/^\d+$/.test(raw.amount)) {
    throw new Error("bad amount (planck integer string expected)");
  }
  var assetId = raw.asset_id === null || raw.asset_id === undefined ? null : raw.asset_id;
  if (assetId !== null && (!Number.isInteger(assetId) || assetId < 0)) {
    throw new Error("bad asset_id");
  }
  // Round 2 (fleet relations): the amount is money, so it must be a
  // transfer that could exist — strictly positive (a 0-planck
  // "transfer" painted in the feed and fired a desktop notification),
  // and for the native asset no larger than the whole 21M QTC supply.
  // Asset amounts are NOT capped here: an asset's supply is not QTC's.
  var amountPlanck = BigInt(raw.amount);
  if (amountPlanck <= 0n) throw new Error("bad amount (zero-planck transfer)");
  if (assetId === null && amountPlanck > MAX_SUPPLY_PLANCKS) {
    throw new Error("bad amount (exceeds the 21M QTC supply cap)");
  }
  // `from` is display-only: keep it only in the strict SS58-189 shape
  // (qz + 47 base58 — fleet standard). Round 1's base58-ish shape kept
  // strings no chain payload can contain (20 a's, a '0'-padded string —
  // 0 is not in the base58 alphabet, another chain's address) and
  // rendered them as the sender. Anything else — markup, punctuation,
  // an object — becomes "" and renders as the honest
  // "unsigned / non-standard" label instead of garbage-as-sender.
  var from = "";
  if (typeof raw.from === "string" && SS58_189_RE.test(raw.from)) from = raw.from;
  return {
    txHash: raw.tx_hash,
    from: from,
    amountPlanck: amountPlanck,
    assetId: assetId,
    receivedAt: Date.now(),
  };
}

function assetLabel(assetId) {
  return assetId === null ? "native QTC" : "asset #" + assetId;
}

/* ---------- pool statistics ---------- */

function hexByteLen(hex) {
  // "0x..." extrinsic -> byte length. Throws on garbage.
  if (typeof hex !== "string" || !HEX_RE.test(hex) || hex.length % 2 !== 0) {
    throw new Error("bad extrinsic hex");
  }
  return (hex.length - 2) / 2;
}

function summarizePool(extrinsics) {
  // extrinsics: array of 0x-hex strings from author_pendingExtrinsics.
  var list = Array.isArray(extrinsics) ? extrinsics : [];
  var sizes = [];
  for (var i = 0; i < list.length; i++) {
    try { sizes.push(hexByteLen(list[i])); } catch (e) { /* skip malformed */ }
  }
  var total = sizes.reduce(function (a, b) { return a + b; }, 0);
  var max = sizes.length ? Math.max.apply(null, sizes) : 0;
  return {
    count: list.length,
    valid: sizes.length,
    totalBytes: total,
    avgBytes: sizes.length ? Math.round(total / sizes.length) : 0,
    maxBytes: max,
    listed: Math.min(list.length, MAX_PENDING_LISTED),
  };
}

function sortPoolByFee(rows) {
  // rows: [{hex, bytes, fee:BigInt|null}]. Fee-known first, biggest fee on top.
  return rows.slice().sort(function (a, b) {
    if (a.fee === null && b.fee === null) return b.bytes - a.bytes;
    if (a.fee === null) return 1;
    if (b.fee === null) return -1;
    if (a.fee !== b.fee) return a.fee > b.fee ? -1 : 1;
    return b.bytes - a.bytes;
  });
}

function decodePartialFee(queryInfoResult) {
  // payment_queryInfo -> {weight:{...}, class:"normal", partialFee:"12345"}.
  // The fee is money: only a non-negative integer (digit string, 0x-hex
  // string, safe-integer number, or BigInt) is a fee. BigInt(String(x))
  // alone would happily convert "-5" into a negative fee and render it
  // as a node quote — reject everything that is not a clean integer.
  if (!queryInfoResult || typeof queryInfoResult !== "object" ||
      typeof queryInfoResult.partialFee === "undefined") {
    throw new Error("no partialFee in queryInfo result");
  }
  var f = queryInfoResult.partialFee;
  if (typeof f === "bigint") {
    if (f < 0n) throw new Error("malformed partialFee in queryInfo result");
    return f;
  }
  if (typeof f === "number") {
    if (!Number.isSafeInteger(f) || f < 0) throw new Error("malformed partialFee in queryInfo result");
    return BigInt(f);
  }
  if (typeof f === "string" && /^\d+$/.test(f)) return BigInt(f);
  if (typeof f === "string" && /^0x[0-9a-fA-F]+$/.test(f)) return BigInt(f);
  throw new Error("malformed partialFee in queryInfo result");
}

/* ---------- timing ---------- */

function formatAge(ms) {
  if (typeof ms !== "number" || ms < 0) return "—";
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function poolHealth(lastPollAt, nowMs) {
  // "live" | "stale" | "dead" for the mempool poll loop.
  if (!lastPollAt) return "dead";
  var gap = nowMs - lastPollAt;
  if (gap < 12000) return "live";
  if (gap < 60000) return "stale";
  return "dead";
}

function backoffMs(attempt) {
  // 1s, 2s, 4s, ... capped at 30s. attempt starts at 0.
  var n = Math.max(0, Math.floor(attempt));
  var ms = 1000 * Math.pow(2, n);
  return Math.min(ms, 30000);
}

/* ---------- display helpers ---------- */

function shorten(s, head, tail) {
  head = head || 10; tail = tail === undefined ? 8 : tail;
  if (typeof s !== "string" || s.length <= head + tail + 3) return s;
  return s.slice(0, head) + "…" + (tail ? s.slice(-tail) : "");
}

function txWatchSupported() {
  // Per upstream chain/docs/rpc_additions/transaction_pool_listener.md.
  return [
    "Balances::transfer_keep_alive / transfer_allow_death (native)",
    "Assets::transfer / transfer_keep_alive (fungible assets)",
    "All of the above inside Utility::batch_all, nested up to 4 levels",
  ];
}

var api = {
  PLANCK_PER_QTC: PLANCK_PER_QTC,
  EXPECTED_SS58_PREFIX: EXPECTED_SS58_PREFIX,
  MAX_PENDING_LISTED: MAX_PENDING_LISTED,
  MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,
  MAX_CHAIN_HEIGHT: MAX_CHAIN_HEIGHT,
  SS58_189_RE: SS58_189_RE,
  parseQtcToPlancks: parseQtcToPlancks,
  formatQtc: formatQtc,
  formatCompact: formatCompact,
  nextId: nextId,
  resetId: resetId,
  buildRpc: buildRpc,
  buildTxWatchSubscribe: buildTxWatchSubscribe,
  buildTxWatchUnsubscribe: buildTxWatchUnsubscribe,
  buildPendingExtrinsics: buildPendingExtrinsics,
  buildPaymentQueryInfo: buildPaymentQueryInfo,
  buildNewHeadsSubscribe: buildNewHeadsSubscribe,
  buildHandshake: buildHandshake,
  isWsUrl: isWsUrl,
  normalizeEndpoint: normalizeEndpoint,
  MAX_ENDPOINT_URL_CHARS: MAX_ENDPOINT_URL_CHARS,
  checkAddress: checkAddress,
  sanitizeWatchers: sanitizeWatchers,
  MAX_WATCHERS: MAX_WATCHERS, watcherRoom: watcherRoom,
  parseBlockNumber: parseBlockNumber,
  isHash32: isHash32,
  validSubscriptionId: validSubscriptionId,
  validExtrinsicHex: validExtrinsicHex,
  parseTxWatchNotification: parseTxWatchNotification,
  assetLabel: assetLabel,
  hexByteLen: hexByteLen,
  summarizePool: summarizePool,
  sortPoolByFee: sortPoolByFee,
  decodePartialFee: decodePartialFee,
  formatAge: formatAge,
  poolHealth: poolHealth,
  backoffMs: backoffMs,
  shorten: shorten,
  txWatchSupported: txWatchSupported,
};

global.QMEMCORE = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof globalThis !== "undefined" ? globalThis : this);
