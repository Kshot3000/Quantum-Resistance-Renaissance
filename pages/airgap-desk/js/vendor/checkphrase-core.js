/* QTC SafeSend Lab — checkphrase core.
 *
 * Implements the address checkphrase algorithm from the upstream reference
 * Quantus-Network/qp-human-checkphrase (js/src/index.ts), byte-for-byte
 * compatible: PBKDF2-HMAC-SHA256(password = address string as UTF-8,
 * salt = "human-readable-checksum", 40000 iterations, 7-byte key), then the
 * first 55 bits of the big-endian key split into five 11-bit indices into the
 * 2048-word list.
 *
 * Validated against all 1,171 vectors in upstream test-vectors/checksums.json
 * (see tests/run-tests.mjs) — 1171/1171 must pass before release.
 *
 * Environment-agnostic: runs in the browser (script tag) and Node (require).
 */
(function (global) {
"use strict";

/* ---------- UTF-8 ---------- */
function utf8Bytes(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  var out = [], i, c;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

/* ---------- SHA-256 (FIPS 180-4) ---------- */
var K256 = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

function sha256Bytes(msg) {
  var ml = msg.length, bitLenHi = Math.floor((ml * 8) / 0x100000000), bitLenLo = (ml * 8) >>> 0;
  var padded = Math.ceil((ml + 9) / 64) * 64;
  var m = new Uint8Array(padded);
  m.set(msg);
  m[ml] = 0x80;
  var dv = new DataView(m.buffer);
  dv.setUint32(padded - 8, bitLenHi);
  dv.setUint32(padded - 4, bitLenLo);
  var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
      h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  var w = new Uint32Array(64), a,b,c,d,e,f,g,hh,t1,t2,s0,s1,ch,maj,i,j;
  for (i = 0; i < padded; i += 64) {
    for (j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (j = 16; j < 64; j++) {
      s0 = ((w[j-15]>>>7)|(w[j-15]<<25))^((w[j-15]>>>18)|(w[j-15]<<14))^(w[j-15]>>>3);
      s1 = ((w[j-2]>>>17)|(w[j-2]<<15))^((w[j-2]>>>19)|(w[j-2]<<13))^(w[j-2]>>>10);
      w[j] = (w[j-16]+s0+w[j-7]+s1)|0;
    }
    a=h0;b=h1;c=h2;d=h3;e=h4;f=h5;g=h6;hh=h7;
    for (j = 0; j < 64; j++) {
      s1 = ((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      ch = (e&f)^(~e&g);
      t1 = (hh+s1+ch+K256[j]+w[j])|0;
      s0 = ((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      maj = (a&b)^(a&c)^(b&c);
      t2 = (s0+maj)|0;
      hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;
    h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+hh)|0;
  }
  var out = new Uint8Array(32), hv=[h0,h1,h2,h3,h4,h5,h6,h7];
  for (i = 0; i < 8; i++) {
    out[i*4]=(hv[i]>>>24)&0xff; out[i*4+1]=(hv[i]>>>16)&0xff;
    out[i*4+2]=(hv[i]>>>8)&0xff; out[i*4+3]=hv[i]&0xff;
  }
  return out;
}

function hmacSha256(keyBytes, msgBytes) {
  var k = keyBytes;
  if (k.length > 64) k = sha256Bytes(k);
  var kp = new Uint8Array(64); kp.set(k);
  var ipad = new Uint8Array(64), opad = new Uint8Array(64), i;
  for (i = 0; i < 64; i++) { ipad[i] = kp[i] ^ 0x36; opad[i] = kp[i] ^ 0x5c; }
  var inner = new Uint8Array(64 + msgBytes.length);
  inner.set(ipad); inner.set(msgBytes, 64);
  var outer = new Uint8Array(64 + 32);
  outer.set(opad); outer.set(sha256Bytes(inner), 64);
  return sha256Bytes(outer);
}

/* ---------- PBKDF2-HMAC-SHA256 ---------- */
function pbkdf2Block(pw, salt, iterations, blockIndex) {
  var be = new Uint8Array(4);
  be[0]=(blockIndex>>>24)&0xff; be[1]=(blockIndex>>>16)&0xff;
  be[2]=(blockIndex>>>8)&0xff; be[3]=blockIndex&0xff;
  var msg = new Uint8Array(salt.length + 4);
  msg.set(salt); msg.set(be, salt.length);
  var u = hmacSha256(pw, msg), t = u.slice(), i, j;
  for (i = 1; i < iterations; i++) {
    u = hmacSha256(pw, u);
    for (j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}

function pbkdf2HmacSha256(pwBytes, saltBytes, iterations, keyLen) {
  var out = new Uint8Array(keyLen), blocks = Math.ceil(keyLen / 32), b, i;
  for (b = 1; b <= blocks; b++) {
    var blk = pbkdf2Block(pwBytes, saltBytes, iterations, b);
    var off = (b - 1) * 32, n = Math.min(32, keyLen - off);
    for (i = 0; i < n; i++) out[off + i] = blk[i];
  }
  return out;
}

/* Chunked async PBKDF2 so the browser stays responsive during 40k iterations.
 * onProgress(done, total) is called roughly every chunk. */
function pbkdf2Async(pwBytes, saltBytes, iterations, keyLen, onProgress) {
  return new Promise(function (resolve) {
    var out = new Uint8Array(keyLen), block = 1, blocks = Math.ceil(keyLen / 32);
    var CHUNK = 500; // iterations per yield
    function runOneBlock(bi, done) {
      var be = new Uint8Array(4);
      be[0]=(bi>>>24)&0xff; be[1]=(bi>>>16)&0xff; be[2]=(bi>>>8)&0xff; be[3]=bi&0xff;
      var msg = new Uint8Array(saltBytes.length + 4);
      msg.set(saltBytes); msg.set(be, saltBytes.length);
      var u = hmacSha256(pwBytes, msg), t = u.slice(), it = 1;
      function chunk() {
        var end = Math.min(it + CHUNK, iterations), j;
        for (; it < end; it++) {
          u = hmacSha256(pwBytes, u);
          for (j = 0; j < t.length; j++) t[j] ^= u[j];
        }
        if (onProgress) onProgress(it + (bi - 1) * iterations, blocks * iterations);
        if (it < iterations) { setTimeout(chunk, 0); return; }
        var off = (bi - 1) * 32, n = Math.min(32, keyLen - off);
        for (j = 0; j < n; j++) out[off + j] = t[j];
        done();
      }
      chunk();
    }
    function next() {
      if (block > blocks) { resolve(out); return; }
      runOneBlock(block, function () { block++; next(); });
    }
    next();
  });
}

/* ---------- checkphrase (upstream algorithm) ---------- */
var SALT = "human-readable-checksum";
var ITERATIONS = 40000;
var CHECKSUM_LEN = 5;
var KEY_BYTECOUNT = Math.ceil((CHECKSUM_LEN * 11) / 8); // 7

function keyToWords(key, wordList) {
  var keyInt = 0n, i;
  for (i = 0; i < KEY_BYTECOUNT && i < key.length; i++) {
    keyInt = (keyInt << 8n) | BigInt(key[i]);
  }
  keyInt >>= BigInt((8 * KEY_BYTECOUNT) % 11); // keep only the first 55 bits
  var words = [];
  for (i = 0; i < CHECKSUM_LEN; i++) {
    var shift = BigInt((CHECKSUM_LEN - 1 - i) * 11);
    var idx = Number((keyInt >> shift) & 0x7ffn);
    words.push(wordList[idx]);
  }
  return words;
}

function addressToChecksum(address, wordList) {
  if (!wordList || wordList.length !== 2048) throw new Error("wordlist must have 2048 entries");
  var key = pbkdf2HmacSha256(utf8Bytes(String(address)), utf8Bytes(SALT), ITERATIONS, KEY_BYTECOUNT);
  return keyToWords(key, wordList);
}

function addressToChecksumAsync(address, wordList, onProgress) {
  if (!wordList || wordList.length !== 2048) return Promise.reject(new Error("wordlist must have 2048 entries"));
  return pbkdf2Async(utf8Bytes(String(address)), utf8Bytes(SALT), ITERATIONS, KEY_BYTECOUNT, onProgress)
    .then(function (key) { return keyToWords(key, wordList); });
}

var api = {
  sha256Bytes: sha256Bytes,
  pbkdf2HmacSha256: pbkdf2HmacSha256,
  addressToChecksum: addressToChecksum,
  addressToChecksumAsync: addressToChecksumAsync,
  SALT: SALT, ITERATIONS: ITERATIONS, CHECKSUM_LEN: CHECKSUM_LEN, KEY_BYTECOUNT: KEY_BYTECOUNT
};
global.QTC_CHECK = api;
if (typeof module !== "undefined" && module.exports) { module.exports = api; }

})(typeof globalThis !== "undefined" ? globalThis : this);
