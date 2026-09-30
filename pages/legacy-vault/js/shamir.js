/* QTC Legacy Vault — Shamir's Secret Sharing over GF(2^8).
 *
 * Field: GF(2^8) with reducing polynomial x^8 + x^4 + x^3 + x + 1 (0x11B),
 * the same field AES uses. Addition is XOR; multiplication is the standard
 * Russian-peasant / xtime construction; inverses come from log/exp tables
 * built on generator 0x03.
 *
 * Share format (versioned, human-readable):
 *   LV1-{t}of{n}-#{index}-{hex payload}
 * e.g. LV1-2of3-#1-9f02ab...
 *   - share x-coordinates are the 1-based share indices (1..n)
 *   - for each secret byte, a random polynomial of degree (t-1) whose
 *     constant term is the secret byte is evaluated at each x
 *   - any t of the n shares recover the secret via Lagrange interpolation
 *     at x = 0; any t-1 shares reveal nothing (information-theoretic)
 *
 * Known-answer vectors: tests/vectors/shamir-vectors.json, produced by the
 * independent Python reference in tests/gen-vectors.py.
 *
 * Works in browsers (window.QTC_SHAMIR) and Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QTC_SHAMIR = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "LV1";
  const MAX_SECRET_BYTES = 512; // keeps shares printable; enough for any seed phrase
  const MAX_SHARES = 255; // x-coordinates must be nonzero bytes

  function shamirError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // ---------- GF(2^8) ----------
  function gfMul(a, b) {
    a &= 0xff; b &= 0xff;
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b; // 0x11B without the x^8 term
      b >>= 1;
    }
    return p;
  }

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = gfMul(x, 0x03);
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfInv(a) {
    a &= 0xff;
    if (a === 0) throw shamirError("DIV_ZERO", "division by zero in GF(2^8)");
    return EXP[255 - LOG[a]];
  }

  function gfDiv(a, b) {
    a &= 0xff; b &= 0xff;
    if (b === 0) throw shamirError("DIV_ZERO", "division by zero in GF(2^8)");
    if (a === 0) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  }

  // ---------- share text codec ----------
  const SHARE_RE = /^LV1-(\d+)of(\d+)-#(\d+)-([0-9a-fA-F]+)$/;

  function parseShare(text) {
    if (typeof text !== "string") throw shamirError("BAD_SHARE", "share must be text");
    const m = SHARE_RE.exec(text.trim());
    if (!m) throw shamirError("BAD_SHARE", "share text does not match LV1-{t}of{n}-#{i}-{hex}");
    const t = parseInt(m[1], 10), n = parseInt(m[2], 10), index = parseInt(m[3], 10);
    if (!(t >= 2 && t <= n && n <= MAX_SHARES && index >= 1 && index <= n)) {
      throw shamirError("BAD_SHARE", "share header has impossible t/n/index values");
    }
    const hex = m[4];
    if (hex.length % 2 !== 0 || hex.length === 0 || hex.length > MAX_SECRET_BYTES * 2) {
      throw shamirError("BAD_SHARE", "share payload has invalid length");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return { version: VERSION, t, n, index, bytes };
  }

  function formatShare(t, n, index, bytes) {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return `${VERSION}-${t}of${n}-#${index}-${hex}`;
  }

  // ---------- split ----------
  function defaultRand() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const b = new Uint8Array(1);
      crypto.getRandomValues(b);
      return b[0];
    }
    // Node fallback
    try {
      // eslint-disable-next-line no-undef
      return require("crypto").randomBytes(1)[0];
    } catch (e) {
      throw shamirError("NO_RNG", "no cryptographic RNG available");
    }
  }

  function split(secretBytes, n, t, randByte) {
    if (!(secretBytes instanceof Uint8Array)) {
      throw shamirError("BAD_SECRET", "secret must be a Uint8Array");
    }
    if (secretBytes.length === 0) throw shamirError("BAD_SECRET", "secret is empty");
    if (secretBytes.length > MAX_SECRET_BYTES) {
      throw shamirError("BAD_SECRET", `secret too long (max ${MAX_SECRET_BYTES} bytes)`);
    }
    if (!Number.isInteger(n) || n < 2 || n > MAX_SHARES) {
      throw shamirError("BAD_PARAMS", "share count n must be an integer from 2 to 255");
    }
    if (!Number.isInteger(t) || t < 2 || t > n) {
      throw shamirError("BAD_PARAMS", "threshold t must be an integer from 2 to n");
    }
    const rand = randByte || defaultRand;
    const coeff = new Uint8Array(t);
    const shareBufs = [];
    for (let i = 0; i < n; i++) shareBufs.push(new Uint8Array(secretBytes.length));
    for (let j = 0; j < secretBytes.length; j++) {
      coeff[0] = secretBytes[j];
      for (let k = 1; k < t; k++) {
        const r = rand();
        if (!Number.isInteger(r) || r < 0 || r > 255) {
          throw shamirError("BAD_RNG", "randByte must return an integer 0..255");
        }
        coeff[k] = r;
      }
      for (let i = 0; i < n; i++) {
        const x = i + 1;
        // Horner evaluation of coeff[0] + coeff[1]*x + ... + coeff[t-1]*x^(t-1)
        let y = coeff[t - 1];
        for (let k = t - 2; k >= 0; k--) y = gfMul(y, x) ^ coeff[k];
        shareBufs[i][j] = y;
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(formatShare(t, n, i + 1, shareBufs[i]));
    return out;
  }

  // ---------- combine ----------
  function lagrangeAtZero(xs, ys) {
    let total = 0;
    for (let i = 0; i < xs.length; i++) {
      let num = 1, den = 1;
      for (let j = 0; j < xs.length; j++) {
        if (i === j) continue;
        num = gfMul(num, xs[j]);
        den = gfMul(den, xs[j] ^ xs[i]); // subtraction == XOR in characteristic 2
      }
      total ^= gfMul(ys[i], gfMul(num, gfInv(den)));
    }
    return total;
  }

  function combine(shareTexts) {
    if (!Array.isArray(shareTexts) || shareTexts.length === 0) {
      throw shamirError("BAD_SHARE", "provide at least one share");
    }
    const parsed = shareTexts.map(parseShare);
    const t = parsed[0].t, n = parsed[0].n;
    for (const p of parsed) {
      if (p.t !== t || p.n !== n) {
        throw shamirError("MIXED_SHARES", "shares come from different split parameters");
      }
    }
    const seen = new Set();
    for (const p of parsed) {
      if (seen.has(p.index)) throw shamirError("DUP_SHARE", `duplicate share #${p.index}`);
      seen.add(p.index);
    }
    if (parsed.length < t) {
      throw shamirError("TOO_FEW", `need at least ${t} shares to recover, got ${parsed.length}`);
    }
    const chosen = parsed.slice(0, t);
    const len = chosen[0].bytes.length;
    for (const p of chosen) {
      if (p.bytes.length !== len) throw shamirError("MIXED_SHARES", "share payloads differ in length");
    }
    const xs = chosen.map((p) => p.index);
    const out = new Uint8Array(len);
    const ys = new Array(t);
    for (let j = 0; j < len; j++) {
      for (let i = 0; i < t; i++) ys[i] = chosen[i].bytes[j];
      out[j] = lagrangeAtZero(xs, ys);
    }
    return out;
  }

  // ---------- text helpers ----------
  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: true }) : null;

  function splitText(secretText, n, t, randByte) {
    if (typeof secretText !== "string" || secretText.length === 0) {
      throw shamirError("BAD_SECRET", "secret text is empty");
    }
    if (!enc) throw shamirError("NO_CODEC", "TextEncoder unavailable");
    return split(enc.encode(secretText), n, t, randByte);
  }

  function combineText(shareTexts) {
    const bytes = combine(shareTexts);
    if (!dec) throw shamirError("NO_CODEC", "TextDecoder unavailable");
    try {
      return dec.decode(bytes);
    } catch (e) {
      throw shamirError("NOT_TEXT", "recovered bytes are not valid UTF-8 (wrong or corrupted shares?)");
    }
  }

  return {
    VERSION, MAX_SECRET_BYTES, MAX_SHARES,
    gfMul, gfInv, gfDiv,
    split, combine, splitText, combineText,
    parseShare, formatShare,
  };
});
