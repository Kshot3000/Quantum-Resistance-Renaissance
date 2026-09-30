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
  var qtc = Number(planck) / 1e12;
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

function isWsUrl(s) {
  if (typeof s !== "string") return false;
  return /^wss?:\/\/[^/\s]+(\/\S*)?$/.test(s.trim());
}

function normalizeEndpoint(s) {
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

/* ---------- txWatch notifications ---------- */

var HEX_RE = /^0x[0-9a-fA-F]+$/;

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
  return {
    txHash: raw.tx_hash,
    from: typeof raw.from === "string" ? raw.from : "",
    amountPlanck: BigInt(raw.amount),
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
  if (!queryInfoResult || typeof queryInfoResult.partialFee === "undefined") {
    throw new Error("no partialFee in queryInfo result");
  }
  return BigInt(String(queryInfoResult.partialFee));
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
  checkAddress: checkAddress,
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
