/* QTC SCALE Lab — xxHash64 / twox_128 core (classic script, UMD).
 *
 * Lineage: adapted from pages/chain-console/js/lib/xxhash.js, implemented from
 * the public xxHash specification. The critical detail was verified 2026-09-30
 * against the chain's actual hasher: Quantus-Network/chain
 * frame/support/src/hash.rs (`Twox128::hash` -> sp_io::hashing::twox_128),
 * implemented by sp-crypto-hashing 0.1.0 (behind the chain's sp-core 39.0.0):
 * XxHash64 seeds are 0 and 1 — NOT (0, 0x9E3779B97F4A7C15). Cross-checked with
 * @polkadot/util-crypto: twox_128("System") = 26aa394eea5630e07c48ae0c9558cef7
 * (asserted in the test suite).
 *
 * twox_128(data) = xxh64(seed=0) ++ xxh64(seed=1), low 64 bits first.
 */
(function () {
  "use strict";

  var P1 = 0x9E3779B185EBCA87n;
  var P2 = 0xC2B2AE3D27D4EB4Fn;
  var P3 = 0x165667B19E3779F9n;
  var P4 = 0x85EBCA77C2B2AE63n;
  var P5 = 0x27D4EB2F165667C5n;
  var M64 = 0xFFFFFFFFFFFFFFFFn;

  function rotl(x, r) { return ((x << r) | (x >> (64n - r))) & M64; }
  function round(acc, v) { return (((rotl((acc + v * P2) & M64, 31n)) * P1) & M64); }
  function merge(acc, v) { return ((((acc ^ round(0n, v)) * P1) + P4) & M64); }
  function read64(data, o) {
    var v = 0n;
    for (var i = 0; i < 8; i++) v |= BigInt(data[o + i]) << BigInt(8 * i);
    return v;
  }

  function xxh64(data, seed) {
    seed = (seed === undefined) ? 0n : BigInt(seed);
    var len = data.length, h, o = 0;
    if (len >= 32) {
      var v1 = (seed + P1 + P2) & M64;
      var v2 = (seed + P2) & M64;
      var v3 = seed & M64;
      var v4 = (seed - P1) & M64;
      var limit = len - 32;
      while (o <= limit) {
        v1 = round(v1, read64(data, o)); o += 8;
        v2 = round(v2, read64(data, o)); o += 8;
        v3 = round(v3, read64(data, o)); o += 8;
        v4 = round(v4, read64(data, o)); o += 8;
      }
      h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
      h = merge(merge(merge(merge(h, v1), v2), v3), v4);
    } else {
      h = (seed + P5) & M64;
    }
    h = (h + BigInt(len)) & M64;
    while (o + 8 <= len) {
      h = ((rotl(h ^ round(0n, read64(data, o)), 27n) * P1) + P4) & M64;
      o += 8;
    }
    if (o + 4 <= len) {
      var w = BigInt(data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24));
      h = ((rotl(h ^ ((w * P1) & M64), 23n) * P2) + P3) & M64;
      o += 4;
    }
    while (o < len) {
      h = ((rotl(h ^ ((BigInt(data[o]) * P5) & M64), 11n) * P1)) & M64;
      o += 1;
    }
    h ^= h >> 33n; h = (h * P2) & M64;
    h ^= h >> 29n; h = (h * P3) & M64;
    h ^= h >> 32n;
    return h & M64;
  }

  function h64le(h) {
    var b = new Array(8);
    for (var i = 0; i < 8; i++) b[i] = Number((h >> BigInt(8 * i)) & 0xffn);
    return b;
  }
  function twox128bytes(data) {
    var lo = h64le(xxh64(data, 0n)), hi = h64le(xxh64(data, 1n));
    return lo.concat(hi);
  }
  function twox64bytes(data) { return h64le(xxh64(data, 0n)); }

  function blake2b() {
    var C = (typeof window !== "undefined" && window.QSL_CRYPTO) ? window.QSL_CRYPTO
          : (typeof globalThis !== "undefined" && globalThis.QSL_CRYPTO) ? globalThis.QSL_CRYPTO
          : null;
    if (!C) throw new Error("QSL_CRYPTO (scale-crypto.js) must load before twox.js");
    return C.blake2b;
  }
  function blake2_128bytes(data) { return blake2b()(Array.prototype.slice.call(data), 16); }

  function hexOf(bytes) {
    return bytes.map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
  }

  /* Storage-map key hashers (Substrate): */
  function twox64Concat(key)   { var h = twox64bytes(key);   return h.concat(Array.prototype.slice.call(key)); }
  function blake2_128Concat(key){ var h = blake2_128bytes(key); return h.concat(Array.prototype.slice.call(key)); }
  function identity(key)       { return Array.prototype.slice.call(key); }

  /* Plain (non-map) storage key: twox_128(pallet) ++ twox_128(item). */
  function storageKeyPlain(pallet, item) {
    var te = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
    var p = te ? Array.prototype.slice.call(te.encode(pallet)) : pallet.split("").map(function (c) { return c.charCodeAt(0) & 0xff; });
    var s = te ? Array.prototype.slice.call(te.encode(item)) : item.split("").map(function (c) { return c.charCodeAt(0) & 0xff; });
    return twox128bytes(p).concat(twox128bytes(s));
  }
  /* Map storage key: plain ++ hasher(keyBytes). hasher in {twox64concat, blake2_128concat, identity}. */
  function storageKeyMap(pallet, item, keyBytes, hasher) {
    var base = storageKeyPlain(pallet, item);
    var kh = hasher === "twox64concat" ? twox64Concat(keyBytes)
           : hasher === "identity" ? identity(keyBytes)
           : blake2_128Concat(keyBytes);
    return base.concat(kh);
  }

  var api = {
    xxh64: xxh64,
    twox128bytes: twox128bytes, twox64bytes: twox64bytes,
    twox128hex: function (d) { return hexOf(twox128bytes(d)); },
    twox64hex: function (d) { return hexOf(twox64bytes(d)); },
    blake2_128hex: function (d) { return hexOf(blake2_128bytes(d)); },
    twox64Concat: twox64Concat, blake2_128Concat: blake2_128Concat, identityHasher: identity,
    storageKeyPlain: storageKeyPlain, storageKeyMap: storageKeyMap
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.QSL_TWOX = api;
})();
