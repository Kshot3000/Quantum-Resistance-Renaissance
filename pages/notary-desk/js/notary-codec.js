/* QTC Notary Desk — notary-codec.js
 * Pure timestamping logic for the Quantus on-chain notary. No DOM.
 *
 * Every chain fact below was verified 2026-10-01 against a fresh
 * Quantus-Network/chain clone @ 482c5b9 (main):
 *  - System = pallet 0 (runtime/src/lib.rs `pub type System = frame_system`)
 *  - remark = call index 0, remark_with_event = call index 7, both take
 *    `remark: Vec<u8>` — pallets/frame-system/src/lib.rs
 *    #[pallet::call_index(0)] / #[pallet::call_index(7)]
 *  - remark_with_event deposits System.Remarked { sender: AccountId, hash: Hash }
 *    with hash = BlakeTwo256(remark bytes)
 *    (runtime/src/configs/mod.rs: `type Hashing = BlakeTwo256`)
 *  - Event enum has no explicit indices, so declaration order rules:
 *    ExtrinsicSuccess=0, ExtrinsicFailed=1, CodeUpdated=2, NewAccount=3,
 *    KilledAccount=4, Remarked=5
 *  - Length fee = 100,000 plancks/byte
 *    (LENGTH_FEE_MULTIPLIER=1_000_000 x FEE_SCALE 1/10, runtime/src/configs/mod.rs)
 *  - UNIT = 10^12 plancks (runtime/src/lib.rs); ED = 0.001 QTC
 *  - Signed-extrinsic signature section (extrinsic-lab, verified against real
 *    on-chain extrinsics): variant byte 0x00=ML-DSA-87 [4627B sig || 2592B pub],
 *    0x01=ML-DSA-65 [3309B sig || 1952B pub]
 *  - SS58 prefix 189; checksum = blake2b-512("SS58PRE" || body)[0..2]
 *    (Substrate sp-core ss58hash uses a 64-byte Blake2b — verified by
 *    reproducing a real upstream genesis-vesting address byte-for-byte)
 *  - System.Events storage key = twox_128("System") ++ twox_128("Events");
 *    twox_128("System") = 26aa394eea5630e07c48ae0c9558cef7 (scale-lab, cross-checked
 *    with @polkadot/util-crypto)
 *
 * Hashing primitives (sha256, blake2b, twox_128) are injected so this file stays
 * dependency-free and unit-testable in node.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.QNOT_CODEC = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- Verified chain constants ---------------- */
  var UNIT = 1000000000000n;          // plancks per QTC
  var LENGTH_FEE_PER_BYTE = 100000n;  // plancks per extrinsic byte
  var PALLET_SYSTEM = 0;
  var CALL_REMARK = 0;
  var CALL_REMARK_WITH_EVENT = 7;
  var EVENT_REMARKED = 5;             // System event variant index
  var SS58_PREFIX = 189;
  var EXISTENTIAL_DEPOSIT_QTC = "0.001";

  // Signed-extrinsic signature section, verified against real chain data
  // (extrinsic-lab decoder, 14/14 tests on live extrinsics).
  var SIG_SCHEMES = {
    "mldsa65": { label: "ML-DSA-65", variant: 0x01, sig: 3309, pub: 1952 },
    "mldsa87": { label: "ML-DSA-87", variant: 0x00, sig: 4627, pub: 2592 }
  };

  /* ---------------- Notary envelope v1 ----------------
   * magic "QNOT/1" (6B) | algo (1B: 0x01=SHA-256, 0x02=BLAKE2b-256)
   * | digest (32B) | label: compact<u32> len + UTF-8 (0..64B)
   */
  var ENVELOPE_MAGIC = [0x51, 0x4E, 0x4F, 0x54, 0x2F, 0x31]; // "QNOT/1"
  var ALGOS = { 1: "SHA-256", 2: "BLAKE2b-256" };
  var MAX_LABEL_BYTES = 64;
  var MAX_MESSAGE_BYTES = 4096; // raw message mode cap (keeps fees sane)

  /* ---------------- Byte helpers ---------------- */
  function hexToBytes(h) {
    h = String(h).replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) return null;
    var out = new Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += ("0" + (b[i] & 0xff).toString(16)).slice(-2);
    return s;
  }
  function utf8ToBytes(s) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(s));
    // node fallback without TextEncoder (very old); tests run on modern node.
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  function bytesToUtf8(b) {
    try {
      var u8 = new Uint8Array(b);
      if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: true }).decode(u8);
      return null;
    } catch (e) { return null; }
  }
  // SCALE compact for u32-range values.
  function compactU32(n) {
    n = n >>> 0;
    if (n < 64) return [n << 2];
    if (n < 16384) { var v = (n << 2) | 1; return [v & 0xff, (v >> 8) & 0xff]; }
    if (n < 1073741824) {
      var w = (n << 2) | 2;
      return [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff];
    }
    throw new Error("compact: value too large for u32 range");
  }
  function readCompact(bytes, o) {
    if (o >= bytes.length) return null;
    var b0 = bytes[o], mode = b0 & 3, v, len;
    if (mode === 0) return { value: b0 >> 2, next: o + 1 };
    if (mode === 1) {
      if (o + 1 >= bytes.length) return null;
      return { value: (b0 >> 2) | (bytes[o + 1] << 6), next: o + 2 };
    }
    if (mode === 2) {
      if (o + 3 >= bytes.length) return null;
      v = (b0 >> 2) | (bytes[o + 1] << 6) | (bytes[o + 2] << 14) | (bytes[o + 3] << 22);
      return { value: v >>> 0, next: o + 4 };
    }
    len = b0 >> 2;
    if (len > 4 || o + len >= bytes.length) return null;
    v = 0;
    for (var i = 0; i < len; i++) v |= bytes[o + 1 + i] << (8 * i);
    return { value: v >>> 0, next: o + 1 + len };
  }

  /* ---------------- Envelope ---------------- */
  function buildEnvelope(algoId, digestBytes, label) {
    if (ALGOS[algoId] === undefined) return { ok: false, error: "unknown algo id" };
    if (!digestBytes || digestBytes.length !== 32)
      return { ok: false, error: "digest must be exactly 32 bytes" };
    var labelBytes = utf8ToBytes(label || "");
    if (labelBytes.length > MAX_LABEL_BYTES)
      return { ok: false, error: "label exceeds " + MAX_LABEL_BYTES + " bytes" };
    var out = ENVELOPE_MAGIC.concat([algoId])
      .concat(Array.from(digestBytes))
      .concat(compactU32(labelBytes.length))
      .concat(labelBytes);
    return { ok: true, bytes: out, hex: bytesToHex(out) };
  }

  // Parse remark bytes back: envelope | utf8 message | raw.
  function parseRemark(bytes) {
    var isEnvelope = bytes.length >= 6 + 1 + 32 + 1;
    if (isEnvelope) {
      var magicOk = true;
      for (var i = 0; i < 6; i++) if (bytes[i] !== ENVELOPE_MAGIC[i]) { magicOk = false; break; }
      if (magicOk) {
        var algoId = bytes[6];
        var digest = bytes.slice(7, 39);
        var rc = readCompact(bytes, 39);
        if (rc && ALGOS[algoId] && rc.next + rc.value === bytes.length) {
          var labelBytes = bytes.slice(rc.next, rc.next + rc.value);
          var label = bytesToUtf8(labelBytes);
          if (label !== null)
            return { kind: "envelope", algoId: algoId, algo: ALGOS[algoId],
                     digestHex: bytesToHex(digest), label: label };
        }
      }
    }
    var text = bytesToUtf8(bytes);
    if (text !== null) return { kind: "message", text: text };
    return { kind: "raw", hex: bytesToHex(bytes) };
  }

  /* ---------------- Unsigned call ----------------
   * System.remark_with_event: 00 07 <compact len> <bytes>
   * System.remark:            00 00 <compact len> <bytes>
   */
  function buildRemarkCall(remarkBytes, withEvent) {
    if (!remarkBytes || remarkBytes.length === 0)
      return { ok: false, error: "remark payload is empty" };
    var callIdx = withEvent ? CALL_REMARK_WITH_EVENT : CALL_REMARK;
    var call = [PALLET_SYSTEM, callIdx]
      .concat(compactU32(remarkBytes.length))
      .concat(Array.from(remarkBytes));
    return {
      ok: true, withEvent: !!withEvent,
      pallet: PALLET_SYSTEM, call: callIdx,
      callHex: bytesToHex(call), callLen: call.length
    };
  }

  /* ---------------- Fees ----------------
   * Length fee is exact on the final signed bytes: ceil(bytes) x 100,000 plancks.
   * Signed layout: compact(len) | 0x84 | MultiAddress::Id(0x00+32B)
   *   | sigSection(1B variant + sig + pub) | era(2B mortal) | nonce(compact)
   *   | tip(compact) | call...
   */
  function signedLengthEstimate(callLen, schemeKey, nonce) {
    var scheme = SIG_SCHEMES[schemeKey || "mldsa65"];
    if (!scheme) return { ok: false, error: "unknown signature scheme" };
    nonce = (nonce === undefined || nonce === null) ? 0 : nonce;
    // compactU32() wraps via >>>0, so an out-of-u32 nonce would silently
    // encode as a DIFFERENT nonce and the fee/length quote would describe
    // an extrinsic the user did not ask for; and at >= 2^30 compactU32
    // throws outright (its big-integer mode is unimplemented). Reject
    // both cases cleanly instead of wrapping or throwing.
    if (!Number.isSafeInteger(callLen) || callLen < 0)
      return { ok: false, error: "call length must be a non-negative integer" };
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > 1073741823)
      return { ok: false, error: "nonce must be a u32 integer the compact encoder can represent (0..1073741823)" };
    var nonceBytes = compactU32(nonce);
    var bodyLen = 1 + (1 + 32) + (1 + scheme.sig + scheme.pub) + 2 + nonceBytes.length + 1 + callLen;
    var lenPrefix = bodyLen < 64 ? 1 : bodyLen < 16384 ? 2 : 4;
    var total = lenPrefix + bodyLen;
    var feePlancks = BigInt(total) * LENGTH_FEE_PER_BYTE;
    return {
      ok: true, scheme: scheme.label,
      totalBytes: total, lenPrefixBytes: lenPrefix, bodyBytes: bodyLen,
      sigSectionBytes: 1 + scheme.sig + scheme.pub,
      feePlancks: feePlancks,
      feeQTC: formatQTC(feePlancks)
    };
  }
  function formatQTC(plancks) {
    var neg = plancks < 0n;
    var v = neg ? -plancks : plancks;
    var int = v / UNIT, frac = v % UNIT;
    var fs = frac.toString().padStart(12, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + int.toString() + (fs ? "." + fs : "");
  }

  /* ---------------- System.Events decoding ----------------
   * Vec<EventRecord>: compact len, then per record:
   *   phase: 0x00 ApplyExtrinsic + u32 LE | 0x01 Finalization | 0x02 Initialization
   *   event: pallet u8, variant u8, fields...
   *   topics: compact len + 32B each
   * We extract System.Remarked (pallet 0, variant 5): sender[32], hash[32].
   * Unknown phases/variants are skipped safely; malformed tails abort.
   */
  function decodeSystemEvents(bytes) {
    var out = { ok: false, records: [], error: null };
    var rc = readCompact(bytes, 0);
    if (!rc) { out.error = "bad compact length on event vector"; return out; }
    var o = rc.next, count = rc.value, i, r;
    for (i = 0; i < count; i++) {
      if (o >= bytes.length) { out.error = "truncated at record " + i; return out; }
      var phase = bytes[o++];
      var phaseInfo = null;
      if (phase === 0) {
        if (o + 4 > bytes.length) { out.error = "truncated phase"; return out; }
        phaseInfo = { kind: "ApplyExtrinsic",
          index: bytes[o] | (bytes[o+1] << 8) | (bytes[o+2] << 16) | (bytes[o+3] << 24) };
        o += 4;
      } else if (phase === 1) phaseInfo = { kind: "Finalization" };
      else if (phase === 2) phaseInfo = { kind: "Initialization" };
      else { out.error = "unknown phase byte " + phase; return out; }
      if (o + 2 > bytes.length) { out.error = "truncated event header"; return out; }
      var pallet = bytes[o++], variant = bytes[o++];
      r = { phase: phaseInfo, pallet: pallet, variant: variant,
            senderHex: null, hashHex: null, skipped: true };
      if (pallet === PALLET_SYSTEM && variant === EVENT_REMARKED) {
        if (o + 64 > bytes.length) { out.error = "truncated Remarked fields"; return out; }
        r.senderHex = bytesToHex(bytes.slice(o, o + 32));
        r.hashHex = bytesToHex(bytes.slice(o + 32, o + 64));
        r.skipped = false;
        o += 64;
      } else {
        // Unknown event shape: we cannot safely skip without metadata.
        out.error = "unsupported event shape pallet=" + pallet + " variant=" + variant +
                    " at record " + i + " (metadata-less skip is unsafe)";
        return out;
      }
      var tc = readCompact(bytes, o);
      if (!tc) { out.error = "truncated topics"; return out; }
      o = tc.next;
      if (o + tc.value * 32 > bytes.length) { out.error = "truncated topic bytes"; return out; }
      o += tc.value * 32;
      out.records.push(r);
    }
    out.ok = true;
    return out;
  }

  /* ---------------- Untrusted-boundary validators ----------------
   * The node (Remark Board) and localStorage (anchor vault) are both
   * untrusted boundaries: every answer/entry is validated here BEFORE it
   * anchors a board row, a scan verdict, a live claim, or a verify
   * result. A malformed value is dropped or an honest error — never a
   * coerced figure: no parseInt NaN heights rendered as "#NaN", no
   * garbage envelope hashed into a fake "expected event hash", no
   * markup-bearing fee string reaching the vault's innerHTML.
   */
  // A block height arrives as a 0x-hex string (JSON-RPC headers), a
  // decimal string, or a JSON integer — anything else is not a height.
  function parseBlockNumber(v) {
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
    if (typeof v === "string") {
      if (/^\d+$/.test(v)) { var n = Number(v); return Number.isSafeInteger(n) ? n : null; }
      if (/^0x[0-9a-fA-F]+$/.test(v)) { var h = parseInt(v, 16); return Number.isSafeInteger(h) ? h : null; }
    }
    return null;
  }
  // A 32-byte hash is exactly 0x + 64 hex digits.
  function isHash32(s) {
    return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
  }
  // A subscription id is a non-empty string or a non-negative integer.
  function validSubscriptionId(v) {
    return (typeof v === "string" && v.length > 0 && v.length <= 128) ||
           (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  }

  /* Sanitize a parsed localStorage vault: returns a NEW array holding
   * only anchors whose every rendered/verified field checks out, with
   * fields normalized (lowercase hex, block annotation coerced to a
   * digit string or null). Classification per field:
   *  - core (drop the anchor): mode, created (must parse), feeQTC (a
   *    plain non-negative decimal — it reaches innerHTML), callHex
   *    (even hex encoding a System remark/remark_with_event call whose
   *    index matches withEvent), label (string or null);
   *  - document anchors additionally: digestHex (64 hex), algo (a known
   *    ALGOS name), envelopeHex (must parse back to an envelope whose
   *    digest, algo AND label all match the stored fields — a garbage
   *    envelope must never be hashed into a verify "expected hash");
   *  - message anchors: digest/algo/envelope must all be null;
   *  - absent-but-recoverable: a block annotation that is not a plain
   *    block number coerces to null (the anchor itself is still real).
   */
  function sanitizeVault(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var a = raw[i];
      if (!a || typeof a !== "object" || Array.isArray(a)) continue;
      if (a.mode !== "document" && a.mode !== "message") continue;
      if (typeof a.created !== "string" || !isFinite(Date.parse(a.created))) continue;
      if (typeof a.feeQTC !== "string" || !/^\d+(\.\d+)?$/.test(a.feeQTC)) continue;
      if (typeof a.withEvent !== "boolean") continue;
      if (a.label !== null && a.label !== undefined && typeof a.label !== "string") continue;
      if (typeof a.callHex !== "string" || !/^[0-9a-fA-F]+$/.test(a.callHex) ||
          a.callHex.length % 2 !== 0) continue;
      var callBytes = hexToBytes(a.callHex);
      if (!callBytes || callBytes.length < 4) continue;
      if (callBytes[0] !== PALLET_SYSTEM ||
          (callBytes[1] !== CALL_REMARK && callBytes[1] !== CALL_REMARK_WITH_EVENT)) continue;
      if ((callBytes[1] === CALL_REMARK_WITH_EVENT) !== a.withEvent) continue;
      var digestHex = null, algo = null, envelopeHex = null;
      if (a.mode === "document") {
        if (typeof a.digestHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(a.digestHex)) continue;
        digestHex = a.digestHex.toLowerCase();
        if (a.algo !== ALGOS[1] && a.algo !== ALGOS[2]) continue;
        algo = a.algo;
        if (typeof a.envelopeHex !== "string") continue;
        var envBytes = hexToBytes(a.envelopeHex);
        if (!envBytes) continue;
        var parsed = parseRemark(envBytes);
        if (parsed.kind !== "envelope") continue;
        if (parsed.digestHex !== digestHex || parsed.algo !== algo) continue;
        if (parsed.label !== (a.label || "")) continue;
        envelopeHex = a.envelopeHex.toLowerCase();
      } else {
        if (a.digestHex !== null || a.algo !== null || a.envelopeHex !== null) continue;
      }
      var block = null;
      if (typeof a.block === "string" && /^\d+$/.test(a.block)) block = a.block;
      out.push({
        id: (typeof a.id === "string" && a.id) ? a.id : "n-sanitized-" + out.length,
        created: a.created, mode: a.mode, algo: algo, digestHex: digestHex,
        label: (typeof a.label === "string" && a.label) ? a.label : null,
        envelopeHex: envelopeHex, callHex: a.callHex.toLowerCase(),
        withEvent: a.withEvent, feeQTC: a.feeQTC, block: block
      });
    }
    return out;
  }

  /* ---------------- SS58 (prefix 189) ----------------
   * Needs a 64-byte-output BLAKE2b hasher injected: blake2b512(bytes) -> 64-byte array.
   * (Substrate's ss58hash uses Blake2b::new(64); digest length is part of the
   * parameter block, so blake2b-256 would give a different checksum.)
   */
  var B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58encode(bytes) {
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    var digits = [0], i, j;
    for (i = zeros; i < bytes.length; i++) {
      var carry = bytes[i];
      for (j = 0; j < digits.length; j++) {
        carry += digits[j] * 256;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var s = "", k;
    for (i = 0; i < zeros; i++) s += "1";
    for (k = digits.length - 1; k >= 0; k--) s += B58_ALPHABET[digits[k]];
    return s;
  }
  function ss58Encode32(keyBytes, blake2b512) {
    if (!keyBytes || keyBytes.length !== 32) return null;
    var prefix = SS58_PREFIX; // 189 > 64: two-byte prefix form
    var pb = [((prefix & 0xfc) >>> 2) | 0x40, (prefix >>> 8) | ((prefix & 0x03) << 6)];
    var body = pb.concat(Array.from(keyBytes));
    var hash = blake2b512(utf8ToBytes("SS58PRE").concat(body));
    return b58encode(body.concat([hash[0], hash[1]]));
  }

  /* ---------------- Storage keys ----------------
   * System.Events key = twox_128("System") ++ twox_128("Events").
   * twox_128 injected (vendored, verified core).
   */
  function systemEventsKey(twox128) {
    var a = twox128(utf8ToBytes("System"));
    var b = twox128(utf8ToBytes("Events"));
    return "0x" + bytesToHex(a.concat(b));
  }

  return {
    UNIT: UNIT, LENGTH_FEE_PER_BYTE: LENGTH_FEE_PER_BYTE,
    PALLET_SYSTEM: PALLET_SYSTEM, CALL_REMARK: CALL_REMARK,
    CALL_REMARK_WITH_EVENT: CALL_REMARK_WITH_EVENT, EVENT_REMARKED: EVENT_REMARKED,
    SS58_PREFIX: SS58_PREFIX, EXISTENTIAL_DEPOSIT_QTC: EXISTENTIAL_DEPOSIT_QTC,
    SIG_SCHEMES: SIG_SCHEMES, ALGOS: ALGOS, MAX_LABEL_BYTES: MAX_LABEL_BYTES,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    hexToBytes: hexToBytes, bytesToHex: bytesToHex,
    utf8ToBytes: utf8ToBytes, bytesToUtf8: bytesToUtf8,
    compactU32: compactU32, readCompact: readCompact,
    buildEnvelope: buildEnvelope, parseRemark: parseRemark,
    buildRemarkCall: buildRemarkCall,
    signedLengthEstimate: signedLengthEstimate, formatQTC: formatQTC,
    decodeSystemEvents: decodeSystemEvents,
    parseBlockNumber: parseBlockNumber, isHash32: isHash32,
    validSubscriptionId: validSubscriptionId, sanitizeVault: sanitizeVault,
    ss58Encode32: ss58Encode32, systemEventsKey: systemEventsKey
  };
}));
