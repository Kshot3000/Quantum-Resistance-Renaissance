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
  /* Combine-input bound: a split makes at most MAX_SHARES shares, with
   * indices 1..MAX_SHARES, and combine uses at most t of them — so any
   * input past MAX_SHARE_LINES lines is guaranteed to fail anyway (a
   * duplicate or impossible index), and refusing it BEFORE the parse
   * keeps a huge paste from paying a regex + hex decode for every line
   * only to be rejected at the end. */
  const MAX_SHARE_LINES = MAX_SHARES;

  /* Room for `count` pasted share lines under the combine bound: true
   * only for a finite, non-negative number at or under MAX_SHARE_LINES.
   * Fail-closed — NaN, negative, infinite, string, and missing counts
   * all refuse, matching the fleet's other *Room gates. */
  function combineLinesRoom(count) {
    return typeof count === "number" && isFinite(count) &&
      count >= 0 && count <= MAX_SHARE_LINES;
  }

  /* Combine-paste scan window: combineLinesRoom bounds the PARSE, but
   * the caller used to split/trim/filter the WHOLE pasted text to build
   * the line array that check counts — a 20,400,000-char paste of
   * 400,000 lines built all 400,000 strings (~166 ms in Node) on every
   * Recover click, all to be refused at 256 lines. combineTextWindow
   * owns the raw text: it scans only the first MAX_COMBINE_SCAN_CHARS
   * characters and reports skippedChars so the UI can disclose the
   * unscanned tail. The cap is derived from the largest legitimate
   * paste: a full MAX_SHARES set of max-secret shares is 255 lines of
   * at most 1,042 chars (18-char header at the widest t/n/index digits
   * + 1,024 payload hex) plus 254 separators = 265,964 chars (measured
   * 265,346 for a real 255-share split), so the 524,288 window holds
   * that set intact nearly twice over — room for CRLF endings and
   * blank lines between shares — and no legitimate paste changes
   * outcome. When the cut lands inside a line, the scan backs off to
   * the last newline so no truncated partial line is ever parsed as if
   * it were a pasted share; a single line longer than the window scans
   * as empty (it can never be a valid <=1,042-char share). Fail-closed:
   * a non-string input scans as empty. Returns { lines, totalChars,
   * scannedChars, skippedChars } with lines trimmed and non-empty,
   * matching the caller's previous semantics. */
  const MAX_COMBINE_SCAN_CHARS = 524288;

  function combineTextWindow(text) {
    if (typeof text !== "string") {
      return { lines: [], totalChars: 0, scannedChars: 0, skippedChars: 0 };
    }
    const totalChars = text.length;
    let scanned = text;
    if (totalChars > MAX_COMBINE_SCAN_CHARS) {
      scanned = text.slice(0, MAX_COMBINE_SCAN_CHARS);
      const nextCh = text.charAt(MAX_COMBINE_SCAN_CHARS);
      const lastCh = scanned.charAt(scanned.length - 1);
      if (nextCh && nextCh !== "\n" && nextCh !== "\r" && lastCh !== "\n" && lastCh !== "\r") {
        const cut = Math.max(scanned.lastIndexOf("\n"), scanned.lastIndexOf("\r"));
        scanned = cut >= 0 ? scanned.slice(0, cut + 1) : "";
      }
    }
    const lines = scanned.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { lines, totalChars, scannedChars: scanned.length,
      skippedChars: totalChars - scanned.length };
  }

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
    if (!combineLinesRoom(shareTexts.length)) {
      throw shamirError("TOO_MANY_SHARES",
        `too many share lines — the cap is ${MAX_SHARE_LINES} shares (a split makes at most ${MAX_SHARES}); remove the extra lines and try again`);
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
    VERSION, MAX_SECRET_BYTES, MAX_SHARES, MAX_SHARE_LINES, combineLinesRoom,
    MAX_COMBINE_SCAN_CHARS, combineTextWindow,
    gfMul, gfInv, gfDiv,
    split, combine, splitText, combineText,
    parseShare, formatShare,
  };
});
