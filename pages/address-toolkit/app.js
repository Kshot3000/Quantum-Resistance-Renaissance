/* QTC Address Toolkit — SS58 codec + UI.
 * Codec validated 2026-09-29 against real upstream Quantus addresses
 * (Quantus-Network/chain genesis vesting table): prefix 189, 32-byte keys,
 * checksum = blake2b-512("SS58PRE" || prefix_bytes || key)[0..2].
 * blake2b verified byte-for-byte against Python hashlib/OpenSSL across
 * 11 inputs incl. multi-block boundaries.
 */
(function(){
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

/* ---------- UI ---------- */
function esc(s){
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function setVerdict(el, cls, title, sub){
  el.className = "verdict " + cls;
  el.innerHTML = '<div class="v-title">' + title + '</div><div class="v-sub">' + sub + "</div>";
}
function copyText(t, btn){
  function done(){
    var old = btn.innerHTML;
    btn.innerHTML = '<span class="k">copied to clipboard</span>';
    setTimeout(function(){ btn.innerHTML = old; }, 1200);
  }
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(t).then(done, done);
  else done();
}

function init(){
  var $ = function(id){ return document.getElementById(id); };

  // tabs
  var tabs = [$("tab-inspect"), $("tab-encode")];
  tabs.forEach(function(tab, i){
    tab.addEventListener("click", function(){
      tabs.forEach(function(t, j){
        t.classList.toggle("active", i === j);
        t.setAttribute("aria-selected", i === j ? "true" : "false");
      });
      $("page-inspect").hidden = i !== 0;
      $("page-encode").hidden = i !== 1;
    });
  });

  // inspect
  var inAddr = $("in-addr"), verdict = $("verdict"), dtable = $("decode-table");
  function inspect(){
    var a = inAddr.value.trim();
    dtable.hidden = true;
    dtable.innerHTML = "";
    if (!a){
      setVerdict(verdict, "idle", "Awaiting input", "Paste an address above — the verdict lands here.");
      return;
    }
    var d = ss58Decode(a);
    if (!d.ok){
      var extra = d.kind === "checksum" && d.prefix !== undefined
        ? " Detected prefix " + d.prefix + " with a " + d.keyLen + "-byte payload."
        : "";
      setVerdict(verdict, "err", "&#10007; Invalid address",
        esc(d.error) + esc(extra));
      return;
    }
    if (d.prefix !== QUANTUS_PREFIX){
      setVerdict(verdict, "warn", "&#9888; Valid SS58 — wrong network",
        "Checksum is fine, but the prefix is <strong>" + d.prefix + "</strong>, not Quantus's <strong>189</strong>. " +
        "This is an address for a different Substrate chain — do not send QTC to it.");
      renderTable(d, false);
      return;
    }
    setVerdict(verdict, "ok", "&#10003; Valid Quantus address",
      "Prefix <strong>189</strong>, checksum verified. This is a well-formed QTC mainnet address." +
      '<div class="v-key" id="v-key" title="Click to copy"><span class="k">account key (hex):</span><br>' +
      esc(toHex(d.key)) + "</div>");
    $("v-key").addEventListener("click", function(){ copyText(toHex(d.key), $("v-key")); });
    renderTable(d, true);
  }
  function renderTable(d, isQuantus){
    var rows = [
      ["network prefix", d.prefix + (isQuantus ? " — Quantus mainnet" : " — not Quantus (189)"), isQuantus],
      ["key length", d.key.length + " bytes", d.key.length === 32],
      ["checksum", "blake2b verified", true],
      ["address length", $("in-addr").value.trim().length + " chars", null]
    ];
    dtable.innerHTML = rows.map(function(r){
      var cls = r[2] === null ? "" : (r[2] ? "good" : "bad");
      return '<div class="row"><div class="kk">' + r[0] + '</div><div class="vv ' + cls + '">' + esc(String(r[1])) + "</div></div>";
    }).join("");
    dtable.hidden = false;
  }
  inAddr.addEventListener("input", inspect);
  document.querySelectorAll(".chip[data-sample]").forEach(function(ch){
    ch.addEventListener("click", function(){
      inAddr.value = ch.getAttribute("data-sample");
      inspect();
      inAddr.focus();
    });
  });

  // encode
  var inHex = $("in-hex"), inPrefix = $("in-prefix"), encOut = $("enc-out");
  function encode(){
    var key = fromHex(inHex.value);
    var prefix = parseInt(inPrefix.value, 10);
    if (!inHex.value.trim()){
      setVerdict(encOut, "idle", "Awaiting key", "Enter 64 hex characters — the SS58 address appears here.");
      return;
    }
    if (!key || !(key.length === 1 || key.length === 2 || key.length === 4 ||
                  key.length === 8 || key.length === 32 || key.length === 33)){
      setVerdict(encOut, "err", "&#10007; Bad key",
        "Enter even-length hex (valid key sizes: 1, 2, 4, 8, 32 or 33 bytes).");
      return;
    }
    if (!(prefix >= 0 && prefix < 16384)){
      setVerdict(encOut, "err", "&#10007; Bad prefix", "Prefix must be 0–16383. Quantus mainnet is 189.");
      return;
    }
    var addr = ss58Encode(key, prefix);
    var note = prefix === QUANTUS_PREFIX
      ? "Prefix 189 — a mainnet QTC address."
      : "Prefix " + prefix + " — not a Quantus mainnet address.";
    setVerdict(encOut, prefix === QUANTUS_PREFIX ? "ok" : "warn",
      (prefix === QUANTUS_PREFIX ? "&#10003; Encoded" : "&#9888; Encoded (custom prefix)"),
      esc(note) + '<div class="v-key" id="e-key" title="Click to copy">' + esc(addr) + "</div>");
    $("e-key").addEventListener("click", function(){ copyText(addr, $("e-key")); });
  }
  inHex.addEventListener("input", encode);
  inPrefix.addEventListener("input", encode);
  $("chip-rand").addEventListener("click", function(){
    var k = [];
    var rnd = new Uint8Array(32);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(rnd);
    else for (var i = 0; i < 32; i++) rnd[i] = (Math.random() * 256) | 0;
    for (var j = 0; j < 32; j++) k.push(rnd[j]);
    inHex.value = toHex(k);
    inPrefix.value = "189";
    encode();
  });

  // donation copy buttons
  document.querySelectorAll(".addr").forEach(function(b){
    b.addEventListener("click", function(){
      function done(){
        var t = b.textContent; b.textContent = "Copied!";
        setTimeout(function(){ b.textContent = t; }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(b.dataset.copy).then(done, done);
      else done();
    });
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined"){
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

/* Node test hook */
if (typeof module !== "undefined" && module.exports){
  module.exports = { blake2b: blake2b, b58encode: b58encode, b58decode: b58decode,
                     ss58Encode: ss58Encode, ss58Decode: ss58Decode,
                     toHex: toHex, fromHex: fromHex };
}
})();
