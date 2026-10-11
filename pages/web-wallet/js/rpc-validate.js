import { ss58Decode } from './quantus-crypto.js';

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

/* ---- Activity (Subsquid indexer) boundary — round 2: RELATIONS ----
 * Round 1 (validActivityRow in app.js) checked each row's shape alone:
 * any string endpoints, any non-negative height, any digit amount. The
 * indexer is an untrusted boundary too — a row is rendered as THIS
 * wallet's money movement, so the row must actually be about this
 * wallet, between real Quantus addresses, at a real height, for an
 * amount the chain can actually hold. The relations below were all
 * verified against live indexer data (top-miner address, 2026-10-11:
 * 25 rows, newest-first, every row involving the queried address,
 * string planck amounts, unique ids, ISO timestamps). */

/* Fleet block-height shape: a strict integer in [1, 10,000,000] — a
 * number, or a canonical decimal string ("007" and "2.5" are not
 * heights, and neither are 0 or 2^53-1). Returns the number or null. */
export function validBlockHeight(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 1 && v <= 10000000 ? v : null;
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 10000000 ? n : null;
  }
  return null;
}

/* No transfer can exceed the chain's hard 21M QTC supply cap. */
export const MAX_SUPPLY_PLANCKS = 21000000000000000000n;
/* The chain's genesis block is 2026-09-09; the fleet floor for any
 * chain timestamp is 2026-09-01 (no real transfer predates it). */
export const GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1);
/* The activity query is limit:25 — a longer list is not that query. */
export const ACTIVITY_LIMIT = 25;

function isQuantusAddress(s) {
  if (typeof s !== "string") return false;
  try {
    const { prefix } = ss58Decode(s);
    return prefix === 189;
  } catch { return false; }
}

function activityAmount(v) {
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const a = BigInt(v);
    return a <= MAX_SUPPLY_PLANCKS ? a : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    const a = BigInt(v);
    return a <= MAX_SUPPLY_PLANCKS ? a : null;
  }
  return null;
}

/* A present timestamp must be a real chain time: parseable, not before
 * the genesis floor, not more than an hour in the future. A missing
 * timestamp is allowed — the row renders by block height instead. */
function activityTimestampOk(v, nowMs) {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= GENESIS_FLOOR_MS && t <= nowMs + 3600000;
}

/* Validate the activity payload's RELATIONS for the wallet that asked.
 * Returns normalized rows (amount as a planck string, height as a
 * number), or null when the payload itself is malformed: not a list,
 * over the limit:25 contract, or not running newest-first (an
 * inversion between otherwise-valid rows means this is not the
 * ordered answer the UI claims to show). An individually poisoned row
 * (stranger transfer, non-SS58 endpoint, absurd height, over-supply
 * amount, impossible timestamp, duplicate id) drops out alone; the
 * caller treats "raw rows existed but none survived" as malformed. */
export function sanitizeActivityRows(raw, address, nowMs = Date.now()) {
  if (!Array.isArray(raw) || raw.length > ACTIVITY_LIMIT) return null;
  const seen = new Set();
  const rows = [];
  for (const t of raw) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    if (typeof t.id !== "string" || !t.id || seen.has(t.id)) continue;
    /* The defining relation: this row must be a transfer OF the
     * queried wallet — a stranger's transfer is not its history. */
    if (t.from_id !== address && t.to_id !== address) continue;
    if (!isQuantusAddress(t.from_id) || !isQuantusAddress(t.to_id)) continue;
    const height = validBlockHeight(t.block_height);
    if (height === null) continue;
    const amount = activityAmount(t.amount);
    if (amount === null) continue;
    if (!activityTimestampOk(t.timestamp, nowMs)) continue;
    if (!(t.extrinsic_id === null || t.extrinsic_id === undefined || typeof t.extrinsic_id === "string")) continue;
    seen.add(t.id);
    rows.push({
      id: t.id, from_id: t.from_id, to_id: t.to_id,
      amount: amount.toString(), block_height: height,
      extrinsic_id: typeof t.extrinsic_id === "string" ? t.extrinsic_id : null,
      timestamp: typeof t.timestamp === "string" ? t.timestamp : null,
    });
  }
  /* Newest-first is the query's contract (order_by block_height desc):
   * kept rows must run non-increasing in height, or the list paints
   * oldest-first under a "Recent transfers" heading. */
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].block_height > rows[i - 1].block_height) return null;
  }
  return rows;
}
