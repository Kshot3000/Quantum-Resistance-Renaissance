/* QTC Extrinsic Lab — RPC answer validators.
 * The node is an untrusted boundary: every answer it returns is validated
 * here before app.js writes it into the Verify context (the anchor a
 * signature verdict stands on) or presents it as chain fact in the Live
 * scanner. A malformed answer is an honest error, never a coerced figure:
 * no "[object Object]" genesis hashes, no "#NaN" finalized blocks, and a
 * block whose extrinsics field is not a list is malformed — never a fake
 * EMPTY block. Pure functions, no DOM, unit-tested in tests/run-tests.mjs. */
(function (global) {
"use strict";

/* A block height arrives as a JSON integer, a decimal string, or a 0x-hex
 * string — anything else (floats, objects, "garbage", "0xZZ") is not a
 * height and must never render as one (or as NaN). */
function parseBlockNumber(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) { var n = Number(v); return Number.isSafeInteger(n) ? n : null; }
    if (/^0x[0-9a-fA-F]+$/.test(v)) { var h = parseInt(v, 16); return Number.isSafeInteger(h) ? h : null; }
  }
  return null;
}

/* A 32-byte hash is exactly 0x + 64 hex digits — "not-a-hash", a short
 * hex string, or an object is not a hash, whatever the node claims. */
function isHash32(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/* A runtime version field (specVersion / transactionVersion) is a u32:
 * a JSON safe integer, a decimal string, or a 0x-hex string WITHIN the
 * u32 range. Anything else — an object String()'d into "[object Object]",
 * a float, a negative, or 2^32 and above — is not a version and must
 * never anchor a verdict: buildSigningPayload packs versions with
 * u32le, so an out-of-range value would wrap silently and the verdict
 * would stand on a different version than the one displayed. */
var MAX_U32 = 4294967295;
function parseVersionNumber(v) {
  var n = parseBlockNumber(v);
  return n !== null && n <= MAX_U32 ? n : null;
}

/* A chain HEIGHT is a block number that could name a block on this
 * chain: the fleet bound is 10,000,000 (the chain is at ~204k; a
 * "height" of 99,999,999,999 or 2^53-1 is not a future block, it is a
 * broken or hostile answer). Height 0 IS valid here — over RPC the
 * genesis header/block legitimately sit at 0, unlike the indexer
 * payloads where the fleet's 1..10,000,000 rule applies. Mirrors
 * chain-console core.js validChainHeight exactly. */
var MAX_CHAIN_HEIGHT = 10000000;
function validChainHeight(v) {
  var n = parseBlockNumber(v);
  return n !== null && n <= MAX_CHAIN_HEIGHT ? n : null;
}

/* An extrinsic is Bytes: even-length 0x hex, at least 1 byte. A block
 * entry of any other shape is a malformed entry, not an extrinsic. */
function validExtrinsicHex(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 4;
}

var api = {
  parseBlockNumber: parseBlockNumber,
  isHash32: isHash32,
  parseVersionNumber: parseVersionNumber,
  validChainHeight: validChainHeight,
  validExtrinsicHex: validExtrinsicHex,
  MAX_CHAIN_HEIGHT: MAX_CHAIN_HEIGHT,
  MAX_U32: MAX_U32,
};
global.QEL_RPC = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
