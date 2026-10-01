/* QTC Exposure Lab — core: address validation + quantum-exposure analysis (no DOM).
 *
 * SS58 / base58 / blake2b crypto adapted from pages/address-toolkit/app.js
 * (verified 2026-09-29 against Quantus-Network/chain genesis vesting table:
 * prefix 189, 32-byte keys, checksum = blake2b-512("SS58PRE"||body)[0..2];
 * blake2b byte-verified vs Python hashlib/OpenSSL).
 * bech32 decoder follows BIP-173. Base58Check uses double-SHA-256.
 *
 * Threat model (re-verify before republishing):
 * - ECDSA/secp256k1 (Bitcoin, Ethereum) falls to Shor's algorithm on a
 *   cryptographically relevant quantum computer. A public key on-chain today
 *   can be harvested now and broken at Q-Day ("harvest now, decrypt later").
 * - Bitcoin P2PKH/P2WPKH reveal the public key only when an output is SPENT
 *   (the spending signature/script publishes it). P2PK and P2TR (taproot)
 *   outputs carry the public key at FUNDING time — no spend needed.
 * - Ethereum publishes an ECDSA signature with every outgoing transaction,
 *   from which the public key is recoverable (recovery id). Any address that
 *   has ever sent a transaction is exposed.
 * - Quantus uses ML-DSA-65/87 (NIST FIPS 204) from the genesis block —
 *   quantum-resistant by construction. Other Substrate chains are NOT:
 *   an SS58 account id IS the raw 32-byte sr25519/ed25519 public key.
 */
(function(){
"use strict";

var QUANTUS_PREFIX = 189;

/* ============================================================
 * blake2b (RFC 7693); 64-bit words as [hi,lo] u32 pairs
 * (copied from pages/address-toolkit/app.js)
 * ============================================================ */
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

/* ---------- base58 (copied from pages/address-toolkit/app.js) ---------- */
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

/* ---------- SS58 (copied from pages/address-toolkit/app.js) ---------- */
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

/* ============================================================
 * bech32 (BIP-173) decoder — for native SegWit Bitcoin addresses
 * ============================================================ */
var BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values){
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var chk = 1, p, i;
  for (p = 0; p < values.length; p++){
    var b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function bech32HrpExpand(hrp){
  var ret = [], i;
  for (i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}
function bech32ConvertBits(data, fromBits, toBits, pad){
  var acc = 0, bits = 0, ret = [], i, maxv = (1 << toBits) - 1;
  for (i = 0; i < data.length; i++){
    acc = (acc << fromBits) | data[i];
    bits += fromBits;
    while (bits >= toBits){
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad){
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)){
    return null;
  }
  return ret;
}
function bech32Decode(addr){
  var s = addr;
  if (s.length < 8 || s.length > 90)
    return { ok: false, error: "Bech32 addresses are 8–90 characters." };
  var lower = s.toLowerCase(), upper = s.toUpperCase();
  if (s !== lower && s !== upper)
    return { ok: false, error: "Mixed case — bech32 must be all-lowercase or all-uppercase." };
  s = lower;
  for (var i = 0; i < s.length; i++){
    var c = s.charCodeAt(i);
    if (c < 33 || c > 126)
      return { ok: false, error: "Invalid character in bech32 string." };
  }
  var pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length)
    return { ok: false, error: "Missing or misplaced bech32 separator '1'." };
  var hrp = s.slice(0, pos), dataPart = s.slice(pos + 1);
  var data = [];
  for (var j = 0; j < dataPart.length; j++){
    var d = BECH32_CHARSET.indexOf(dataPart[j]);
    if (d < 0) return { ok: false, error: "Character '" + dataPart[j] + "' not in bech32 alphabet." };
    data.push(d);
  }
  var pm = bech32Polymod(bech32HrpExpand(hrp).concat(data));
  // BIP-173 (bech32, constant 1) for witness v0; BIP-350 (bech32m,
  // constant 0x2bc830a3) for witness v1+. Taproot addresses are bech32m.
  var enc = null;
  if (pm === 1) enc = "bech32";
  else if (pm === 0x2bc830a3) enc = "bech32m";
  else return { ok: false, error: "Bech32 checksum failed — mistyped address." };
  // BIP-173: data[0] is the witness version (a single 5-bit value);
  // the remaining values convert 5 -> 8 bits into the witness program.
  var version = data[0];
  if (version > 16) return { ok: false, error: "Invalid witness version." };
  if (enc === "bech32" && version !== 0)
    return { ok: false, error: "Witness v" + version + " must use bech32m encoding (BIP-350)." };
  if (enc === "bech32m" && version === 0)
    return { ok: false, error: "Witness v0 must use bech32 encoding (BIP-173)." };
  var program = bech32ConvertBits(data.slice(1, -6), 5, 8, false);
  if (!program)
    return { ok: false, error: "Bad witness program encoding." };
  return { ok: true, hrp: hrp, version: version, program: program, encoding: enc };
}

/* ---------- SHA-256 via WebCrypto (async; works in browser + node) ---------- */
function getSubtle(){
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle)
    return globalThis.crypto.subtle;
  try {
    var nc = require("crypto");
    if (nc.webcrypto && nc.webcrypto.subtle) return nc.webcrypto.subtle;
  } catch (e) { /* not node */ }
  return null;
}
async function sha256Bytes(bytes){
  var subtle = getSubtle();
  if (!subtle) throw new Error("No SubtleCrypto available for SHA-256.");
  var buf = await subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.prototype.slice.call(new Uint8Array(buf));
}

/* ============================================================
 * Address validation — returns {chain, format, network, ok, error, detail}
 * chain: 'btc' | 'eth' | 'qtc' | 'substrate' | 'unknown'
 * ============================================================ */
function validateETH(addr){
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
    return { chain: "unknown", ok: false,
             error: "Not a valid Ethereum address — expected 0x followed by 40 hex characters." };
  return { chain: "eth", format: "hex (EIP-55 unchecked)", network: "mainnet", ok: true };
}
async function validateBTC(addr){
  // bech32 / bech32m native segwit
  if (/^(bc1|tb1|bcrt1)/i.test(addr)){
    var d = bech32Decode(addr);
    if (!d.ok) return { chain: "unknown", ok: false, error: d.error };
    var net = d.hrp === "bc" ? "mainnet" : (d.hrp === "tb" ? "testnet" : "regtest");
    var fmt, note = "";
    if (d.version === 0 && d.program.length === 20) fmt = "P2WPKH (native SegWit v0)";
    else if (d.version === 0 && d.program.length === 32) fmt = "P2WSH (native SegWit v0)";
    else if (d.version === 1 && d.program.length === 32){
      fmt = "P2TR (Taproot v1)";
      note = "taproot-key-in-output";
    }
    else { fmt = "SegWit v" + d.version + " (unrecognized program)"; note = "unknown-witness"; }
    return { chain: "btc", format: fmt, network: net, ok: true, detail: note,
             witnessVersion: d.version };
  }
  // base58 legacy
  var raw;
  try { raw = b58decode(addr); }
  catch (e){
    return { chain: "unknown", ok: false,
             error: "Invalid base58 character '" + e.badChar + "' at position " + (e.pos + 1) + "." };
  }
  if (raw.length !== 25)
    return { chain: "unknown", ok: false,
             error: "Decoded to " + raw.length + " bytes — a Base58Check Bitcoin address is 25." };
  var h1 = await sha256Bytes(raw.slice(0, 21));
  var h2 = await sha256Bytes(h1);
  if (h2[0] !== raw[21] || h2[1] !== raw[22] || h2[2] !== raw[23] || h2[3] !== raw[24])
    return { chain: "unknown", ok: false, error: "Base58Check checksum failed — mistyped address." };
  var ver = raw[0], fmt2, net2 = "mainnet";
  if (ver === 0x00) fmt2 = "P2PKH (legacy)";
  else if (ver === 0x05) fmt2 = "P2SH (legacy)";
  else if (ver === 0x6f){ fmt2 = "P2PKH (testnet)"; net2 = "testnet"; }
  else if (ver === 0xc4){ fmt2 = "P2SH (testnet)"; net2 = "testnet"; }
  else return { chain: "unknown", ok: false, error: "Unknown address version byte 0x" + ver.toString(16) + "." };
  return { chain: "btc", format: fmt2, network: net2, ok: true };
}
function validateQTC(addr){
  var d = ss58Decode(addr);
  if (!d.ok) return { chain: "unknown", ok: false, error: d.error };
  if (d.prefix === QUANTUS_PREFIX)
    return { chain: "qtc", format: "SS58 (prefix 189)", network: "Quantus mainnet", ok: true };
  return { chain: "substrate", format: "SS58 (prefix " + d.prefix + ")", network: "other Substrate chain",
           ok: true, detail: "non-quantus-prefix" };
}
async function detectChain(addr){
  var a = (addr || "").trim();
  if (!a) return { chain: "unknown", ok: false, error: "Empty input." };
  if (/^0x/i.test(a)) return validateETH(a);
  if (/^(bc1|tb1|bcrt1)/i.test(a)) return validateBTC(a);
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,60}$/.test(a)) return await validateBTC(a);
  var q = validateQTC(a);
  if (q.ok) return q;
  // SS58-shaped input with a real checksum/length problem: surface that specific error.
  if (q.error && /checksum|Too short/i.test(q.error)) return q;
  return { chain: "unknown", ok: false,
           error: "Unrecognized address format — not BTC, ETH, or Quantus SS58." };
}

/* ============================================================
 * Exposure analysis (pure functions — fully unit-tested)
 * api: live data normalized by the UI layer, or null when offline.
 * ============================================================ */
function fmtBTC(sats){
  var b = sats / 1e8;
  return (b >= 0.0001 ? b.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : b.toExponential(2)) + " BTC";
}
function fmtETH(weiStr){
  try {
    var wei = BigInt(weiStr || "0");
    var whole = wei / BigInt("1000000000000000000");
    var frac = wei % BigInt("1000000000000000000");
    var fs = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return whole.toString() + (fs ? "." + fs : "") + " ETH";
  } catch (e){ return weiStr + " wei"; }
}

function analyzeBTC(v, api){
  var ev = [], rec = "";
  if (!api || api.offline){
    return { verdict: "unknown", title: "Could not reach chain data",
      evidence: ["The address format is valid (" + v.format + "), but the mempool.space lookup failed or is offline — no exposure verdict without chain history."],
      recommendation: "Retry with a connection, or check the address on mempool.space manually: any spent output means the public key is on-chain." };
  }
  var bal = fmtBTC(api.balance_sats || 0);
  if (api.p2tr_funded){
    ev.push("Taproot (P2TR) output detected — the tweaked public key sits directly in the output script. Exposed since funding, no spend required.");
  }
  if (api.p2pk_observed){
    ev.push("Pay-to-public-key (P2PK) output observed — the full public key is embedded in the locking script.");
  }
  if ((api.spent_txo_count || 0) > 0){
    ev.push(api.spent_txo_count + " spent output(s) across " + (api.tx_count || "?") + " transaction(s) — each spend published the public key in the unlocking script/signature.");
    rec = "Treat this address as harvestable today. Move funds to a fresh address you have never spent from — and for long-term cold storage, consider a post-quantum chain (see the migration playbook below). Never reuse this address.";
    return { verdict: "exposed", title: "EXPOSED — public key is on-chain",
             evidence: ev.concat(["Current balance: " + bal + "."]), recommendation: rec };
  }
  if (api.p2tr_funded || api.p2pk_observed){
    rec = "The public key is already visible to everyone. Move the funds to a fresh, never-spent address; for a durable fix, migrate to post-quantum signatures.";
    return { verdict: "exposed", title: "EXPOSED — public key is on-chain",
             evidence: ev.concat(["Current balance: " + bal + "."]), recommendation: rec };
  }
  if ((api.funded_txo_count || 0) > 0){
    ev.push("Funded but never spent — the public key (hash) is still hidden behind " + v.format + ".");
    ev.push("Current balance: " + bal + ".");
    rec = "Safe for now, fragile by design: the FIRST spend from this address publishes its public key. For cold storage measured in years, that is the wrong bet — migrate before you ever need to spend.";
    return { verdict: "latent", title: "LATENT — safe until first spend",
             evidence: ev, recommendation: rec };
  }
  return { verdict: "clean", title: "CLEAN — never used on-chain",
           evidence: ["No transactions found for this address. Nothing to harvest."],
           recommendation: "Keep it that way: this address is quantum-safe until its first spend — because there is no public key anywhere yet." };
}

function analyzeETH(v, api){
  if (!api || api.offline){
    return { verdict: "unknown", title: "Could not reach chain data",
      evidence: ["The address format is valid, but the chain-data lookup failed or is offline — no exposure verdict without history."],
      recommendation: "Retry with a connection. Rule of thumb: if this address has EVER sent a transaction, its public key is recoverable from the signature and it is exposed." };
  }
  var sent = false;
  try { sent = BigInt(api.total_sent_wei || "0") > 0; } catch (e){ sent = !!api.n_tx; }
  var bal = fmtETH(api.balance_wei || "0");
  if (sent){
    return { verdict: "exposed", title: "EXPOSED — public key recoverable",
      evidence: [
        "This address has sent " + fmtETH(api.total_sent_wei || "0") + " in " + (api.n_tx || "?") + " transaction(s).",
        "Every Ethereum transaction carries an ECDSA signature from which the public key is mathematically recoverable — it is on-chain forever.",
        "Current balance: " + bal + "."
      ],
      recommendation: "Treat this address as harvestable today. Migrate funds to a fresh address (and for a durable fix, to post-quantum signatures — see the playbook). Do not keep long-term holdings on an address that has ever sent." };
  }
  var hasActivity = false;
  try { hasActivity = (api.n_tx || 0) > 0 || BigInt(api.balance_wei || "0") > 0; } catch (e){}
  if (hasActivity){
    return { verdict: "latent", title: "LATENT — funded, never sent",
      evidence: [
        "No outgoing transactions observed — the public key has never been published.",
        "Current balance: " + bal + "."
      ],
      recommendation: "Safe for now, fragile by design: the FIRST outgoing transaction publishes the public key. If this is long-term storage, migrate before that day comes." };
  }
  return { verdict: "clean", title: "CLEAN — never used on-chain",
           evidence: ["No transactions and zero balance found. Nothing to harvest."],
           recommendation: "Nothing to do — but remember: one outgoing transaction is all it takes to expose an Ethereum address permanently." };
}

function analyzeQTC(v){
  return { verdict: "safe", title: "SAFE — post-quantum by construction",
    evidence: [
      "Valid Quantus SS58 address (prefix 189, checksum verified locally).",
      "Quantus signs with ML-DSA-65 / ML-DSA-87 (NIST FIPS 204) from the genesis block — there is no ECDSA public key for Shor's algorithm to attack."
    ],
    recommendation: "This is the end state the playbook below migrates toward. No action needed." };
}

function analyzeSubstrate(v){
  return { verdict: "exposed", title: "EXPOSED BY DESIGN — raw public key as the address",
    evidence: [
      "Valid SS58 address, but prefix " + v.format.match(/\d+/)[0] + " — not Quantus.",
      "On most Substrate chains the account id IS the raw 32-byte sr25519/ed25519 public key. It is visible to everyone, permanently, by design — and those schemes fall to Shor's algorithm."
    ],
    recommendation: "Do not hold long-term value here if you are worried about Q-Day. Migrate to a post-quantum chain." };
}

function analyze(v, api){
  if (!v.ok) return { verdict: "invalid", title: "Invalid address", evidence: [v.error], recommendation: "Fix the address and re-run." };
  if (v.chain === "btc") return analyzeBTC(v, api);
  if (v.chain === "eth") return analyzeETH(v, api);
  if (v.chain === "qtc") return analyzeQTC(v);
  if (v.chain === "substrate") return analyzeSubstrate(v);
  return { verdict: "unknown", title: "Unknown", evidence: ["Unrecognized input."], recommendation: "" };
}

/* Portfolio summary. entries: [{v, analysis, usd}] */
function summarize(entries){
  var counts = { exposed: 0, latent: 0, clean: 0, safe: 0, unknown: 0, invalid: 0 };
  var atRisk = 0, totalVal = 0;
  entries.forEach(function(e){
    var k = counts.hasOwnProperty(e.analysis.verdict) ? e.analysis.verdict : "unknown";
    counts[k]++;
    var usd = e.usd || 0;
    totalVal += usd;
    if (k === "exposed" || k === "latent") atRisk += usd;
  });
  var score;
  if (entries.length === 0) score = null;
  else if (totalVal > 0) score = Math.round(100 * (totalVal - atRisk) / totalVal);
  else {
    var okN = counts.safe + counts.clean;
    score = Math.round(100 * okN / entries.length);
  }
  return { counts: counts, atRiskUsd: atRisk, totalUsd: totalVal, score: score,
           n: entries.length };
}

/* ============================================================
 * Illustrative sample dataset (labeled SAMPLE in the UI — not live data)
 * ============================================================ */
var SAMPLES = [
  { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    label: "Bitcoin genesis address — Satoshi, Jan 2009",
    note: "The original P2PK coinbase output. Never spent, yet the public key has been on-chain since block 0.",
    api: { spent_txo_count: 0, funded_txo_count: 24531, tx_count: 24531,
           balance_sats: 9955567890, p2pk_observed: true, p2tr_funded: false, sample: true } },
  { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    label: "Early P2PKH address — spent many times",
    note: "A famous early address. Hundreds of spends = the public key has been public for over a decade.",
    api: { spent_txo_count: 1840, funded_txo_count: 1902, tx_count: 3742,
           balance_sats: 0, p2pk_observed: false, p2tr_funded: false, sample: true } },
  { address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    label: "Fresh bech32 address — never used (BIP-173 example)",
    note: "Valid, funded never, spent never. This is what 'clean' looks like.",
    api: { spent_txo_count: 0, funded_txo_count: 0, tx_count: 0,
           balance_sats: 0, p2pk_observed: false, p2tr_funded: false, sample: true } },
  { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    label: "vitalik.eth — extremely active",
    note: "Thousands of outgoing transactions: the public key is trivially recoverable.",
    api: { n_tx: 4821, total_sent_wei: "1842000000000000000000",
           total_received_wei: "2105000000000000000000",
           balance_wei: "263000000000000000000", sample: true } },
  { address: "qzjhuX9r6CzXzH3VWUcZjd9DHZHkC26BU6CGFp49m8YjQFJDa",
    label: "Sample Quantus address (SS58, prefix 189)",
    note: "Checksum-verified locally. ML-DSA signatures — the safe end-state.",
    api: null }
];

var ExposureCore = {
  QUANTUS_PREFIX: QUANTUS_PREFIX,
  blake2b: blake2b, b58decode: b58decode, ss58Decode: ss58Decode,
  bech32Decode: bech32Decode, sha256Bytes: sha256Bytes,
  validateETH: validateETH, validateBTC: validateBTC, validateQTC: validateQTC,
  detectChain: detectChain, analyze: analyze, analyzeBTC: analyzeBTC,
  analyzeETH: analyzeETH, analyzeQTC: analyzeQTC, analyzeSubstrate: analyzeSubstrate,
  summarize: summarize, fmtBTC: fmtBTC, fmtETH: fmtETH, SAMPLES: SAMPLES
};

if (typeof window !== "undefined") window.ExposureCore = ExposureCore;
if (typeof module !== "undefined" && module.exports) module.exports = ExposureCore;
})();
