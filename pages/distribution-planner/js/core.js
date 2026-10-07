/* QTC Distribution Planner — pure planning logic (no DOM).
 *
 * Plans `quantus batch send` runs: parses recipient lists, validates every
 * SS58 address (real checksum, prefix 189), converts QTC amounts to plancks
 * with exact BigInt math, splits recipients into utility.batch_all batches,
 * estimates the length-fee floor from the runtime polynomial, and generates
 * the exact CLI-format batch files plus a run script.
 *
 * Sourced facts:
 *  - Batch file format: [{"to":"<SS58>","amount":"<plancks>"}] with amounts as
 *    raw smallest-unit integer strings — quantus-cli src/cli/send.rs
 *    (load_transfers_from_file). Batches execute via utility.batch_all (atomic:
 *    all transfers succeed or the whole batch fails — asserted by the CLI's own
 *    unit test batch_transfer_call_uses_atomic_batch_all).
 *  - Safe batch limit = Utility::batched_calls_limit / 2; the Quantus team's
 *    airdrop pay example plans "up to 256 transfer(s) each" (quantus-cli
 *    README, Sept 30 2026). Default 256 here; confirm live with
 *    `quantus batch config --limits`.
 *  - Length fee: 100,000 plancks/byte (runtime LengthToFee polynomial — same
 *    constant the Fee & Throughput Lab verified against the chain runtime).
 *  - Signature sizes: ML-DSA-65 = 3,309 B, ML-DSA-87 = 4,627 B (FIPS 204;
 *    cross-checked with the Key Forge's vendored noble implementation).
 *  - 1 QTC = 10^12 plancks (chain UNIT constant; dev-hub converter).
 *
 * The fee figure is the LENGTH-FEE FLOOR only: it excludes the weight-based
 * fee component and any tip, which the CLI quotes exactly before submission.
 * This planner never submits anything — it produces files for you to run.
 *
 * Environment-agnostic: browser global DistCore, Node module.exports.
 */
(function (global) {
"use strict";

var PLANCKS_PER_QTC = BigInt("1000000000000"); // 10^12
var LENGTH_FEE_PER_BYTE = 100000;              // plancks/byte (runtime polynomial)
var QUANTUS_PREFIX = 189;
var DEFAULT_BATCH_SIZE = 256;                  // from the CLI team's airdrop example
var SIG_BYTES = { "ml-dsa-65": 3309, "ml-dsa-87": 4627 };

/* ---------- amount parsing: exact decimal -> plancks ---------- */
function parseAmountToPlancks(str) {
  var s = String(str == null ? "" : str).trim().replace(/,/g, "");
  if (!s) return { ok: false, error: "empty amount" };
  if (!/^\d+(\.\d+)?$/.test(s))
    return { ok: false, error: "not a positive decimal number" };
  var parts = s.split(".");
  var whole = parts[0].replace(/^0+(?=\d)/, "");
  var frac = parts[1] || "";
  if (frac.length > 12)
    return { ok: false, error: "more than 12 decimal places (QTC has 12)" };
  if (/^0*$/.test(whole) && /^0*$/.test(frac))
    return { ok: false, error: "amount is zero" };
  frac = (frac + "000000000000").slice(0, 12);
  var plancks = BigInt(whole === "" ? "0" : whole) * PLANCKS_PER_QTC + BigInt(frac);
  if (plancks <= BigInt(0)) return { ok: false, error: "amount is zero" };
  return { ok: true, plancks: plancks };
}

/* ---------- SCALE compact length for a u128 value ---------- */
function compactLenU128(v) {
  // v: BigInt >= 0
  if (v < BigInt(64)) return 1;                    // 0b00 single byte
  if (v < BigInt(16384)) return 2;                 // 0b01 two bytes
  if (v < BigInt(1073741824)) return 4;           // 0b10 four bytes
  var bytes = 0, t = v;
  while (t > BigInt(0)) { bytes++; t = t >> BigInt(8); }
  return 1 + bytes;                               // 0b11 big-int mode
}

/* ---------- recipient list parsing ----------
 * Accepts, per line: "<address> <amount>", "<address>,<amount>",
 * "<address>\t<amount>", or a CSV with a header row containing
 * "address" and "amount". Blank lines and "#" comments are skipped. */
function parseInput(text) {
  var rows = [];
  var lines = String(text == null ? "" : text).split(/\r?\n/);
  var headerSeen = false;
  for (var i = 0; i < lines.length; i++) {
    var ln = i + 1;
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    var parts;
    if (line.indexOf(",") >= 0) parts = line.split(",").map(function (x) { return x.trim(); });
    else parts = line.split(/\s+/);
    parts = parts.filter(function (x) { return x !== ""; });
    if (!headerSeen && parts.length >= 2 &&
        /address/i.test(parts[0]) && /amount/i.test(parts[1])) {
      headerSeen = true;
      continue;
    }
    if (parts.length < 2) {
      rows.push({ line: ln, raw: lines[i], address: parts[0] || "", amountStr: "",
                  error: "expected \"<address> <amount>\" (got " + parts.length + " field(s))" });
      continue;
    }
    rows.push({ line: ln, raw: lines[i], address: parts[0], amountStr: parts[1], error: null });
  }
  return rows;
}

/* ---------- address validation ---------- */
function validateAddress(addr, ss58) {
  if (!addr) return { ok: false, error: "missing address" };
  var d = ss58.ss58Decode(addr);
  if (!d.ok) return { ok: false, error: d.error };
  if (d.key.length !== 32)
    return { ok: false, error: "decoded to " + d.key.length + " bytes — not a 32-byte account ID" };
  if (d.prefix !== QUANTUS_PREFIX)
    return { ok: false, prefix: d.prefix,
             error: "wrong network prefix " + d.prefix + " — Quantus mainnet uses " + QUANTUS_PREFIX +
                    " (addresses start with \"qz\")" };
  return { ok: true, prefix: d.prefix };
}

/* ---------- full row validation ---------- */
function validateRows(rows, ss58, checkphrase, wordlist) {
  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var v = { line: r.line, raw: r.raw, address: r.address, amountStr: r.amountStr,
              ok: false, warnings: [], error: null, plancks: null, checkphrase: null };
    if (r.error) { v.error = r.error; out.push(v); continue; }
    var a = validateAddress(r.address, ss58);
    if (!a.ok) { v.error = a.error; out.push(v); continue; }
    var m = parseAmountToPlancks(r.amountStr);
    if (!m.ok) { v.error = m.error; out.push(v); continue; }
    v.plancks = m.plancks;
    v.ok = true;
    try {
      v.checkphrase = checkphrase.addressToChecksum(r.address, wordlist).join("-");
    } catch (e) { v.checkphrase = null; }
    if (m.plancks < BigInt(1000000))
      v.warnings.push("dust amount (< 0.000001 QTC) — double-check the recipient");
    if (seen[r.address]) {
      v.warnings.push("duplicate of line " + seen[r.address] + " — the CLI would pay this address twice");
    } else {
      seen[r.address] = r.line;
    }
    out.push(v);
  }
  return out;
}

/* ---------- checkphrase words from a 7-byte PBKDF2 key ----------
 * Same mapping as upstream qp-human-checkphrase: first 55 bits of the
 * big-endian key, split into five 11-bit indices into the 2048-word list.
 * Lets callers derive the key however is fastest (WebCrypto PBKDF2 in the
 * browser) and still get byte-identical phrases to the reference impl. */
function wordsFromKey(keyBytes, wordlist) {
  if (!wordlist || wordlist.length !== 2048) throw new Error("wordlist must have 2048 entries");
  var keyInt = BigInt(0), i;
  for (i = 0; i < 7 && i < keyBytes.length; i++) {
    keyInt = (keyInt << BigInt(8)) | BigInt(keyBytes[i]);
  }
  keyInt = keyInt >> BigInt((8 * 7) % 11); // keep only the first 55 bits
  var words = [];
  for (i = 0; i < 5; i++) {
    var shift = BigInt((5 - 1 - i) * 11);
    words.push(wordlist[Number((keyInt >> shift) & BigInt(0x7ff))]);
  }
  return words;
}
function planBatches(validRows, batchSize) {
  var n = Math.max(1, Math.floor(batchSize) || DEFAULT_BATCH_SIZE);
  var batches = [];
  for (var i = 0; i < validRows.length; i += n) {
    var slice = validRows.slice(i, i + n);
    var total = slice.reduce(function (acc, r) { return acc + r.plancks; }, BigInt(0));
    batches.push({ index: batches.length + 1, rows: slice, totalPlancks: total });
  }
  return batches;
}

/* ---------- length-fee floor estimate ----------
 * Per transfer call (balances.transferKeepAlive):
 *   1 (pallet idx) + 1 (call idx) + 33 (MultiAddress::Id) + compact(value)
 * batch_all wrapper: 1 + 1 + compact(batch length)
 * Signed-extrinsic overhead: 1 (signature version) + sig bytes + 33 (signer id)
 *   + 16 (extensions estimate: era/nonce/tip/check — stated assumption)
 * Fee floor = bytes * 100,000 plancks. Weight fee + tip NOT included. */
var EXTENSIONS_ESTIMATE_BYTES = 16;
function estimateBatchFee(batch, scheme) {
  var sigBytes = SIG_BYTES[scheme] || SIG_BYTES["ml-dsa-65"];
  var callBytes = 0;
  for (var i = 0; i < batch.rows.length; i++) {
    callBytes += 1 + 1 + 33 + compactLenU128(batch.rows[i].plancks);
  }
  var wrapperBytes = 1 + 1 + compactLenU128(BigInt(batch.rows.length));
  var overheadBytes = 1 + sigBytes + 33 + EXTENSIONS_ESTIMATE_BYTES;
  var totalBytes = overheadBytes + wrapperBytes + callBytes;
  var feePlancks = BigInt(totalBytes) * BigInt(LENGTH_FEE_PER_BYTE);
  return {
    scheme: scheme,
    sigBytes: sigBytes,
    overheadBytes: overheadBytes,
    wrapperBytes: wrapperBytes,
    callBytes: callBytes,
    totalBytes: totalBytes,
    feePlancks: feePlancks,
    perTransferAvgBytes: batch.rows.length ? callBytes / batch.rows.length : 0
  };
}

/* ---------- export generation ---------- */
function buildBatchJson(batch) {
  var entries = batch.rows.map(function (r) {
    return { to: r.address, amount: r.plancks.toString() };
  });
  return JSON.stringify(entries, null, 2) + "\n";
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildRunScript(batches, fromWallet, tipQTC) {
  var from = (fromWallet || "my_wallet").trim() || "my_wallet";
  var tip = (tipQTC || "").trim();
  var tipFlag = tip ? " --tip " + shellQuote(tip) : "";
  var L = [];
  L.push("#!/usr/bin/env bash");
  L.push("# QTC Distribution Planner — generated run script (Quantum Resistance Renaissance).");
  L.push("# Executes " + batches.length + " batch_all extrinsic(s) via `quantus batch send`.");
  L.push("# Atomic per batch: every transfer in a batch succeeds, or the whole batch fails.");
  L.push("# Review every file below before running. Never paste a wallet password on the");
  L.push("# command line — the CLI reads it from a hidden prompt or --password-file.");
  L.push("set -euo pipefail");
  L.push("");
  L.push("# 0) Sanity: confirm the chain's live batch limits match this plan");
  L.push("quantus batch config --limits");
  L.push("");
  L.push("# 1) Recommended: pay the FIRST batch alone, verify it on the explorer,");
  L.push("#    then run the rest. If a batch fails after submission, check the chain");
  L.push("#    before re-running — a timed-out submission may still have landed,");
  L.push("#    and re-running would pay twice.");
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    var qtc = formatQTC(b.totalPlancks);
    L.push("");
    L.push("# Batch " + b.index + "/" + batches.length + ": " + b.rows.length +
           " transfer(s), " + qtc + " QTC to recipients");
    L.push("quantus batch send --from " + shellQuote(from) +
           " --batch-file transfers-batch-" + b.index + ".json" + tipFlag);
  }
  L.push("");
  return L.join("\n");
}

/* ---------- formatting ---------- */
function formatQTC(plancks) {
  var neg = plancks < BigInt(0);
  var p = neg ? -plancks : plancks;
  var whole = (p / PLANCKS_PER_QTC).toString();
  var frac = (p % PLANCKS_PER_QTC).toString().padStart(12, "0").replace(/0+$/, "");
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

function formatQTC6(plancks) {
  var neg = plancks < BigInt(0);
  var p = neg ? -plancks : plancks;
  var scaled = (p * BigInt(1000000)) / PLANCKS_PER_QTC; // micro-QTC, truncated
  var whole = (scaled / BigInt(1000000)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  var frac = (scaled % BigInt(1000000)).toString().padStart(6, "0");
  return (neg ? "-" : "") + whole + "." + frac;
}

function summarize(validated) {
  var valid = validated.filter(function (v) { return v.ok; });
  var invalid = validated.filter(function (v) { return !v.ok; });
  var warned = validated.filter(function (v) { return v.ok && v.warnings.length; });
  var total = valid.reduce(function (a, v) { return a + v.plancks; }, BigInt(0));
  return { total: validated.length, valid: valid.length, invalid: invalid.length,
           warned: warned.length, totalPlancks: total, validRows: valid };
}

var api = {
  PLANCKS_PER_QTC: PLANCKS_PER_QTC,
  LENGTH_FEE_PER_BYTE: LENGTH_FEE_PER_BYTE,
  QUANTUS_PREFIX: QUANTUS_PREFIX,
  DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,
  SIG_BYTES: SIG_BYTES,
  EXTENSIONS_ESTIMATE_BYTES: EXTENSIONS_ESTIMATE_BYTES,
  parseAmountToPlancks: parseAmountToPlancks,
  compactLenU128: compactLenU128,
  parseInput: parseInput,
  validateAddress: validateAddress,
  validateRows: validateRows,
  planBatches: planBatches,
  estimateBatchFee: estimateBatchFee,
  buildBatchJson: buildBatchJson,
  buildRunScript: buildRunScript,
  formatQTC: formatQTC,
  formatQTC6: formatQTC6,
  wordsFromKey: wordsFromKey,
  summarize: summarize
};

global.DistCore = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }

})(typeof globalThis !== "undefined" ? globalThis : this);
