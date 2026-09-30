/* QTC Distribution Planner - SS58 codec.
 * Extracted verbatim from pages/address-toolkit/app.js (same builder repo).
 * blake2b (RFC 7693) + base58 + SS58 encode/decode with checksum verification.
 * Environment-agnostic: browser global QSS58, Node module.exports.
 */
(function (global) {
"use strict";
/* ---------- blake2b (RFC 7693); 64-bit words as [hi,lo] u32 pairs ---------- */
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
function add64(a, b){
  var lo = (a[1] + b[1]) >>> 0;
  var hi = (a[0] + b[0] + (lo < a[1] ? 1 : 0)) >>> 0;
  return [hi, lo];
}
function xor64(a, b){ return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0]; }
function rotr64(w, n){
  n %= 64;
  if (n === 0) return [w[0], w[1]];
  if (n === 32) return [w[1], w[0]];
  if (n < 32) return [((w[0] >>> n) | (w[1] << (32 - n))) >>> 0,
                     ((w[1] >>> n) | (w[0] << (32 - n))) >>> 0];
  n -= 32;
  return [((w[1] >>> n) | (w[0] << (32 - n))) >>> 0,
          ((w[0] >>> n) | (w[1] << (32 - n))) >>> 0];
}
function blake2b(input, outLen){
  outLen = outLen || 64;
  var h = IV.map(function(x){ return [x[0] >>> 0, x[1] >>> 0]; });
  h[0] = xor64(h[0], [0, 0x01010000 ^ outLen]);
  var msg = input, blocks = [], off, i, k;
  for (off = 0; off < msg.length; off += 128){
    var b = new Array(16);
    for (i = 0; i < 16; i++){
      var o = off + i * 8, lo = 0, hi = 0;
      for (k = 0; k < 8; k++){
        var byte = (o + k) < msg.length ? msg[o + k] : 0;
        if (k < 4) lo |= byte << (k * 8); else hi |= byte << ((k - 4) * 8);
      }
      b[i] = [hi >>> 0, lo >>> 0];
    }
    blocks.push({ m: b, last: (off + 128) >= msg.length });
  }
  if (blocks.length === 0){
    var z = []; for (i = 0; i < 16; i++) z.push([0, 0]);
    blocks.push({ m: z, last: true });
  }
  var t = 0, r;
  blocks.forEach(function(blk, bi){
    t += blk.last ? (msg.length - bi * 128) : 128;
    var v = h.map(function(x){ return [x[0], x[1]]; })
             .concat(IV.map(function(x){ return [x[0] >>> 0, x[1] >>> 0]; }));
    v[12] = xor64(v[12], [(t / 4294967296) >>> 0, t >>> 0]);
    if (blk.last) v[14] = xor64(v[14], [0xffffffff, 0xffffffff]);
    for (r = 0; r < 12; r++){
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
  for (i = 0; i < 8 && out.length < outLen; i++){
    var w = h[i];
    for (k = 0; k < 4 && out.length < outLen; k++) out.push((w[1] >>> (k * 8)) & 0xff);
    for (k = 0; k < 4 && out.length < outLen; k++) out.push((w[0] >>> (k * 8)) & 0xff);
  }
  return out;
}
function G(v, a, b, c, d, x, y){
  v[a] = add64(add64(v[a], v[b]), x);
  v[d] = rotr64(xor64(v[d], v[a]), 32);
  v[c] = add64(v[c], v[d]);
  v[b] = rotr64(xor64(v[b], v[c]), 24);
  v[a] = add64(add64(v[a], v[b]), y);
  v[d] = rotr64(xor64(v[d], v[a]), 16);
  v[c] = add64(v[c], v[d]);
  v[b] = rotr64(xor64(v[b], v[c]), 63);
}

/* ---------- base58 ---------- */
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s){
  for (var ci = 0; ci < s.length; ci++){
    if (ALPHABET.indexOf(s[ci]) < 0)
      throw { badChar: s[ci], pos: ci };
  }
  var zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  var bytes = [0], i, j;
  for (i = 0; i < s.length; i++){
    var carry = ALPHABET.indexOf(s[i]);
    for (j = 0; j < bytes.length; j++){
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0){ bytes.push(carry & 0xff); carry >>= 8; }
  }
  var out = [], k;
  for (i = 0; i < zeros; i++) out.push(0);
  for (k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
  while (out.length > zeros && out[zeros] === 0) out.splice(zeros, 1);
  return out;
}
function b58encode(bytes){
  var zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  var digits = [0], i, j;
  for (i = zeros; i < bytes.length; i++){
    var carry = bytes[i];
    for (j = 0; j < digits.length; j++){
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0){ digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  var s = "", k;
  for (i = 0; i < zeros; i++) s += "1";
  for (k = digits.length - 1; k >= 0; k--) s += ALPHABET[digits[k]];
  return s;
}

/* ---------- SS58 ---------- */
function strBytes(s){
  var a = [], i;
  for (i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xff);
  return a;
}
function prefixBytes(prefix){
  if (prefix < 64) return [prefix];
  if (prefix < 16384)
    return [(((prefix & 0xfc) >>> 2) | 0x40), ((prefix >>> 8) | ((prefix & 0x03) << 6))];
  throw new Error("prefix out of range");
}
function ss58Encode(keyBytes, prefix){
  var body = prefixBytes(prefix).concat(keyBytes);
  var hash = blake2b(strBytes("SS58PRE").concat(body));
  return b58encode(body.concat([hash[0], hash[1]]));
}
function ss58Decode(addr){
  var raw;
  try { raw = b58decode(addr); }
  catch (e){
    return { ok: false, kind: "base58",
             error: "Invalid character '" + e.badChar + "' at position " + (e.pos + 1) +
                    " — base58 excludes 0, O, I and l." };
  }
  if (raw.length < 4)
    return { ok: false, kind: "length", error: "Too short (" + raw.length + " bytes) to be an SS58 address." };
  var prefixLen = ((raw[0] & 0xc0) === 0x40) ? 2 : 1;
  var prefix = prefixLen === 1 ? raw[0]
    : (((raw[0] & 0x3f) << 2) | (raw[1] >>> 6) | ((raw[1] & 0x3f) << 8));
  var key = raw.slice(prefixLen, raw.length - 2);
  var given = raw.slice(raw.length - 2);
  var body = raw.slice(0, raw.length - 2);
  var hash = blake2b(strBytes("SS58PRE").concat(body));
  if (hash[0] !== given[0] || hash[1] !== given[1])
    return { ok: false, kind: "checksum", prefix: prefix, keyLen: key.length,
             error: "Checksum mismatch — the address is corrupted or a character was mistyped." };
  return { ok: true, prefix: prefix, key: key };
}
function toHex(bytes){
  return bytes.map(function(b){ return ("0" + b.toString(16)).slice(-2); }).join("");
}
function fromHex(s){
  s = s.replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) return null;
  var out = [];
  for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

var QUANTUS_PREFIX = 189;
var api = { blake2b: blake2b, b58encode: b58encode, b58decode: b58decode,
  ss58Encode: ss58Encode, ss58Decode: ss58Decode, toHex: toHex, fromHex: fromHex,
  QUANTUS_PREFIX: QUANTUS_PREFIX };
global.QSS58 = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }
})(typeof globalThis !== "undefined" ? globalThis : this);
