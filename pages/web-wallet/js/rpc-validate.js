/* QTC Web Wallet — RPC answer validators.
 * The node is an untrusted boundary: every answer it returns is validated
 * here before rpc.js lets it anchor a balance render, a signing payload
 * (spec/tx version, genesis hash, era-birth hash, nonce), a fee quote, or
 * a broadcast confirmation. A malformed answer is an honest error, never
 * a coerced figure: no NaN nonces signed into payloads, no fractional
 * spec versions truncated by u32le, no negative fee quotes, and a submit
 * answer that is not a 32-byte hash is an UNCONFIRMED broadcast — never a
 * tx hash presented to the user. Pure functions, unit-tested in
 * tests/run-tests.mjs. */

/* A block height arrives as a JSON integer, a decimal string, or a 0x-hex
 * string — anything else (floats, objects, "garbage", "0xZZ") is not a
 * height and must never render as one (or as NaN). */
export function parseBlockNumber(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) ? n : null; }
    if (/^0x[0-9a-fA-F]+$/.test(v)) { const h = parseInt(v, 16); return Number.isSafeInteger(h) ? h : null; }
  }
  return null;
}

/* A 32-byte hash is exactly 0x + 64 hex digits — "not-a-hash", a short
 * hex string, or an object is not a hash, whatever the node claims. */
export function isHash32(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/* A runtime version field (specVersion / transactionVersion) is a u32:
 * an integer in [0, 2^32). A float would be silently truncated by the
 * payload's u32le encoding and a negative would wrap — both must be
 * rejected before they are signed over. */
export function parseVersionNumber(v) {
  const n = parseBlockNumber(v);
  return n !== null && n <= 0xffffffff ? n : null;
}

/* system_accountNextIndex is a u32 nonce. Number("abc") is NaN and
 * Number(-1) is a wrap waiting to happen — neither may reach a payload. */
export function parseNonce(v) {
  return parseVersionNumber(v);
}

/* A fee field from payment_queryFeeDetails is a non-negative integer in
 * plancks: a digit string, a 0x-hex string, a safe-integer number, or a
 * BigInt. BigInt(String(x)) alone is a coercion, not a validation — it
 * happily converts "-5" into a negative fee quote — so the shape is
 * whitelisted here first. Returns a BigInt or null. */
export function parseFeeField(v) {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return BigInt(v);
    if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  }
  return null;
}

/* A state_getStorage answer is Bytes: 0x-prefixed, even-length hex with
 * at least one byte. Anything else is not storage data. */
export function validStorageHex(s) {
  return typeof s === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(s);
}
