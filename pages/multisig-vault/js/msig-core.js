/* QTC MultiSig Vault — core logic (browser + Node).
 *
 * Exact math for the Quantus custom multisig pallet, read from
 * Quantus-Network/chain (checked 2026-09-30, pallet at runtime index 19):
 *   pallets/multisig/src/lib.rs — address derivation:
 *       blake2b-256( pallet_id(8B "py/mltsg")
 *                  || SCALE(Vec<AccountId32>) of LEXICOGRAPHICALLY SORTED signers
 *                  || SCALE(u32 threshold)
 *                  || SCALE(u64 nonce) )
 *     then decoded as AccountId32 via TrailingZeroInput (hash bytes, zero-padded).
 *     For a 32-byte AccountId32 and a 32-byte Blake2-256 digest, that is simply
 *     the digest itself — no truncation, no ambiguity.
 *   pallets/multisig/src/lib.rs — call indices 0..6:
 *     0 create_multisig(signers, threshold, nonce)
 *     1 propose(multisig_address, call: BoundedVec<u8>, expiry: u32 block)
 *     2 approve(multisig_address, proposal_id: u32, call: BoundedVec<u8>)
 *     3 cancel(multisig_address, proposal_id: u32)
 *     4 remove_expired(multisig_address, proposal_id: u32)
 *     5 claim_deposits(multisig_address)
 *     6 execute(multisig_address, proposal_id: u32, call: BoundedVec<u8>)
 *   runtime/src/configs/mod.rs — MultisigFee 0.03 QTC (burned),
 *     ProposalDeposit 0.01 QTC (reserved, refunded), ProposalFee 0.05 QTC (burned),
 *     SignerStepFactor 1% (Permill::from_percent(1)),
 *     MaxExpiryDuration 100_800 blocks (~14 days at 12s blocks),
 *     MaxCallSize 10_240 bytes, MaxSigners 100, PalletId b"py/mltsg".
 *   runtime/src/lib.rs — pallet index 19, BlockNumber = u32.
 * Balances call indices from pallet-balances 46.0.0 (Cargo.lock @ 2026-09-30):
 *   index 3 transfer_keep_alive(dest, #[compact] value),
 *   index 4 transfer_all(dest, keep_alive: bool).
 *
 * This file never touches private keys. It produces addresses and UNSIGNED
 * call payloads that the user signs with quantus-cli or their wallet.
 */
(function (root) {
"use strict";

/* ================= chain constants ================= */
var SS58_PREFIX = 189;
var DECIMALS = 12;
var PLANCKS = 1000000000000n;               // 10^12
var PALLET_INDEX = 19;                       // Multisig in construct_runtime!
var PALLET_ID = [0x70, 0x79, 0x2f, 0x6d, 0x6c, 0x74, 0x73, 0x67]; // b"py/mltsg"
var BALANCES_PALLET_INDEX = 2;
var CALL_IDX = {
  create_multisig: 0, propose: 1, approve: 2, cancel: 3,
  remove_expired: 4, claim_deposits: 5, execute: 6,
  balances_transfer_allow_death: 0, balances_transfer_keep_alive: 3,
  balances_transfer_all: 4
};
var MAX_SIGNERS = 100;
var MAX_CALL_SIZE = 10240;
var MAX_EXPIRY_DURATION = 100800;            // blocks (~14 days at 12s)
var BLOCK_MS = 12000;
var MULTISIG_FEE = 30000000000n;             // 0.03 QTC, burned
var PROPOSAL_DEPOSIT = 10000000000n;         // 0.01 QTC, reserved -> refunded
var PROPOSAL_FEE = 50000000000n;             // 0.05 QTC, burned
var SIGNER_STEP_PERMILL = 10000n;            // Permill::from_percent(1) = 1%

/* ================= blake2b (RFC 7693, verified vs Python hashlib) ================= */
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

/* ================= base58 / SS58 ================= */
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s){
  for (var ci = 0; ci < s.length; ci++)
    if (ALPHABET.indexOf(s[ci]) < 0) throw { badChar: s[ci], pos: ci };
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
             error: "Invalid character '" + e.badChar + "' at position " + (e.pos + 1) + "." };
  }
  if (raw.length < 4)
    return { ok: false, kind: "length", error: "Too short to be an SS58 address." };
  var prefixLen = ((raw[0] & 0xc0) === 0x40) ? 2 : 1;
  var prefix = prefixLen === 1 ? raw[0]
    : (((raw[0] & 0x3f) << 2) | (raw[1] >>> 6) | ((raw[1] & 0x3f) << 8));
  var key = raw.slice(prefixLen, raw.length - 2);
  var given = raw.slice(raw.length - 2);
  var hash = blake2b(strBytes("SS58PRE").concat(raw.slice(0, raw.length - 2)));
  if (hash[0] !== given[0] || hash[1] !== given[1])
    return { ok: false, kind: "checksum", prefix: prefix, keyLen: key.length,
             error: "Checksum mismatch — a character may be mistyped." };
  return { ok: true, prefix: prefix, key: key };
}

/* ================= hex / SCALE helpers ================= */
function toHex(bytes){
  return bytes.map(function(b){ return ("0" + b.toString(16)).slice(-2); }).join("");
}
function fromHex(s){
  s = String(s).replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) return null;
  var out = [];
  for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}
function u32le(n){
  n = n >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u64le(bn){
  bn = BigInt(bn);
  var out = [];
  for (var i = 0; i < 8; i++){ out.push(Number(bn & 0xffn)); bn >>= 8n; }
  return out;
}
/* SCALE compact for u128 (BigInt) */
function compactU128(v){
  v = BigInt(v);
  if (v < 0n) throw new Error("negative compact");
  if (v <= 63n) return [Number(v << 2n)];
  if (v <= 16383n){ var x = Number((v << 2n) | 1n); return [x & 0xff, (x >>> 8) & 0xff]; }
  if (v <= 1073741823n){ var y = Number((v << 2n) | 2n);
    return [y & 0xff, (y >>> 8) & 0xff, (y >>> 16) & 0xff, (y >>> 24) & 0xff]; }
  var bytes = [];
  var t = v;
  while (t > 0n){ bytes.push(Number(t & 0xffn)); t >>= 8n; }
  if (bytes.length < 4) bytes.push(0, 0, 0, 0);
  bytes.length = Math.max(bytes.length, 4);
  return [((bytes.length - 4) << 2) | 3].concat(bytes);
}
/* SCALE Vec<AccountId32>: compact length + raw 32-byte keys */
function vecAccountId(keys){
  var out = compactU128(BigInt(keys.length));
  keys.forEach(function(k){ out = out.concat(k); });
  return out;
}
/* SCALE BoundedVec<u8>: compact length + bytes */
function boundedBytes(bytes){
  return compactU128(BigInt(bytes.length)).concat(bytes);
}

/* ================= money ================= */
function qtcToPlancks(qtcStr){
  var s = String(qtcStr).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(s)) return null;
  var parts = s.split(".");
  var whole = BigInt(parts[0]) * PLANCKS;
  var frac = parts[1] ? BigInt((parts[1] + "000000000000").slice(0, 12)) : 0n;
  return whole + frac;
}
function plancksToQtc(p){
  p = BigInt(p);
  var w = p / PLANCKS, f = p % PLANCKS;
  var fs = f.toString().padStart(12, "0").replace(/0+$/, "");
  return w.toString() + (fs ? "." + fs : "");
}

/* ================= multisig address derivation ================= */
/* Mirrors Multisig::derive_multisig_address: sort AccountIds lexicographically
 * (Rust Vec::sort on AccountId32 = byte-wise), then
 * blake2b-256(b"py/mltsg" || SCALE(Vec<AccountId32>) || SCALE(u32 t) || SCALE(u64 n)).
 */
function sortKeyHex(hexKeys){
  return hexKeys.slice().sort(function(a, b){
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}
function deriveMultisigAddress(signerKeys /* array of 64-hex-char strings */,
                               threshold, nonce /* number or BigInt */){
  if (!Array.isArray(signerKeys) || signerKeys.length < 2)
    return { ok: false, error: "A multisig needs at least 2 unique signers." };
  if (signerKeys.length > MAX_SIGNERS)
    return { ok: false, error: "Too many signers (max " + MAX_SIGNERS + ")." };
  var keys = [];
  for (var i = 0; i < signerKeys.length; i++){
    var b = fromHex(signerKeys[i]);
    if (!b || b.length !== 32)
      return { ok: false, error: "Signer " + (i + 1) + " is not 32 bytes of hex." };
    keys.push(toHex(b));
  }
  var sorted = sortKeyHex(keys);
  for (var d = 0; d + 1 < sorted.length; d++)
    if (sorted[d] === sorted[d + 1])
      return { ok: false, error: "Duplicate signer — each signer may appear only once." };
  var t = Number(threshold);
  if (!(t >= 1) || Math.floor(t) !== t)
    return { ok: false, error: "Threshold must be a positive integer." };
  if (t > sorted.length)
    return { ok: false, error: "Threshold cannot exceed the signer count." };
  var n = BigInt(nonce);
  if (n < 0n || n > 18446744073709551615n)
    return { ok: false, error: "Nonce must fit in a u64." };
  var keyBytes = sorted.map(fromHex);
  var preimage = PALLET_ID
    .concat(vecAccountId(keyBytes))
    .concat(u32le(t))
    .concat(u64le(n));
  var digest = blake2b(preimage, 32);   // TrailingZeroInput: hash == AccountId bytes
  return {
    ok: true,
    hex: toHex(digest),
    ss58: ss58Encode(digest, SS58_PREFIX),
    sortedHex: sorted,
    preimageHex: toHex(preimage),
    threshold: t,
    nonce: n.toString(),
    signerCount: sorted.length
  };
}

/* ================= fees ================= */
/* Mirrors proposal_fee(): base + Permill::from_percent(1).mul_floor(base * n) */
function proposalFeePlancks(signerCount){
  var n = BigInt(signerCount);
  var extra = (PROPOSAL_FEE * n * SIGNER_STEP_PERMILL) / 1000000n;
  return PROPOSAL_FEE + extra;
}
/* Full first-proposal lifecycle budget for the CREATOR's side:
 * create fee (burned) + proposal fee (burned) + proposal deposit (reserved). */
function lifecycleBudget(signerCount){
  return {
    createFee: MULTISIG_FEE,
    proposalFee: proposalFeePlancks(signerCount),
    proposalDeposit: PROPOSAL_DEPOSIT,
    totalOutlay: MULTISIG_FEE + proposalFeePlancks(signerCount) + PROPOSAL_DEPOSIT
  };
}

/* ================= inner call builders ================= */
/* Balances pallet (index 2): transfer_keep_alive (3) and transfer_all (4).
 * dest is MultiAddress::Id -> 0x00 || 32 bytes. */
function encodeTransferKeepAlive(destHex, valuePlancks){
  var dest = fromHex(destHex);
  if (!dest || dest.length !== 32) return { ok: false, error: "Recipient must be 32 bytes of hex." };
  var v = BigInt(valuePlancks);
  if (v <= 0n) return { ok: false, error: "Amount must be positive." };
  var bytes = [BALANCES_PALLET_INDEX, CALL_IDX.balances_transfer_keep_alive, 0x00]
    .concat(dest).concat(compactU128(v));
  if (bytes.length > MAX_CALL_SIZE) return { ok: false, error: "Call exceeds 10 KB." };
  return { ok: true, hex: toHex(bytes), kind: "transfer_keep_alive" };
}
function encodeTransferAll(destHex, keepAlive){
  var dest = fromHex(destHex);
  if (!dest || dest.length !== 32) return { ok: false, error: "Recipient must be 32 bytes of hex." };
  var bytes = [BALANCES_PALLET_INDEX, CALL_IDX.balances_transfer_all, 0x00]
    .concat(dest).concat([keepAlive ? 1 : 0]);
  return { ok: true, hex: toHex(bytes), kind: "transfer_all" };
}

/* ================= multisig extrinsic payloads (unsigned) ================= */
/* Encoded as the RuntimeCall bytes of pallet 19's dispatchable — the part a
 * signer feeds to quantus-cli / a wallet to sign. */
function encodePropose(multisigHex, innerCallHex, expiryBlock){
  var ms = fromHex(multisigHex), call = fromHex(innerCallHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  if (!call || call.length === 0) return { ok: false, error: "Bad inner call bytes." };
  if (call.length > MAX_CALL_SIZE) return { ok: false, error: "Inner call exceeds 10 KB." };
  var exp = Number(expiryBlock) >>> 0;
  var bytes = [PALLET_INDEX, CALL_IDX.propose].concat(ms)
    .concat(boundedBytes(call)).concat(u32le(exp));
  return { ok: true, hex: toHex(bytes), call: "Multisig.propose", expiry: exp };
}
function encodeApprove(multisigHex, proposalId, innerCallHex){
  var ms = fromHex(multisigHex), call = fromHex(innerCallHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  if (!call || call.length === 0) return { ok: false, error: "Bad inner call bytes." };
  var bytes = [PALLET_INDEX, CALL_IDX.approve].concat(ms)
    .concat(u32le(proposalId)).concat(boundedBytes(call));
  return { ok: true, hex: toHex(bytes), call: "Multisig.approve" };
}
function encodeCancel(multisigHex, proposalId){
  var ms = fromHex(multisigHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  var bytes = [PALLET_INDEX, CALL_IDX.cancel].concat(ms).concat(u32le(proposalId));
  return { ok: true, hex: toHex(bytes), call: "Multisig.cancel" };
}
function encodeRemoveExpired(multisigHex, proposalId){
  var ms = fromHex(multisigHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  var bytes = [PALLET_INDEX, CALL_IDX.remove_expired].concat(ms).concat(u32le(proposalId));
  return { ok: true, hex: toHex(bytes), call: "Multisig.remove_expired" };
}
function encodeClaimDeposits(multisigHex){
  var ms = fromHex(multisigHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  var bytes = [PALLET_INDEX, CALL_IDX.claim_deposits].concat(ms);
  return { ok: true, hex: toHex(bytes), call: "Multisig.claim_deposits" };
}
function encodeExecute(multisigHex, proposalId, innerCallHex){
  var ms = fromHex(multisigHex), call = fromHex(innerCallHex);
  if (!ms || ms.length !== 32) return { ok: false, error: "Bad multisig address bytes." };
  if (!call || call.length === 0) return { ok: false, error: "Bad inner call bytes." };
  var bytes = [PALLET_INDEX, CALL_IDX.execute].concat(ms)
    .concat(u32le(proposalId)).concat(boundedBytes(call));
  return { ok: true, hex: toHex(bytes), call: "Multisig.execute" };
}
function encodeCreateMultisig(signerKeys, threshold, nonce){
  var d = deriveMultisigAddress(signerKeys, threshold, nonce);
  if (!d.ok) return d;
  var keyBytes = d.sortedHex.map(fromHex);
  var bytes = [PALLET_INDEX, CALL_IDX.create_multisig]
    .concat(vecAccountId(keyBytes))
    .concat(u32le(d.threshold))
    .concat(u64le(BigInt(d.nonce)));
  return { ok: true, hex: toHex(bytes), call: "Multisig.create_multisig", derived: d };
}

/* ================= expiry helpers ================= */
function blocksToHuman(blocks){
  var b = Number(blocks);
  var ms = b * BLOCK_MS;
  var days = Math.floor(ms / 86400000);
  var hours = Math.floor((ms % 86400000) / 3600000);
  var mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + mins + "m";
  return mins + "m";
}
function expiryBlockNow(chainHeight, blocksAhead){
  return (Number(chainHeight) >>> 0) + (Number(blocksAhead) >>> 0);
}

var MsigCore = {
  SS58_PREFIX: SS58_PREFIX, DECIMALS: DECIMALS,
  PALLET_INDEX: PALLET_INDEX, BALANCES_PALLET_INDEX: BALANCES_PALLET_INDEX,
  CALL_IDX: CALL_IDX, MAX_SIGNERS: MAX_SIGNERS, MAX_CALL_SIZE: MAX_CALL_SIZE,
  MAX_EXPIRY_DURATION: MAX_EXPIRY_DURATION, BLOCK_MS: BLOCK_MS,
  MULTISIG_FEE: MULTISIG_FEE, PROPOSAL_DEPOSIT: PROPOSAL_DEPOSIT,
  PROPOSAL_FEE: PROPOSAL_FEE, SIGNER_STEP_PERMILL: SIGNER_STEP_PERMILL,
  blake2b: blake2b, ss58Encode: ss58Encode, ss58Decode: ss58Decode,
  toHex: toHex, fromHex: fromHex, u32le: u32le, u64le: u64le,
  compactU128: compactU128, vecAccountId: vecAccountId, boundedBytes: boundedBytes,
  qtcToPlancks: qtcToPlancks, plancksToQtc: plancksToQtc,
  deriveMultisigAddress: deriveMultisigAddress, sortKeyHex: sortKeyHex,
  proposalFeePlancks: proposalFeePlancks, lifecycleBudget: lifecycleBudget,
  encodeTransferKeepAlive: encodeTransferKeepAlive, encodeTransferAll: encodeTransferAll,
  encodeCreateMultisig: encodeCreateMultisig, encodePropose: encodePropose,
  encodeApprove: encodeApprove, encodeCancel: encodeCancel,
  encodeRemoveExpired: encodeRemoveExpired, encodeClaimDeposits: encodeClaimDeposits,
  encodeExecute: encodeExecute,
  blocksToHuman: blocksToHuman, expiryBlockNow: expiryBlockNow
};

if (typeof module !== "undefined" && module.exports) module.exports = MsigCore;
else root.MsigCore = MsigCore;
})(typeof window !== "undefined" ? window : globalThis);
