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

function loadSnapshot(){
  /* Test hook for headless QA: window.__qtcwhales_mock = full snapshot payload */
  if (typeof window !== "undefined" && window.__qtcwhales_mock){
    return Promise.resolve(window.__qtcwhales_mock);
  }
  return fetch(SNAPSHOT_URL, { cache: "no-store" }).then(function(res){
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
    DATA = d;
    if (!DATA || !DATA.ok) throw new Error("bad snapshot");
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
    QUANTUS_PREFIX: QUANTUS_PREFIX, PLANCKS_PER_QTC: PLANCKS_PER_QTC
  };
}
})();
