/* QTC Reversal Desk — core logic (browser + node).
 * Every constant below is read from the Quantus-Network/chain source at rev 482c5b9:
 *   pallets/reversible-transfers/src/lib.rs, runtime/src/lib.rs,
 *   runtime/src/configs/mod.rs, primitives/scheduler/src/lib.rs.
 * The call-data encoders reproduce the exact SCALE layout of the pallet calls:
 *   - dest: MultiAddress (Lookup::Source); ::Id = 0x00 || 32 raw bytes
 *   - amount: Balance = u128, NOT compact — plain 16-byte LE (no #[pallet::compact] on the field)
 *   - delay: BlockNumberOrTimestamp enum: 0x00 || u32 LE (blocks) | 0x01 || u64 LE (ms)
 *   - guardian / account / tx_id: raw 32 bytes
 * blake2b + base58 copied from the Address Toolkit (same repo), verified byte-for-byte
 * against Python hashlib/OpenSSL on 2026-09-29.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.ReversalCore = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ================= verified chain constants ================= */
  var C = {
    PALLET_INDEX: 11,          // runtime/src/lib.rs: #[runtime::pallet_index(11)]
    CALL_SET_HIGH_SECURITY: 0,
    CALL_CANCEL: 1,
    CALL_EXECUTE_TRANSFER: 2,  // scheduler origin only
    CALL_SCHEDULE_TRANSFER: 3,
    CALL_SCHEDULE_TRANSFER_WITH_DELAY: 4,
    // call indices 5,6 vacant (asset calls removed)
    CALL_RECOVER_FUNDS: 7,
    MIN_DELAY_BLOCKS: 2,       // configs/mod.rs
    MIN_DELAY_MOMENT_MS: 12000,// MinDelayPeriodMoment = TargetBlockTime
    MAX_PENDING_PER_ACCOUNT: 16,
    HS_QUOTA_TXS: 16,          // MaxHighSecurityTxsPerWindow
    HS_QUOTA_WINDOW_BLOCKS: 7200, // HighSecurityTxWindowBlocks = DAYS
    HS_BATCH_MAX: 16,          // MaxHighSecurityBatchLen
    VOLUME_FEE_PERMILL: 10,    // HighSecurityVolumeFee = Permill::from_percent(1)
    DEFAULT_DELAY_BLOCKS: 7200,// DefaultDelay = DAYS
    BLOCK_MS: 12000,           // TARGET_BLOCK_TIME_MS
    SS58_PREFIX: 189,
    UNIT: 1000000000000n,      // 10^12 planck per QTC
    PALLET_ID: [0x72, 0x74, 0x70, 0x61, 0x6c, 0x6c, 0x65, 0x74], // b"rtpallet"
  };

  /* ================= blake2b (RFC 7693) ================= */
  var SIGMA = [
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
    [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
    [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
    [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],
    [2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
    [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],
    [13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
    [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
    [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]
  ];
  var IV = [
    [0x6a09e667, 0xf3bcc908], [0xbb67ae85, 0x84caa73b],
    [0x3c6ef372, 0xfe94f82b], [0xa54ff53a, 0x5f1d36f1],
    [0x510e527f, 0xade682d1], [0x9b05688c, 0x2b3e6c1f],
    [0x1f83d9ab, 0xfb41bd6b], [0x5be0cd19, 0x137e2179]
  ];
  function add64(a, b) {
    var lo = (a[1] + b[1]) >>> 0;
    var hi = (a[0] + b[0] + (lo < a[1] ? 1 : 0)) >>> 0;
    return [hi, lo];
  }
  function xor64(a, b) { return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0]; }
  function rotr64(w, n) {
    n %= 64;
    if (n === 0) return [w[0], w[1]];
    if (n === 32) return [w[1], w[0]];
    if (n < 32) return [((w[0] >>> n) | (w[1] << (32 - n))) >>> 0,
                       ((w[1] >>> n) | (w[0] << (32 - n))) >>> 0];
    n -= 32;
    return [((w[1] >>> n) | (w[0] << (32 - n))) >>> 0,
            ((w[0] >>> n) | (w[1] << (32 - n))) >>> 0];
  }
  function G(v, a, b, c, d, x, y) {
    v[a] = add64(add64(v[a], v[b]), x);
    v[d] = rotr64(xor64(v[d], v[a]), 32);
    v[c] = add64(v[c], v[d]);
    v[b] = rotr64(xor64(v[b], v[c]), 24);
    v[a] = add64(add64(v[a], v[b]), y);
    v[d] = rotr64(xor64(v[d], v[a]), 16);
    v[c] = add64(v[c], v[d]);
    v[b] = rotr64(xor64(v[b], v[c]), 63);
  }
  function blake2b(input, outLen) {
    outLen = outLen || 64;
    var h = IV.map(function (x) { return [x[0] >>> 0, x[1] >>> 0]; });
    h[0] = xor64(h[0], [0, 0x01010000 ^ outLen]);
    var msg = input, blocks = [], off, i, k;
    for (off = 0; off < msg.length; off += 128) {
      var b = new Array(16);
      for (i = 0; i < 16; i++) {
        var o = off + i * 8, lo = 0, hi = 0;
        for (k = 0; k < 8; k++) {
          var byte = (o + k) < msg.length ? msg[o + k] : 0;
          if (k < 4) lo |= byte << (k * 8); else hi |= byte << ((k - 4) * 8);
        }
        b[i] = [hi >>> 0, lo >>> 0];
      }
      blocks.push({ m: b, last: (off + 128) >= msg.length });
    }
    if (blocks.length === 0) {
      var z = []; for (i = 0; i < 16; i++) z.push([0, 0]);
      blocks.push({ m: z, last: true });
    }
    var t = 0, r;
    blocks.forEach(function (blk, bi) {
      t += blk.last ? (msg.length - bi * 128) : 128;
      var v = h.map(function (x) { return [x[0], x[1]]; })
               .concat(IV.map(function (x) { return [x[0] >>> 0, x[1] >>> 0]; }));
      v[12] = xor64(v[12], [(t / 4294967296) >>> 0, t >>> 0]);
      if (blk.last) v[14] = xor64(v[14], [0xffffffff, 0xffffffff]);
      for (r = 0; r < 12; r++) {
        var s = SIGMA[r % 10];
        G(v, 0, 4,  8, 12, blk.m[s[0]],  blk.m[s[1]]);
        G(v, 1, 5,  9, 13, blk.m[s[2]],  blk.m[s[3]]);
        G(v, 2, 6, 10, 14, blk.m[s[4]],  blk.m[s[5]]);
        G(v, 3, 7, 11, 15, blk.m[s[6]],  blk.m[s[7]]);
        G(v, 0, 5, 10, 15, blk.m[s[8]],  blk.m[s[9]]);
        G(v, 1, 6, 11, 12, blk.m[s[10]], blk.m[s[11]]);
        G(v, 2, 7,  8, 13, blk.m[s[12]], blk.m[s[13]]);
        G(v, 3, 4,  9, 14, blk.m[s[14]], blk.m[s[15]]);
      }
      for (i = 0; i < 8; i++) h[i] = xor64(xor64(h[i], v[i]), v[i + 8]);
    });
    var out = [];
    for (i = 0; i < 8 && out.length < outLen; i++) {
      var w = h[i];
      for (k = 0; k < 4 && out.length < outLen; k++) out.push((w[1] >>> (k * 8)) & 0xff);
      for (k = 0; k < 4 && out.length < outLen; k++) out.push((w[0] >>> (k * 8)) & 0xff);
    }
    return out;
  }

  /* ================= base58 ================= */
  var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58decode(s) {
    for (var ci = 0; ci < s.length; ci++) {
      if (ALPHABET.indexOf(s[ci]) < 0) throw new Error("bad base58 char at " + ci);
    }
    var zeros = 0;
    while (zeros < s.length && s[zeros] === "1") zeros++;
    var bytes = [0], i, j;
    for (i = 0; i < s.length; i++) {
      var carry = ALPHABET.indexOf(s[i]);
      for (j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    var out = [], k;
    for (i = 0; i < zeros; i++) out.push(0);
    for (k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
    while (out.length > zeros && out[zeros] === 0) out.splice(zeros, 1);
    return out;
  }
  function strBytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return out;
  }

  /* ================= SS58 (prefix 189, 32-byte keys) ================= */
  function ss58Decode(addr) {
    var res = { ok: false };
    var raw;
    try {
      raw = b58decode(addr.trim());
    } catch (e) {
      res.error = "Not valid base58 (" + e.message + ").";
      return res;
    }
    if (raw.length < 4) {
      res.error = "Too short (" + raw.length + " bytes) to be an SS58 address.";
      return res;
    }
    // prefix 189 > 63, so it uses the two-byte form: 0b01xxxxxx 0bxxxxxxxx
    var prefixLen = ((raw[0] & 0xc0) === 0x40) ? 2 : 1;
    var prefix = prefixLen === 1 ? raw[0]
      : (((raw[0] & 0x3f) << 2) | (raw[1] >>> 6) | ((raw[1] & 0x3f) << 8));
    var key = raw.slice(prefixLen, raw.length - 2);
    if (prefix !== C.SS58_PREFIX) {
      res.error = "Valid SS58 but prefix " + prefix + " — Quantus mainnet uses 189.";
      res.prefix = prefix;
      return res;
    }
    if (key.length !== 32) {
      res.error = "Valid SS58 with prefix 189 but key length " + key.length + " bytes (expected 32).";
      return res;
    }
    var body = raw.slice(0, raw.length - 2), check = raw.slice(raw.length - 2);
    var hash = blake2b(strBytes("SS58PRE").concat(body));
    if (hash[0] !== check[0] || hash[1] !== check[1]) {
      res.error = "Checksum mismatch — address is mistyped or corrupted.";
      return res;
    }
    res.ok = true;
    res.key = key;
    res.prefix = prefix;
    return res;
  }

  /* ================= SCALE primitives ================= */
  function u32LE(n) {
    n = n >>> 0;
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  }
  function u64LE(big) {
    var b = BigInt(big), out = [];
    for (var i = 0; i < 8; i++) { out.push(Number(b & 0xffn)); b >>= 8n; }
    return out;
  }
  function u128LE(big) {
    var b = BigInt(big), out = [];
    for (var i = 0; i < 16; i++) { out.push(Number(b & 0xffn)); b >>= 8n; }
    if (b !== 0n) throw new Error("amount exceeds u128");
    return out;
  }
  function multiAddressId(key32) {
    if (key32.length !== 32) throw new Error("AccountId must be 32 bytes");
    return [0x00].concat(key32);
  }
  // BlockNumberOrTimestamp: 0x00 || u32 LE | 0x01 || u64 LE
  function delayEnum(delay) {
    if (delay.kind === "blocks") return [0x00].concat(u32LE(delay.blocks));
    if (delay.kind === "ms") return [0x01].concat(u64LE(BigInt(delay.ms)));
    throw new Error("delay.kind must be 'blocks' or 'ms'");
  }
  function toHex(bytes) {
    return "0x" + bytes.map(function (b) {
      return (b < 16 ? "0" : "") + b.toString(16);
    }).join("");
  }
  function fromHex(hex) {
    var s = hex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error("bad hex");
    var out = [];
    for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }

  /* ================= call-data builders ================= */
  function encodeScheduleTransfer(destKey32, amountPlanck) {
    return toHex([C.PALLET_INDEX, C.CALL_SCHEDULE_TRANSFER]
      .concat(multiAddressId(destKey32))
      .concat(u128LE(amountPlanck)));
  }
  function encodeScheduleTransferWithDelay(destKey32, amountPlanck, delay) {
    return toHex([C.PALLET_INDEX, C.CALL_SCHEDULE_TRANSFER_WITH_DELAY]
      .concat(multiAddressId(destKey32))
      .concat(u128LE(amountPlanck))
      .concat(delayEnum(delay)));
  }
  function encodeSetHighSecurity(delay, guardianKey32) {
    return toHex([C.PALLET_INDEX, C.CALL_SET_HIGH_SECURITY]
      .concat(delayEnum(delay))
      .concat(guardianKey32));
  }
  function encodeCancel(txId32) {
    if (txId32.length !== 32) throw new Error("tx_id must be 32 bytes");
    return toHex([C.PALLET_INDEX, C.CALL_CANCEL].concat(txId32));
  }
  function encodeRecoverFunds(accountKey32) {
    return toHex([C.PALLET_INDEX, C.CALL_RECOVER_FUNDS].concat(accountKey32));
  }

  /* ================= delay / quota / fee math ================= */
  function validateDelay(delay) {
    if (delay.kind === "blocks") {
      if (!Number.isInteger(delay.blocks) || delay.blocks < C.MIN_DELAY_BLOCKS)
        return { ok: false, error: "Block delay must be an integer ≥ " + C.MIN_DELAY_BLOCKS + " (MinDelayPeriodBlocks)." };
      if (delay.blocks > 0xffffffff)
        return { ok: false, error: "Block delay exceeds u32 range." };
      return { ok: true };
    }
    if (delay.kind === "ms") {
      if (!Number.isInteger(delay.ms) || delay.ms < C.MIN_DELAY_MOMENT_MS)
        return { ok: false, error: "Timestamp delay must be an integer ≥ " + C.MIN_DELAY_MOMENT_MS + " ms (one target block time)." };
      return { ok: true };
    }
    return { ok: false, error: "Unknown delay kind." };
  }
  // blocks → wall clock
  function blocksToMs(blocks) { return blocks * C.BLOCK_MS; }
  // execute-at block for a block-based delay scheduled at `nowBlock`
  function executeAtBlock(nowBlock, delayBlocks) { return nowBlock + delayBlocks; }
  // 1% of amount, burned on high-security reversal (Permill 10/1000), integer floor
  function volumeFee(planck) {
    return (BigInt(planck) * BigInt(C.VOLUME_FEE_PERMILL)) / 1000n;
  }
  // Rolling-window quota: recent = array of block numbers of the account's recent signed
  // extrinsics (ascending). Returns {allowed, remaining, oldestInWindow}.
  function quotaCheck(recentBlocks, nowBlock) {
    var window = C.HS_QUOTA_WINDOW_BLOCKS, cap = C.HS_QUOTA_TXS;
    var live = recentBlocks.filter(function (b) { return nowBlock - b < window; });
    return {
      allowed: live.length < cap,
      remaining: Math.max(0, cap - live.length),
      inWindow: live.length,
    };
  }

  /* ================= snapshot boundary (round 2) =================
   * data/reversal.json is written by scripts/fetch-reversal-data.mjs from
   * ONE GraphQL query, and renderLive paints its height, totals and queue
   * rows as chain fact (the height also anchors the planner ETA and the
   * quota ages via window.__revHeight). The pre-round-2 boundary was a
   * single `snap.ok` check: an absurd / fractional / scientific-string /
   * boolean height painted and anchored, fetched_at was never consulted,
   * pending was computed with `|| 0` (an unknown total silently became
   * 0, and cancelled + executed could exceed scheduled for a negative
   * pending), and rows rendered raw. This boundary validates shapes AND
   * the relations the fetcher guarantees; whole-snapshot poison returns
   * null (the app shows "snapshot unavailable" and the planners keep
   * working offline), while a malformed ROW drops out of its queue
   * instead of poisoning the snapshot — unless every row drops, which
   * means the list itself is not what the fetcher produced. */
  var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // chain exists from Sept 2026
  var SNAPSHOT_LIST_CAP = 25; // fetch-reversal-data.mjs: limit: 25 on every list

  function nonNegInt(v) {
    var n;
    if (typeof v === "number") n = v;
    else if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) n = Number(v);
    else return null; // booleans, fractions, "2.02e5", objects all reject
    return (Number.isSafeInteger(n) && n >= 0) ? n : null;
  }
  /* Fleet block-height shape: strict integer 1..10,000,000 only. */
  function validBlockHeight(v) {
    var n = nonNegInt(v);
    return (n !== null && n >= 1 && n <= 10000000) ? n : null;
  }
  function validPlancks(v) {
    if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) return null;
    try { BigInt(v); } catch (e) { return null; }
    return v;
  }
  function validTxId(v) {
    return (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) ? v : null;
  }
  function validRowTs(v, fetchedMs) {
    if (typeof v !== "string") return null;
    var ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms < GENESIS_FLOOR_MS || ms > fetchedMs + 300000) return null;
    return ms;
  }
  function isQzAddress(v) { return typeof v === "string" && ss58Decode(v).ok; }

  function cleanSnapshotList(rows, total, kind, fetchedMs) {
    if (!Array.isArray(rows)) return null;
    if (rows.length > SNAPSHOT_LIST_CAP) return null;
    // The list and the aggregate count come from the same query: the
    // list is exactly the newest min(cap, total) entries.
    if (total !== null && rows.length !== Math.min(SNAPSHOT_LIST_CAP, total)) return null;
    var out = [], seen = {}, prevMs = Infinity;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      // scheduled/cancelled/executed rows are keyed by tx_id; the
      // high-security query carries no tx_id — its rows key on who_id
      // (one permanent enrollment per account).
      var rowId = kind === "high_security" ? r.who_id : r.tx_id;
      if (kind !== "high_security" && validTxId(r.tx_id) === null) continue;
      if (typeof rowId !== "string" || seen[rowId]) continue;
      var ms = validRowTs(r.timestamp, fetchedMs);
      if (ms === null) continue;
      // The fetcher orders every list newest-first (order_by timestamp
      // desc); a survivor out of order means the payload is not the
      // fetcher's — fail the snapshot, do not silently re-sort history.
      if (ms > prevMs) return null;
      if (kind === "scheduled") {
        if (validPlancks(r.amount) === null || validPlancks(r.fee) === null) continue;
        if (!isQzAddress(r.from_id) || !isQzAddress(r.to_id)) continue;
      } else if (kind === "cancelled") {
        if (!isQzAddress(r.cancelled_by_id)) continue;
      } else if (kind === "executed") {
        if (typeof r.result !== "string" || !r.result) continue;
      } else if (kind === "high_security") {
        if (!isQzAddress(r.who_id) || !isQzAddress(r.guardian_id)) continue;
        var dl = r.delay;
        if (!((typeof dl === "string" && !!dl) || (typeof dl === "number" && Number.isFinite(dl)))) continue;
      }
      seen[rowId] = 1;
      prevMs = ms;
      out.push(r);
    }
    if (rows.length > 0 && out.length === 0) return null;
    return out;
  }

  function validateSnapshot(raw, nowMs) {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.ok !== true) return null;
      var now = (typeof nowMs === "number" && Number.isFinite(nowMs)) ? nowMs : Date.now();
      if (typeof raw.fetched_at !== "string") return null;
      var fetchedMs = Date.parse(raw.fetched_at);
      if (!Number.isFinite(fetchedMs) || fetchedMs < GENESIS_FLOOR_MS || fetchedMs > now + 3600000) return null;
      var d = raw.data;
      if (!d || typeof d !== "object" || Array.isArray(d)) return null;
      if (!d.status || typeof d.status !== "object") return null;
      var height = validBlockHeight(d.status.block_height);
      if (height === null) return null;
      var statusTotal = nonNegInt(d.status.total_scheduled_transfers);
      if (statusTotal === null) return null;
      if (!d.totals || typeof d.totals !== "object") return null;
      var totals = {}, tKeys = ["scheduled", "cancelled", "executed", "high_security"];
      for (var i = 0; i < tKeys.length; i++) {
        var tv = d.totals[tKeys[i]];
        if (tv === null || tv === undefined) totals[tKeys[i]] = null;
        else {
          var tn = nonNegInt(tv);
          if (tn === null) return null;
          totals[tKeys[i]] = tn;
        }
      }
      // The chain_stats row and the scheduled aggregate are two copies
      // of the same count from the same query: they must agree exactly,
      // and the scheduled total must be present — the hero paints it,
      // so an unknown here is not paintable as 0.
      if (totals.scheduled === null || totals.scheduled !== statusTotal) return null;
      // Pending is derived, never stored: cancelled + executed cannot
      // exceed scheduled, or the derived count would go negative.
      if (totals.cancelled !== null && totals.executed !== null &&
          totals.cancelled + totals.executed > totals.scheduled) return null;
      var scheduled = cleanSnapshotList(d.scheduled, totals.scheduled, "scheduled", fetchedMs);
      var cancelled = cleanSnapshotList(d.cancelled, totals.cancelled, "cancelled", fetchedMs);
      var executed = cleanSnapshotList(d.executed, totals.executed, "executed", fetchedMs);
      var highSec = cleanSnapshotList(d.high_security, totals.high_security, "high_security", fetchedMs);
      if (scheduled === null || cancelled === null || executed === null || highSec === null) return null;
      return {
        ok: true,
        fetched_at: raw.fetched_at,
        data: {
          status: { block_height: height, total_scheduled_transfers: statusTotal },
          scheduled: scheduled, cancelled: cancelled, executed: executed,
          high_security: highSec, totals: totals,
        },
      };
    } catch (e) { return null; }
  }

  /* ================= formatting ================= */
  function formatQTC(planck, decimals) {
    decimals = decimals === undefined ? 6 : decimals;
    var neg = false, p = BigInt(planck);
    if (p < 0n) { neg = true; p = -p; }
    var whole = p / C.UNIT, frac = p % C.UNIT;
    var fracStr = frac.toString().padStart(12, "0").slice(0, decimals).replace(/0+$/, "");
    var wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + wholeStr + (fracStr ? "." + fracStr : "");
  }
  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
    var parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (!parts.length || sec) parts.push(sec + "s");
    return parts.join(" ");
  }
  function shortAddr(a) { return a.length > 18 ? a.slice(0, 10) + "…" + a.slice(-6) : a; }
  function shortHash(h) { return h.length > 18 ? h.slice(0, 10) + "…" + h.slice(-6) : h; }

  return {
    C: C,
    blake2b: blake2b,
    ss58Decode: ss58Decode,
    u32LE: u32LE, u64LE: u64LE, u128LE: u128LE,
    multiAddressId: multiAddressId, delayEnum: delayEnum,
    toHex: toHex, fromHex: fromHex,
    encodeScheduleTransfer: encodeScheduleTransfer,
    encodeScheduleTransferWithDelay: encodeScheduleTransferWithDelay,
    encodeSetHighSecurity: encodeSetHighSecurity,
    encodeCancel: encodeCancel,
    encodeRecoverFunds: encodeRecoverFunds,
    validateDelay: validateDelay,
    validBlockHeight: validBlockHeight, nonNegInt: nonNegInt,
    validPlancks: validPlancks, validateSnapshot: validateSnapshot,
    blocksToMs: blocksToMs,
    executeAtBlock: executeAtBlock,
    volumeFee: volumeFee,
    quotaCheck: quotaCheck,
    formatQTC: formatQTC,
    formatDuration: formatDuration,
    shortAddr: shortAddr,
    shortHash: shortHash,
  };
});
