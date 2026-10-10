/* QTC Whale Watch — supply concentration & whale movements from the Subsquid indexer snapshot.
 * Reads the server-side snapshot ../../data/whales.json (the indexer allowlists only
 * explorer.quantus.com / quantus.com for browser CORS, so Pages apps read a snapshot).
 * SS58 codec below is shared with the Address Toolkit (same repo): prefix 189, 32-byte
 * keys, blake2b-512("SS58PRE" || body)[0..2] checksum — validated 2026-09-29 vs upstream.
 */
(function(){
"use strict";

/* ================= SS58 codec (shared with Address Toolkit) ================= */
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
var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s){
  for (var ci = 0; ci < s.length; ci++){
    if (ALPHABET.indexOf(s[ci]) < 0) throw { badChar: s[ci], pos: ci };
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
  return { ok: true, prefix: prefix, keyLen: key.length };
}
var QUANTUS_PREFIX = 189;

/* ================= pure helpers (unit-tested) ================= */
var PLANCKS_PER_QTC = 1000000000000; // 1e12, verified vs runtime emission formula

function plancksToQTC(p){
  var neg = false, s = String(p);
  if (s[0] === "-"){ neg = true; s = s.slice(1); }
  s = s.replace(/^0+/, "") || "0";
  var intPart, fracPart;
  if (s.length <= 12){ intPart = "0"; fracPart = ("000000000000" + s).slice(-12); }
  else { intPart = s.slice(0, s.length - 12); fracPart = s.slice(s.length - 12); }
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  fracPart = fracPart.slice(0, 6).replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (fracPart ? "." + fracPart : "");
}
function plancksNum(p){ return Number(BigInt(p)) / 1e12; }
function fmtInt(n){ return Number(n).toLocaleString("en-US"); }
function pctStr(num, den, digits){
  if (!den) return "—";
  return (100 * num / den).toFixed(digits == null ? 2 : digits) + "%";
}
function shortAddr(a, head, tail){
  head = head || 8; tail = tail == null ? 6 : tail;
  if (!a || a.length <= head + tail + 3) return a || "";
  return a.slice(0, head) + "…" + a.slice(a.length - tail);
}
function esc(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function timeAgo(iso){
  var ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return "—";
  var m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  var d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  return Math.floor(d / 30) + "mo ago";
}
/* wealth field per view mode */
function wealthOf(acct, mode){ return mode === "circ" ? acct.liquid_plancks : acct.free_plancks; }
/* cumulative share of the top n holders (planck strings) */
function topNShare(top, n, denomPlancks, mode){
  var sum = 0n, den = BigInt(denomPlancks);
  var lim = Math.min(n, top.length);
  for (var i = 0; i < lim; i++) sum += BigInt(wealthOf(top[i], mode));
  if (den === 0n) return 0;
  return Number(sum * 1000000n / den) / 10000; // 4dp percent
}
/* bracket rows adjusted for the view mode: in "circ" the locked pool is removed
 * from the whale bracket (the pool account is the only one with locked > 0). */
function bracketRows(data, mode){
  var locked = lockedPlancks(data);
  return data.brackets.map(function(b){
    var sum = BigInt(b.sum_plancks);
    if (mode === "circ" && b.key === "whale") sum -= locked;
    if (sum < 0n) sum = 0n;
    return { key: b.key, label: b.label, count: b.count, sum_plancks: sum.toString() };
  });
}
function supplyPlancks(data){
  return BigInt(data.supply_plancks.free) + BigInt(data.supply_plancks.reserved) + BigInt(data.supply_plancks.frozen);
}
function lockedPlancks(data){
  return BigInt(data.vesting.total_plancks) - BigInt(data.vesting.claimed_plancks);
}
function circPlancks(data){ return supplyPlancks(data) - lockedPlancks(data); }
/* Gini from exact top-200 + uniform-within-bracket estimates for the rest.
 * Returns { gini, estimated: true }. Groups sorted ascending. */
function giniEstimate(data, mode){
  var vals = []; // individual wealth values in QTC (floats fine for gini)
  var topSet = {};
  data.top.forEach(function(a){ topSet[a.address] = true; vals.push(plancksNum(wealthOf(a, mode))); });
  var locked = lockedPlancks(data);
  data.brackets.forEach(function(b){
    var inTop = 0, topSum = 0;
    data.top.forEach(function(a){
      var f = plancksNum(a.free_plancks);
      var lo = bracketLoQTC(b.key), hi = bracketHiQTC(b.key);
      if (f >= lo && f < hi){ inTop++; topSum += plancksNum(wealthOf(a, mode)); }
    });
    var rest = b.count - inTop;
    if (rest <= 0) return;
    var bsum = plancksNum(b.sum_plancks);
    if (mode === "circ" && b.key === "whale") bsum -= plancksNum(locked.toString());
    var restSum = Math.max(0, bsum - topSum);
    var per = restSum / rest;
    for (var i = 0; i < rest; i++) vals.push(per);
  });
  vals.sort(function(a, b){ return a - b; });
  var n = vals.length, cum = 0, total = 0, i;
  for (i = 0; i < n; i++) total += vals[i];
  if (total <= 0 || n < 2) return { gini: 0, estimated: true };
  var bSum = 0;
  for (i = 0; i < n; i++){ cum += vals[i]; bSum += cum - vals[i] / 2; }
  var gini = 1 - 2 * bSum / (n * total);
  return { gini: Math.max(0, Math.min(1, gini)), estimated: true };
}
function bracketLoQTC(key){
  return { whale: 1000, shark: 100, dolphin: 10, fish: 1, shrimp: 0.1, dust: 0 }[key];
}
function bracketHiQTC(key){
  return { whale: Infinity, shark: 1000, dolphin: 100, fish: 10, shrimp: 1, dust: 0.1 }[key];
}
function tagList(a){
  var t = [];
  if (a.is_vesting_pool) t.push('<span class="tag pool">Vesting pool · locked</span>');
  if (a.is_genesis_recipient && !a.is_vesting_pool) t.push('<span class="tag genesis">Genesis recipient</span>');
  if (a.is_genesis_recipient && a.is_vesting_pool) t.push('<span class="tag genesis">Genesis allocation</span>');
  if (a.is_multisig) t.push('<span class="tag multisig">Multisig</span>');
  if (a.is_guardian) t.push('<span class="tag guardian">Guardian</span>');
  if (a.is_high_security) t.push('<span class="tag hisec">High-security</span>');
  if (a.blocks_mined > 0) t.push('<span class="tag miner">Miner · ' + fmtInt(a.blocks_mined) + ' blocks</span>');
  return t.join("") || '<span style="color:var(--ab-dim)">—</span>';
}
function validateAddress(addr){
  var a = String(addr || "").trim();
  if (!a) return { ok: false, error: "Enter a Quantus address first." };
  var d = ss58Decode(a);
  if (!d.ok) return { ok: false, error: d.error };
  if (d.prefix !== QUANTUS_PREFIX)
    return { ok: false, error: "Valid SS58, but prefix " + d.prefix + " — not Quantus mainnet (189)." };
  if (d.keyLen !== 32)
    return { ok: false, error: "Unexpected key length (" + d.keyLen + " bytes) — Quantus uses 32-byte keys." };
  return { ok: true, address: a };
}

/* ================= UI ================= */
var SNAPSHOT_URL = "../../data/whales.json";
var EXPLORER = "https://explorer.quantus.com";
var DATA = null, MODE = "all", PAGE = 0, PER_PAGE = 25, MOVE_TAB = "all";
var $ = function(id){ return document.getElementById(id); };

/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

/* ================= load-boundary validation (2026-10-09) =================
 * The snapshot was trusted blindly except for a truthy `ok`: one top-200
 * row with free_plancks "1.5"/"oops" threw BigInt() inside renderHero and
 * killed the whole desk; a null address wedged shortAddr after the hero
 * had painted; a bracket with an unknown key or non-numeric sum made the
 * Gini/bracket renders NaN or threw; a move with a garbage amount rendered
 * literally as "0.oops" QTC; genesis_allocation missing threw in
 * renderMoves on `.to` of undefined; an unparseable fetched_at rendered
 * as "Invalid Date". Now the whole payload is validated BEFORE DATA is
 * assigned: core aggregates (supply, vesting, brackets) must be fully
 * valid or the snapshot fails honestly; row collections (top, moves,
 * genesis) drop invalid entries individually, top is re-sorted by free
 * balance and re-ranked from the survivors, and every renderer downstream
 * can rely on pure-digit plancks, valid prefix-189 addresses, liquid ==
 * free - locked, claimed <= vesting total, and a parseable fetched_at.
 * Round 2 (2026-10-10): per-field shapes were not a boundary — the desk
 * still broke on RELATIONS between fields. Now also enforced: brackets
 * partition the accounts (six canonical keys, counts sum to
 * accounts_total, sums sum to supply.free, each bracket's average inside
 * its own band); the vesting-pool identity (one locker at most, flagged
 * as the pool, its locked == vesting total - claimed to the planck, and
 * the pool is the block-1 allocation recipient); the whale bracket
 * agrees with the top list in count and summed free; the top list cannot
 * outweigh the supply; block_height is a plausible chain height;
 * fetched_at is a real capture time (not pre-genesis, not future); moves
 * cannot postdate their snapshot and "recent" moves owe the tab's
 * >= 10 QTC / 7-day contract; genesis rows sit at block 1 from a single
 * mint origin; a present-but-malformed reserved/frozen drops its row
 * instead of silently becoming "0". */
function decStr(v){
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) return BigInt(v).toString();
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}
function nonNegInt(v){
  var s = decStr(v);
  if (s === null) return null;
  var n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
function validAddr(a){ return typeof a === "string" && validateAddress(a).ok; }
var BRACKET_KEYS = { whale: 1, shark: 1, dolphin: 1, fish: 1, shrimp: 1, dust: 1 };
var MAX_SUPPLY_PLANCKS = 21000000n * 1000000000000n; // 21M QTC cap

function cleanTopEntry(raw, seen){
  if (!raw || typeof raw !== "object") return null;
  if (!validAddr(raw.address) || seen[raw.address]) return null;
  var free = decStr(raw.free_plancks), locked = decStr(raw.locked_plancks), liquid = decStr(raw.liquid_plancks);
  if (free === null || locked === null || liquid === null) return null;
  if (BigInt(locked) > BigInt(free)) return null;
  if (BigInt(liquid) !== BigInt(free) - BigInt(locked)) return null; // the circ view assumes this identity
  // reserved/frozen: absent defaults to "0", but a PRESENT malformed value
  // drops the row (round 2) — silently zeroing it hid snapshot corruption.
  var res = raw.reserved_plancks == null ? "0" : decStr(raw.reserved_plancks);
  var fro = raw.frozen_plancks == null ? "0" : decStr(raw.frozen_plancks);
  if (res === null || fro === null) return null;
  seen[raw.address] = true;
  var bm = nonNegInt(raw.blocks_mined);
  return {
    rank: 0, address: raw.address, free_plancks: free,
    reserved_plancks: res,
    frozen_plancks: fro,
    locked_plancks: locked, liquid_plancks: liquid,
    is_vesting_pool: raw.is_vesting_pool === true,
    is_genesis_recipient: raw.is_genesis_recipient === true,
    is_multisig: raw.is_multisig === true,
    is_guardian: raw.is_guardian === true,
    is_high_security: raw.is_high_security === true,
    blocks_mined: bm // null when malformed — tagList/lookup render it as absent, never NaN
  };
}
var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // chain genesis was 2026-09-09
var RECENT_MIN_PLANCKS = 10000000000000n; // 10 QTC — the recent tab's printed contract
var RECENT_WINDOW_MS = 7 * 86400000;
function cleanMove(raw, maxHeight, fetchedMs, isRecent){
  if (!raw || typeof raw !== "object") return null;
  var amount = decStr(raw.amount);
  if (amount === null || BigInt(amount) <= 0n) return null;
  var fee = raw.fee == null ? "0" : decStr(raw.fee);
  if (fee === null) return null;
  var from = raw.from_id == null ? null : raw.from_id;
  if (from !== null && from !== "0".repeat(48) && !validAddr(from)) return null;
  if (!validAddr(raw.to_id)) return null;
  var bh = nonNegInt(raw.block_height);
  if (bh === null || bh < 1 || bh > maxHeight) return null; // a move "from the future" is not this snapshot's data
  if (typeof raw.timestamp !== "string" || !isFinite(Date.parse(raw.timestamp))) return null;
  var tsMs = Date.parse(raw.timestamp);
  // Round 2: a move cannot postdate the snapshot that contains it, nor
  // predate the chain; the "recent" feed additionally owes its printed
  // contract — >= 10 QTC within the last 7 days of the snapshot.
  if (tsMs > fetchedMs + 300000 || tsMs < GENESIS_FLOOR_MS) return null;
  if (isRecent && (BigInt(amount) < RECENT_MIN_PLANCKS || tsMs < fetchedMs - RECENT_WINDOW_MS - 3600000)) return null;
  return { amount: amount, fee: fee, from_id: from, to_id: raw.to_id, block_height: bh, timestamp: raw.timestamp };
}
var BRACKET_BOUNDS = { // planck band [lo, hi) per bracket, from fetch-whale-data.mjs
  whale: [1000000000000000n, null], shark: [100000000000000n, 1000000000000000n],
  dolphin: [10000000000000n, 100000000000000n], fish: [1000000000000n, 10000000000000n],
  shrimp: [100000000000n, 1000000000000n], dust: [0n, 100000000000n]
};
var WHALE_LO_PLANCKS = 1000000000000000n; // 1,000 QTC
function validBlockHeight(v){ // fleet shape (vesting round 2): plausible chain heights only
  var n = nonNegInt(v);
  return (n !== null && n >= 1 && n <= 10000000) ? n : null;
}
function validateSnapshot(raw){
  if (!raw || typeof raw !== "object" || raw.ok !== true) return null;
  if (typeof raw.fetched_at !== "string" || !isFinite(Date.parse(raw.fetched_at))) return null;
  var fetchedMs = Date.parse(raw.fetched_at);
  // Round 2: provenance must be a real capture time — not before the chain
  // existed, not in the future (a future fetched_at defeats the staleness
  // warning and the recent-move window alike).
  if (fetchedMs < GENESIS_FLOOR_MS || fetchedMs > Date.now() + 3600000) return null;
  var height = validBlockHeight(raw.block_height);
  if (height === null) return null;
  var accounts = nonNegInt(raw.accounts_total), transfers = nonNegInt(raw.transfers_total);
  if (accounts === null || transfers === null) return null;
  if (!raw.supply_plancks || typeof raw.supply_plancks !== "object") return null;
  var sFree = decStr(raw.supply_plancks.free), sRes = decStr(raw.supply_plancks.reserved), sFro = decStr(raw.supply_plancks.frozen);
  if (sFree === null || sRes === null || sFro === null) return null;
  var supplyTotal = BigInt(sFree) + BigInt(sRes) + BigInt(sFro);
  if (supplyTotal <= 0n || supplyTotal > MAX_SUPPLY_PLANCKS) return null;
  if (!raw.vesting || typeof raw.vesting !== "object") return null;
  var vSched = nonNegInt(raw.vesting.schedules), vTotal = decStr(raw.vesting.total_plancks), vClaimed = decStr(raw.vesting.claimed_plancks);
  if (vSched === null || vTotal === null || vClaimed === null) return null;
  if (BigInt(vClaimed) > BigInt(vTotal)) return null;
  if (BigInt(vTotal) - BigInt(vClaimed) > supplyTotal) return null; // locked cannot exceed the supply it sits in
  if (BigInt(vTotal) > supplyTotal) return null; // round 2: locked + claimed both sit inside the supply
  // Brackets are aggregates this page cannot rebuild (they cover all
  // accounts, not just the top 200) — any malformed bracket fails the
  // snapshot honestly rather than displaying a partial distribution.
  // Round 2: brackets are a PARTITION of the indexed accounts, so the six
  // canonical keys must all be present, counts must sum to accounts_total,
  // sums must sum to supply.free exactly (brackets are computed on free),
  // and each bracket's average must sit inside its own [lo, hi) band.
  if (!Array.isArray(raw.brackets) || raw.brackets.length !== 6) return null;
  var seenKeys = {}, brackets = [], bracketCountSum = 0, bracketSumTotal = 0n;
  for (var i = 0; i < raw.brackets.length; i++){
    var b = raw.brackets[i];
    if (!b || typeof b !== "object" || !BRACKET_KEYS[b.key] || seenKeys[b.key]) return null;
    if (typeof b.label !== "string" || !b.label) return null;
    var bCount = nonNegInt(b.count), bSum = decStr(b.sum_plancks);
    if (bCount === null || bSum === null) return null;
    var band = BRACKET_BOUNDS[b.key], bSumB = BigInt(bSum);
    if (bSumB < BigInt(bCount) * band[0]) return null;
    if (band[1] !== null && bSumB >= BigInt(bCount) * band[1]) return null;
    seenKeys[b.key] = true;
    bracketCountSum += bCount;
    bracketSumTotal += bSumB;
    brackets.push({ key: b.key, label: b.label, count: bCount, sum_plancks: bSum });
  }
  if (bracketCountSum !== accounts || bracketSumTotal !== BigInt(sFree)) return null;
  if (!Array.isArray(raw.top)) return null;
  if (raw.top.length > 200 || raw.top.length > accounts) return null; // the fetcher caps the list at TOP_N = 200
  var seenAddr = {}, top = [];
  raw.top.forEach(function(r){ var e = cleanTopEntry(r, seenAddr); if (e) top.push(e); });
  if (!top.length) return null;
  top.sort(function(a, b){
    var x = BigInt(a.free_plancks), y = BigInt(b.free_plancks);
    return x < y ? 1 : x > y ? -1 : 0;
  });
  top.forEach(function(e, idx){ e.rank = idx + 1; }); // rank is derived — rebuild it from the survivors
  // Round 2 cross-checks between the cleaned top list and the aggregates:
  var topFreeSum = 0n, lockedSum = 0n, lockers = 0, poolEntry = null;
  top.forEach(function(e){
    topFreeSum += BigInt(e.free_plancks);
    lockedSum += BigInt(e.locked_plancks);
    if (BigInt(e.locked_plancks) > 0n) lockers++;
    if (e.is_vesting_pool) poolEntry = e;
  });
  if (topFreeSum > BigInt(sFree)) return null; // the part cannot exceed the whole
  // The pool identity the circ view is built on (fetch-whale-data.mjs):
  // exactly the pool account carries locked, and its locked equals the
  // unclaimed vesting balance to the planck. A split or short locker made
  // every circulating figure quietly wrong while each row looked valid.
  if (lockedSum !== BigInt(vTotal) - BigInt(vClaimed)) return null;
  if (lockers > 1) return null;
  if (lockers === 1 && !top.some(function(e){ return BigInt(e.locked_plancks) > 0n && e.is_vesting_pool; })) return null;
  // The whale bracket must agree with the top list wherever the list can
  // see every whale: count and summed free of the >= 1,000 QTC entries.
  var whaleBracket = brackets.filter(function(x){ return x.key === "whale"; })[0];
  if (whaleBracket.count <= top.length){
    var inTopWhales = top.filter(function(e){ return BigInt(e.free_plancks) >= WHALE_LO_PLANCKS; });
    var inTopWhaleSum = 0n;
    inTopWhales.forEach(function(e){ inTopWhaleSum += BigInt(e.free_plancks); });
    if (inTopWhales.length !== whaleBracket.count || inTopWhaleSum !== BigInt(whaleBracket.sum_plancks)) return null;
  }
  if (!Array.isArray(raw.whale_moves_alltime) || !Array.isArray(raw.whale_moves_recent)) return null;
  function cleanMoves(list, isRecent){
    var out = [];
    list.forEach(function(m){ var c = cleanMove(m, height, fetchedMs, isRecent); if (c) out.push(c); });
    return out;
  }
  var genesis = [];
  if (Array.isArray(raw.genesis_allocation)){
    var mintFrom = null;
    raw.genesis_allocation.forEach(function(g){
      if (!g || typeof g !== "object") return;
      var amt = decStr(g.amount_plancks), bh = nonNegInt(g.block_height);
      if (amt === null || BigInt(amt) <= 0n || BigInt(amt) > supplyTotal) return;
      if (bh !== 1) return; // round 2: genesis allocations live at block 1, by definition
      if (!(g.from === "0".repeat(48) || validAddr(g.from)) || !validAddr(g.to)) return; // genesis origin may be the mint sentinel
      if (g.from === g.to) return;
      if (mintFrom === null) mintFrom = g.from;
      if (g.from !== mintFrom) return; // one mint origin for the whole allocation list
      if (typeof g.timestamp !== "string" || !isFinite(Date.parse(g.timestamp))) return;
      var gts = Date.parse(g.timestamp);
      if (gts > fetchedMs + 300000 || gts < GENESIS_FLOOR_MS) return;
      genesis.push({ amount_plancks: amt, from: g.from, to: g.to, block_height: bh, timestamp: g.timestamp });
    });
  }
  // Round 2: the pool account IS the block-1 allocation recipient — if the
  // snapshot names both, they must name the same account.
  if (poolEntry && genesis.length && poolEntry.address !== genesis[0].to) return null;
  return {
    ok: true, source: typeof raw.source === "string" ? raw.source : "",
    fetched_at: raw.fetched_at, block_height: height,
    accounts_total: accounts, transfers_total: transfers,
    supply_plancks: { free: sFree, reserved: sRes, frozen: sFro },
    mined_plancks: decStr(raw.mined_plancks) || "0",
    vesting: { schedules: vSched, total_plancks: vTotal, claimed_plancks: vClaimed },
    genesis_allocation: genesis, brackets: brackets, top: top,
    whale_moves_alltime: cleanMoves(raw.whale_moves_alltime, false),
    whale_moves_recent: cleanMoves(raw.whale_moves_recent, true),
    params: raw.params && typeof raw.params === "object" ? raw.params : {}
  };
}

function loadSnapshot(){
  /* Test hook for headless QA: window.__qtcwhales_mock = full snapshot payload */
  if (typeof window !== "undefined" && window.__qtcwhales_mock){
    return Promise.resolve(window.__qtcwhales_mock);
  }
  return fetch(SNAPSHOT_URL, { cache: "no-store", signal: timeoutSignal(9000) }).then(function(res){
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}
function toast(msg){
  var el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(function(){ el.classList.remove("show"); }, 2200);
}
function copyText(txt, label){
  function done(){ toast((label || "Copied") + " to clipboard"); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done, function(){ fallback(); });
  } else fallback();
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e){ toast("Copy failed — select manually"); }
    document.body.removeChild(ta);
  }
}
function addrCell(a, full){
  return '<span class="addr"><a class="acct" href="../block-explorer/#/account/' + esc(a) + '" title="Open in Builder Block Explorer">' +
    esc(full ? a : shortAddr(a)) + '</a>' +
    '<button class="mini" data-copy="' + esc(a) + '" title="Copy full address">copy</button></span>';
}
function denom(mode, data){
  return (mode === "circ" ? circPlancks(data) : supplyPlancks(data)).toString();
}
function modeWord(){ return MODE === "circ" ? "circulating" : "supply"; }

function renderHero(){
  var fetched = new Date(DATA.fetched_at);
  $("snap-height").textContent = "⛓ block " + fmtInt(DATA.block_height);
  $("snap-time").textContent = "◷ snapshot " + timeAgo(DATA.fetched_at);
  $("foot-time").textContent = fetched.toLocaleString();
  var stale = (Date.now() - fetched.getTime()) > 12 * 3600 * 1000;
  $("snap-stale").hidden = !stale;

  var supply = supplyPlancks(DATA), locked = lockedPlancks(DATA), circ = circPlancks(DATA);
  $("st-supply").textContent = plancksToQTC(supply.toString());
  $("st-locked").textContent = plancksToQTC(locked.toString());
  $("st-locked-sub").textContent = pctStr(Number(locked), Number(supply)) + " of indexed supply · " +
    fmtInt(DATA.vesting.schedules) + " schedules";
  $("st-circ").textContent = plancksToQTC(circ.toString());
  $("st-accts").textContent = fmtInt(DATA.accounts_total);
  $("st-accts-sub").textContent = fmtInt(DATA.transfers_total) + " transfers indexed";
  $("st-vest").textContent = fmtInt(DATA.vesting.schedules);
  $("st-vest-sub").textContent = plancksToQTC(DATA.vesting.claimed_plancks) + " claimed of " +
    plancksToQTC(DATA.vesting.total_plancks);
  var t10 = topNShare(DATA.top, 10, denom(MODE, DATA), MODE);
  $("st-top10").textContent = t10.toFixed(2) + "%";
  $("st-top10-sub").textContent = MODE === "circ"
    ? "top-10 liquid holders of circulating"
    : "top-10 holders of indexed supply";

  var lpct = Number(locked * 10000n / supply) / 100;
  $("seg-locked").style.width = lpct.toFixed(2) + "%";
  $("seg-circ").style.width = (100 - lpct).toFixed(2) + "%";
  $("leg-locked").textContent = "Locked vesting " + pctStr(Number(locked), Number(supply));
  $("leg-circ").textContent = "Circulating " + pctStr(Number(circ), Number(supply));

  Array.prototype.forEach.call(document.querySelectorAll(".mode-word"), function(el){
    el.textContent = modeWord();
  });
}

function renderCurve(){
  var cv = $("curve"), ctx = cv.getContext("2d");
  var W = cv.width, H = cv.height, padL = 44, padB = 30, padT = 14, padR = 12;
  ctx.clearRect(0, 0, W, H);
  var ns = [1, 5, 10, 25, 50, 100, 200];
  var shares = ns.map(function(n){ return topNShare(DATA.top, n, denom(MODE, DATA), MODE); });
  var maxY = Math.max(100, Math.ceil(Math.max.apply(null, shares) / 10) * 10);
  function X(i){ return padL + (W - padL - padR) * (i / (ns.length - 1)); }
  function Y(v){ return H - padB - (H - padB - padT) * (v / maxY); }
  ctx.strokeStyle = "rgba(125,143,179,.25)"; ctx.fillStyle = "#7d8fb3";
  ctx.font = "10px JetBrains Mono, monospace"; ctx.lineWidth = 1;
  [0, 25, 50, 75, 100].forEach(function(g){
    if (g > maxY) return;
    ctx.beginPath(); ctx.moveTo(padL, Y(g)); ctx.lineTo(W - padR, Y(g)); ctx.stroke();
    ctx.fillText(g + "%", 6, Y(g) + 3);
  });
  // area + line
  var grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, "rgba(34,211,238,.35)"); grad.addColorStop(1, "rgba(34,211,238,0)");
  ctx.beginPath(); ctx.moveTo(X(0), Y(shares[0]));
  shares.forEach(function(s, i){ ctx.lineTo(X(i), Y(s)); });
  ctx.lineTo(X(ns.length - 1), H - padB); ctx.lineTo(X(0), H - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); shares.forEach(function(s, i){ i ? ctx.lineTo(X(i), Y(s)) : ctx.moveTo(X(i), Y(s)); });
  ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 2.5;
  ctx.shadowColor = "rgba(34,211,238,.7)"; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = "#22d3ee";
  shares.forEach(function(s, i){
    ctx.beginPath(); ctx.arc(X(i), Y(s), 4, 0, 7); ctx.fill();
    ctx.fillStyle = "#7d8fb3";
    ctx.fillText("top " + ns[i], X(i) - 14, H - 10);
    ctx.fillStyle = "#22d3ee";
  });
  var read = ns.map(function(n, i){ return "top " + n + ": " + shares[i].toFixed(1) + "%"; }).join(" · ");
  $("curve-read").textContent = read + " — of " + modeWord();
  var g = giniEstimate(DATA, MODE);
  $("gini").textContent = g.gini.toFixed(4);
  $("gini-note").textContent = MODE === "circ"
    ? "Circulating view: the locked vesting pool is excluded."
    : "All-QTC view: dominated by the single locked vesting pool.";
}

function renderBrackets(){
  var rows = bracketRows(DATA, MODE);
  var den = Number(MODE === "circ" ? circPlancks(DATA) : supplyPlancks(DATA));
  var maxSum = Math.max.apply(null, rows.map(function(r){ return Number(BigInt(r.sum_plancks)); }));
  var tb = $("bracket-table").querySelector("tbody");
  tb.innerHTML = rows.map(function(r){
    var sum = Number(BigInt(r.sum_plancks));
    var w = maxSum > 0 ? (100 * sum / maxSum) : 0;
    return "<tr><td>" + esc(r.label) + "</td>" +
      '<td class="num">' + fmtInt(r.count) + "</td>" +
      '<td class="num">' + plancksToQTC(r.sum_plancks) + "</td>" +
      '<td class="num">' + pctStr(sum, den) + "</td>" +
      '<td class="barcol"><div class="bbar" style="width:' + Math.max(1.5, w).toFixed(1) + '%"></div></td></tr>';
  }).join("");
}

function filteredTop(){
  var q = ($("rl-search").value || "").trim().toLowerCase();
  var sortKey = $("rl-sort").value;
  var rows = DATA.top.slice();
  if (q) rows = rows.filter(function(a){ return a.address.toLowerCase().indexOf(q) >= 0; });
  rows.sort(function(a, b){
    var x = BigInt(wealthOf(a, sortKey === "liquid" ? "circ" : "all"));
    var y = BigInt(wealthOf(b, sortKey === "liquid" ? "circ" : "all"));
    return x < y ? 1 : x > y ? -1 : 0;
  });
  return rows;
}
function renderRich(){
  var rows = filteredTop();
  var pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  if (PAGE >= pages) PAGE = pages - 1;
  var slice = rows.slice(PAGE * PER_PAGE, (PAGE + 1) * PER_PAGE);
  var den = denom(MODE, DATA);
  var tb = $("rich-table").querySelector("tbody");
  if (!slice.length){
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--ab-dim);padding:26px">No addresses match — try a different search.</td></tr>';
  } else {
    tb.innerHTML = slice.map(function(a){
      var share = topNShare([a], 1, den, MODE);
      var locked = BigInt(a.locked_plancks);
      return "<tr><td class='num'>" + a.rank + "</td><td>" + addrCell(a.address) + "</td>" +
        '<td class="num">' + plancksToQTC(a.free_plancks) + "</td>" +
        '<td class="num">' + (locked > 0n ? plancksToQTC(a.locked_plancks) : "—") + "</td>" +
        '<td class="num"><strong>' + plancksToQTC(a.liquid_plancks) + "</strong></td>" +
        '<td class="num">' + share.toFixed(3) + "%</td>" +
        "<td>" + tagList(a) + "</td></tr>";
    }).join("");
  }
  $("pg-info").textContent = "page " + (PAGE + 1) + " / " + pages + " · " + fmtInt(rows.length) + " accounts";
  $("pg-prev").disabled = PAGE <= 0;
  $("pg-next").disabled = PAGE >= pages - 1;
}

function moveRow(m, genesisAddr){
  var isGenesis = genesisAddr && m.to_id === genesisAddr && m.block_height === 1;
  var from = (m.from_id && m.from_id !== "0".repeat(48))
    ? addrCell(m.from_id)
    : '<span style="color:var(--ab-dim)">— mint</span>';
  return '<tr class="' + (isGenesis ? "genesis-row" : "") + '">' +
    '<td class="num"><strong>' + plancksToQTC(m.amount) + "</strong>" +
    (isGenesis ? ' <span class="tag genesis">genesis allocation</span>' : "") + "</td>" +
    "<td>" + from + "</td><td>" + addrCell(m.to_id) + "</td>" +
    '<td class="num"><a class="acct" href="' + EXPLORER + "/blocks/" + m.block_height +
    '" target="_blank" rel="noopener">' + fmtInt(m.block_height) + "</a></td>" +
    "<td>" + timeAgo(m.timestamp) + "</td>" +
    '<td class="num">' + plancksToQTC(m.fee || "0") + "</td></tr>";
}
function renderMoves(){
  var list = MOVE_TAB === "all" ? DATA.whale_moves_alltime : DATA.whale_moves_recent;
  var genesisAddr = (DATA.genesis_allocation[0] && DATA.genesis_allocation[0].to) || null;
  var tb = $("moves-table").querySelector("tbody");
  tb.innerHTML = list.length
    ? list.map(function(m){ return moveRow(m, genesisAddr); }).join("")
    : '<tr><td colspan="6" style="text-align:center;color:var(--ab-dim);padding:26px">No transfers in this feed.</td></tr>';
}

function renderLookup(){
  // (re)bind once
}
function doLookup(){
  var box = $("lk-result");
  var v = validateAddress($("lk-input").value);
  if (!v.ok){
    box.innerHTML = '<div class="lk-card err"><h4>⚠ Not a valid lookup</h4><p class="fine" style="margin:0">' +
      esc(v.error) + "</p></div>";
    return;
  }
  var addr = v.address;
  var acct = null;
  for (var i = 0; i < DATA.top.length; i++) if (DATA.top[i].address === addr){ acct = DATA.top[i]; break; }
  var seenMoves = [];
  ["whale_moves_alltime", "whale_moves_recent"].forEach(function(k){
    (DATA[k] || []).forEach(function(m){
      if (m.from_id === addr || m.to_id === addr) seenMoves.push(m);
    });
  });
  if (acct){
    var den = denom(MODE, DATA);
    var share = topNShare([acct], 1, den, MODE);
    box.innerHTML = '<div class="lk-card"><h4>🐋 Rank #' + acct.rank + " of " + fmtInt(DATA.top.length) +
      " tracked accounts</h4>" + addrCell(addr, true) +
      '<div class="lk-grid">' +
      '<div><div class="k">Total</div><div class="v">' + plancksToQTC(acct.free_plancks) + " QTC</div></div>" +
      '<div><div class="k">Liquid</div><div class="v">' + plancksToQTC(acct.liquid_plancks) + " QTC</div></div>" +
      '<div><div class="k">Share of ' + esc(modeWord()) + "</div><div class='v'>" + share.toFixed(3) + "%</div></div>" +
      '<div><div class="k">Blocks mined</div><div class="v">' +
      (acct.blocks_mined == null ? "n/a" : fmtInt(acct.blocks_mined)) + "</div></div>" +
      "</div><div>" + tagList(acct) + "</div></div>";
  } else if (seenMoves.length){
    box.innerHTML = '<div class="lk-card"><h4>✓ Valid Quantus address — outside the top 200</h4>' +
      addrCell(addr, true) +
      '<p class="fine">This address appears in ' + seenMoves.length +
      " whale movement(s) but holds less than the top-200 cutoff, so its balance isn't in this snapshot. " +
      'See its full history in the <a href="../block-explorer/#/account/' + esc(addr) + '">Block Explorer</a>.</p></div>';
  } else {
    box.innerHTML = '<div class="lk-card"><h4>✓ Valid Quantus address — not in this snapshot</h4>' +
      addrCell(addr, true) +
      '<p class="fine">This snapshot covers the top 200 accounts plus every address in the whale-movement feeds. ' +
      "This address isn't among them — it's a smaller holder. " +
      'Look it up in the <a href="../block-explorer/#/account/' + esc(addr) + '">Block Explorer</a>.</p></div>';
  }
}

function renderAll(){
  renderHero();
  renderCurve();
  renderBrackets();
  renderRich();
  renderMoves();
}

function bind(){
  Array.prototype.forEach.call(document.querySelectorAll(".mode-btn"), function(b){
    b.addEventListener("click", function(){
      MODE = b.getAttribute("data-mode");
      PAGE = 0;
      Array.prototype.forEach.call(document.querySelectorAll(".mode-btn"), function(x){
        var on = x === b;
        x.classList.toggle("active", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderAll();
    });
  });
  $("rl-search").addEventListener("input", function(){ PAGE = 0; renderRich(); });
  $("rl-sort").addEventListener("change", function(){ PAGE = 0; renderRich(); });
  $("pg-prev").addEventListener("click", function(){ if (PAGE > 0){ PAGE--; renderRich(); } });
  $("pg-next").addEventListener("click", function(){ PAGE++; renderRich(); });
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(t){
    t.addEventListener("click", function(){
      MOVE_TAB = t.getAttribute("data-tab");
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(x){
        var on = x === t;
        x.classList.toggle("active", on);
        x.setAttribute("aria-selected", on ? "true" : "false");
      });
      renderMoves();
    });
  });
  $("lk-go").addEventListener("click", doLookup);
  $("lk-input").addEventListener("keydown", function(e){ if (e.key === "Enter") doLookup(); });
  document.addEventListener("click", function(e){
    var b = e.target.closest("[data-copy]");
    if (b){ copyText(b.getAttribute("data-copy"), "Address"); }
  });
  abyss();
}

/* ambient abyss: slow bioluminescent particles drifting upward */
function abyss(){
  var cv = $("abyss");
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext("2d"), W, H, ps = [];
  function size(){ W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
  size(); window.addEventListener("resize", size);
  for (var i = 0; i < 70; i++) ps.push({
    x: Math.random(), y: Math.random(), r: .6 + Math.random() * 2.2,
    s: .0004 + Math.random() * .0012, o: .15 + Math.random() * .5, ph: Math.random() * 6.28
  });
  var whale = { x: 1.2, y: .3, s: .0006 };
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function tick(){
    ctx.clearRect(0, 0, W, H);
    var t = Date.now() / 1000, i, p;
    for (i = 0; i < ps.length; i++){
      p = ps[i];
      p.y -= p.s; if (p.y < -0.02){ p.y = 1.02; p.x = Math.random(); }
      var tw = p.o * (0.6 + 0.4 * Math.sin(t * 1.4 + p.ph));
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, p.r, 0, 7);
      ctx.fillStyle = "rgba(34,211,238," + tw.toFixed(3) + ")";
      ctx.shadowColor = "rgba(34,211,238,.8)"; ctx.shadowBlur = 8;
      ctx.fill(); ctx.shadowBlur = 0;
    }
    // distant whale silhouette gliding across
    whale.x -= whale.s;
    if (whale.x < -0.4){ whale.x = 1.3; whale.y = 0.15 + Math.random() * 0.5; }
    var wx = whale.x * W, wy = whale.y * H + Math.sin(t * .7) * 14;
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = "#164e63";
    ctx.font = Math.round(Math.min(W, H) * 0.09) + "px serif";
    ctx.fillText("🐋", wx, wy);
    ctx.restore();
    if (!REDUCE_MOTION) requestAnimationFrame(tick);
  })();
}

function boot(){
  loadSnapshot().then(function(d){
    DATA = validateSnapshot(d); // null unless every core field checks out — never render poison
    if (!DATA) throw new Error("bad snapshot");
    bind();
    renderAll();
  }).catch(function(e){
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      '<div class="card" style="max-width:1180px;margin:30px auto;padding:22px">' +
      "<h3>Snapshot unavailable</h3>" +
      '<p class="fine">Could not load the whale snapshot (' + esc(e.message || e) +
      "). The indexer snapshot refreshes hourly — please try again later.</p></div>");
  });
}
if (typeof document !== "undefined") boot();

/* node exports for unit tests */
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    plancksToQTC: plancksToQTC, plancksNum: plancksNum, fmtInt: fmtInt, pctStr: pctStr,
    shortAddr: shortAddr, esc: esc, timeAgo: timeAgo, wealthOf: wealthOf,
    topNShare: topNShare, bracketRows: bracketRows, supplyPlancks: supplyPlancks,
    lockedPlancks: lockedPlancks, circPlancks: circPlancks, giniEstimate: giniEstimate,
    bracketLoQTC: bracketLoQTC, bracketHiQTC: bracketHiQTC, tagList: tagList,
    validateAddress: validateAddress, ss58Decode: ss58Decode, ss58Encode: ss58Encode,
    validateSnapshot: validateSnapshot, validBlockHeight: validBlockHeight,
    QUANTUS_PREFIX: QUANTUS_PREFIX, PLANCKS_PER_QTC: PLANCKS_PER_QTC
  };
}
})();
