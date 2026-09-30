/* QTC Vanity Forge — difficulty mathematics (pure: no DOM, no crypto).
 *
 * Every Quantus SS58-189 address starts with the fixed two-character lead "qz".
 * A vanity pattern matches the characters immediately after that lead (prefix
 * mode) or the trailing characters (suffix mode). Address characters are
 * base58; the 32-byte account ID is a Poseidon2 hash of the ML-DSA public key,
 * so each fresh keypair is an independent uniform draw over the alphabet —
 * grinding is a geometric process with per-trial success probability p.
 *
 * Prefix math is exact. Suffix math is approximate: the trailing characters
 * encode the SS58 checksum, which is a deterministic function of the account
 * ID rather than an independent draw. In practice the suffix behaves close to
 * uniform over many draws, so we publish the same numbers with an explicit
 * "approximate" label.
 */

export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const LEAD = 'qz'; // every SS58-189 Quantus address starts with qz
export const MAX_PATTERN = 6;

/* The character right after the "qz" lead is PINNED by the SS58-189 prefix
 * bytes: it can only be one of these 7 symbols, with unequal probabilities.
 * Derived exactly (BigInt interval arithmetic over the account-ID range,
 * 100% coverage) and cross-checked against 12,000 real keygens:
 *   j:0.0946 k/m/n/o/p:0.1728 each q:0.0414  (empirical: 0.0974/0.1717/0.1713/0.1741/0.1794/0.1660/0.0402)
 * Every character after that is (for grinding purposes) uniform over base58.
 */
export const FIRST_CHAR_SET = 'jkmnopq';
export const FIRST_CHAR_PROB = {
  j: 0.094634, k: 0.172794, m: 0.172794, n: 0.172794,
  o: 0.172794, p: 0.172794, q: 0.041395,
};
export const WORST_FIRST_FACTOR = 1 / Math.min(...Object.values(FIRST_CHAR_PROB)); // ≈24.157 ('q')

/** Normalize + validate a raw pattern string. */
export function validatePattern(raw, position = 'prefix') {
  const clean = String(raw || '').trim().replace(/\s+/g, '');
  if (!clean) return { ok: false, error: 'Type the characters you want in your address.' };
  // A leading "qz" is the automatic SS58-189 lead, not part of the grind.
  let p = clean;
  let leadNote = false;
  if (/^qz/i.test(p) && p.length > 2) { p = p.slice(2); leadNote = true; }
  if (p.length > MAX_PATTERN)
    return { ok: false, error: `Keep it to ${MAX_PATTERN} characters — longer than that is beyond solo grinding.` };
  for (const ch of p) {
    if (!B58.includes(ch))
      return { ok: false, error: `"${ch}" is not a base58 character (no 0, O, I, l).` };
  }
  if (position === 'prefix') {
    const first = p[0].toLowerCase();
    if (!FIRST_CHAR_SET.includes(first))
      return {
        ok: false,
        error: `No Quantus address can have "${p[0]}" right after "qz" — the SS58-189 lead pins that position to one of: ${FIRST_CHAR_SET.split('').join(' ')} (case-insensitive).`,
      };
  }
  return { ok: true, pattern: p, leadNote };
}

/** How many of the 58 alphabet symbols satisfy one pattern character. */
export function variantsForChar(ch, caseSensitive) {
  if (caseSensitive) return 1;
  // Digits 1-9 have no case twin; every base58 letter appears in both cases.
  return /[0-9]/.test(ch) ? 1 : 2;
}

/**
 * Expected number of keypairs to grind for a pattern (mean of the geometric
 * distribution). Prefix mode: the first character after "qz" is pinned to 7
 * symbols with known probabilities (see FIRST_CHAR_PROB); every further
 * character is 1-in-58. Suffix mode: 58^k (approximate — checksum coupling).
 */
export function expectedAttempts(pattern, { caseSensitive, position }) {
  if (position === 'suffix') {
    let e = 1;
    for (const ch of pattern) e *= 58 / variantsForChar(ch, caseSensitive);
    return e;
  }
  const first = pattern[0].toLowerCase();
  const pFirst = FIRST_CHAR_PROB[first] || 0;
  if (!(pFirst > 0)) return Infinity;
  let e = 1 / pFirst;
  for (const ch of pattern.slice(1)) e *= 58 / variantsForChar(ch, caseSensitive);
  return e;
}

/** P(find within n attempts) = 1 - (1 - 1/E)^n. */
export function probFoundBy(n, expected) {
  if (!(expected > 0) || n <= 0) return 0;
  const p = 1 / expected;
  // log1p form keeps precision when p is tiny.
  return -Math.expm1(n * Math.log1p(-p));
}

/** Attempts by which the find probability reaches q (e.g. median at q=0.5). */
export function attemptsForQuantile(q, expected) {
  if (!(expected > 0) || q <= 0 || q >= 1) return NaN;
  return Math.log1p(-q) / Math.log1p(-1 / expected);
}

export const medianAttempts = (expected) => attemptsForQuantile(0.5, expected);

/** Expected wall-clock seconds at a measured grind rate (keys/second). */
export function expectedSeconds(expected, keysPerSec) {
  if (!(keysPerSec > 0)) return Infinity;
  return expected / keysPerSec;
}

export function fmtInt(n) {
  if (!isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtDuration(sec) {
  if (!isFinite(sec)) return '—';
  if (sec < 1) return '< 1 second';
  if (sec < 90) return `${Math.round(sec)} seconds`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)} minutes`;
  const hr = min / 60;
  if (hr < 72) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} hours`;
  const d = hr / 24;
  if (d < 730) return `${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
  const y = d / 365.25;
  return `${y < 10 ? y.toFixed(1) : Math.round(y)} years`;
}

/** Difficulty ladder rows for k = 1..6 at a given grind rate (worst case:
 *  hardest pinned first character × 58 for each further character). */
export function difficultyLadder(keysPerSec) {
  const rows = [];
  for (let k = 1; k <= MAX_PATTERN; k++) {
    const expected = WORST_FIRST_FACTOR * Math.pow(58, k - 1);
    rows.push({
      chars: k,
      expected,
      median: medianAttempts(expected),
      seconds: expectedSeconds(expected, keysPerSec),
      p90: attemptsForQuantile(0.9, expected),
    });
  }
  return rows;
}

/** Does an address satisfy the pattern (prefix or suffix mode)? */
export function addressMatches(address, pattern, { caseSensitive, position }) {
  if (!address.startsWith(LEAD)) return false;
  const body = address.slice(LEAD.length);
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  const b = caseSensitive ? body : body.toLowerCase();
  return position === 'suffix' ? b.endsWith(p) : b.startsWith(p);
}
