/* QTC Address Toolkit — logic tests. Run: node tests/ss58.test.js
 * Ground truth: blake2b vectors from Python hashlib/OpenSSL; real Quantus
 * addresses from Quantus-Network/chain genesis vesting table. */
"use strict";
var C = require("../app.js");

function hex(a){ return a.map(function(b){ return ("0" + b.toString(16)).slice(-2); }).join(""); }
function bytes(s){ var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a; }
var fails = 0;
function check(name, cond, extra){
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? " :: " + extra : ""));
  if (!cond) fails++;
}

check("blake2b('')", hex(C.blake2b([])) ===
  "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce");
check("blake2b('abc')", hex(C.blake2b(bytes("abc"))) ===
  "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");

var real = [
  "qzkmmtHL1XZ94LnDc43hTuUUW6o2jkjQBSgwSYF7Dm2JErapB", // upstream genesis vesting table
  "qzmFVMW5f48c1cBNXTzNjAn9YbLhCfohXqEgofeCn3UhJUaMw", // upstream genesis vesting table
  "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau"  // builder donation address
];
real.forEach(function(a){
  var d = C.ss58Decode(a);
  check("valid upstream address " + a.slice(0, 10) + "...",
        d.ok === true && d.prefix === 189 && d.key.length === 32,
        d.ok ? ("prefix=" + d.prefix + " key=" + d.key.length + "B") : d.error);
});

var t = real[0].split(""); t[10] = t[10] === "a" ? "b" : "a";
check("single-char tamper rejected", C.ss58Decode(t.join("")).ok === false);

var swapped = real[0].split(""); swapped[5] = "0"; // '0' is not base58
check("ambiguous char '0' rejected", C.ss58Decode(swapped.join("")).ok === false);

var key32 = C.b58decode(real[0]).slice(2, 34);
var dot = C.ss58Encode(key32, 0);
var dd = C.ss58Decode(dot);
check("wrong-prefix address still decodes (prefix 0)", dd.ok === true && dd.prefix === 0, dot);

var k = []; for (var i = 0; i < 32; i++) k.push((i * 37 + 11) & 0xff);
var enc = C.ss58Encode(k, 189);
var dec = C.ss58Decode(enc);
check("encode/decode round-trip prefix 189",
      dec.ok && dec.prefix === 189 && hex(dec.key) === hex(k), enc);
check("fromHex/toHex round-trip", C.toHex(C.fromHex("deadBEEF 0123")) === "deadbeef0123");
check("fromHex rejects odd length", C.fromHex("abc") === null);
check("empty address rejected", C.ss58Decode("").ok === false);
check("whitespace-only rejected", C.ss58Decode("   ").ok === false);

/* Quantus verdict is a relation: prefix 189 AND exactly a 32-byte key.
 * A generic SS58 string can carry prefix 189 over any key size with a
 * valid checksum — it decodes generically, but it is NOT a QTC account. */
real.forEach(function(a){
  check("isQuantusAddress(real) " + a.slice(0, 10) + "...",
        C.isQuantusAddress(C.ss58Decode(a)) === true);
});
[1, 2, 4, 8, 33].forEach(function(n){
  var kk = []; for (var i = 0; i < n; i++) kk.push((i * 37 + 11) & 0xff);
  var aa = C.ss58Encode(kk, 189);
  var dd = C.ss58Decode(aa);
  check("prefix-189 " + n + "B key decodes generically but is not a Quantus account",
        dd.ok === true && dd.prefix === 189 && dd.key.length === n &&
        C.isQuantusAddress(dd) === false, aa);
});
check("isQuantusAddress(round-trip 32B, 189) is true",
      C.isQuantusAddress(C.ss58Decode(C.ss58Encode(k, 189))) === true);
check("isQuantusAddress(prefix 0, 32B) is false",
      C.isQuantusAddress(C.ss58Decode(C.ss58Encode(k, 0))) === false);
check("isQuantusAddress(null/garbage) is false",
      C.isQuantusAddress(null) === false && C.isQuantusAddress(C.ss58Decode("nope!")) === false);

/* Reserved prefix framing: first byte top bits 10/11 are not a valid
 * SS58 prefix encoding and must not decode as a fabricated 1-byte prefix. */
[0x80, 0xc0].forEach(function(fb){
  var body = [fb]; for (var i = 0; i < 32; i++) body.push(i & 0xff);
  var hh = C.blake2b(bytes("SS58PRE").concat(body));
  var ra = C.b58encode(body.concat([hh[0], hh[1]]));
  var rd = C.ss58Decode(ra);
  check("reserved first byte 0x" + fb.toString(16) + " rejected as format",
        rd.ok === false && rd.kind === "format", ra);
});

console.log(fails === 0 ? "ALL GREEN" : fails + " FAILURES");
process.exit(fails ? 1 : 0);
