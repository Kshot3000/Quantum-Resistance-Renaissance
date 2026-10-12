import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B58, LEAD, MAX_PATTERN, FIRST_CHAR_SET, FIRST_CHAR_PROB, WORST_FIRST_FACTOR,
  validatePattern, variantsForChar, expectedAttempts,
  probFoundBy, attemptsForQuantile, medianAttempts,
  expectedSeconds, fmtInt, fmtDuration, difficultyLadder,
  addressMatches, SS58_189_RE, sanitizeVault, sanitizeBench,
} from '../js/vanity.js';

test('base58 alphabet has 58 chars and excludes 0/O/I/l', () => {
  assert.equal(B58.length, 58);
  for (const bad of ['0', 'O', 'I', 'l']) assert.ok(!B58.includes(bad), bad);
});

test('lead is qz', () => assert.equal(LEAD, 'qz'));

test('pinned first character: exact 7-symbol set, probs sum to 1', () => {
  assert.equal(FIRST_CHAR_SET, 'jkmnopq');
  const sum = Object.values(FIRST_CHAR_PROB).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5, sum);
  assert.ok(Math.abs(WORST_FIRST_FACTOR - 1 / 0.041395) < 1e-9);
});

test('validatePattern: happy path', () => {
  const r = validatePattern('mSHT', 'prefix');
  assert.ok(r.ok); assert.equal(r.pattern, 'mSHT'); assert.equal(r.leadNote, false);
});

test('validatePattern: strips automatic qz lead', () => {
  const r = validatePattern('qzmSHT', 'prefix');
  assert.ok(r.ok); assert.equal(r.pattern, 'mSHT'); assert.equal(r.leadNote, true);
});

test('validatePattern: rejects empty, bad chars, too long', () => {
  assert.ok(!validatePattern('', 'prefix').ok);
  assert.ok(!validatePattern('   ', 'prefix').ok);
  assert.ok(!validatePattern('mB0', 'prefix').ok); // 0 not in base58
  assert.ok(!validatePattern('mBCDEF7', 'prefix').ok); // 7 chars
  assert.ok(validatePattern('mBCDEF', 'prefix').ok); // exactly 6 ok
});

test('validatePattern: rejects impossible pinned first char (prefix only)', () => {
  const bad = validatePattern('AX', 'prefix'); // 'a' not in jkmnopq
  assert.ok(!bad.ok);
  assert.ok(bad.error.includes('pins that position'), bad.error);
  // suffix mode has no pinned position
  assert.ok(validatePattern('AX', 'suffix').ok);
  assert.ok(validatePattern('A0', 'suffix').ok === false); // 0 still not base58
});

test('validatePattern: the pinned position is case-aware', () => {
  // Case-sensitive (the page default): position 3 is ALWAYS lowercase
  // j/k/m/n/o/p/q, so an uppercase twin can never match — grinding for it
  // would run forever. It must be rejected, not folded.
  const cs = validatePattern('K5', 'prefix', true);
  assert.ok(!cs.ok);
  assert.ok(/case-sensitive/i.test(cs.error), cs.error);
  assert.ok(!validatePattern('KNET', 'prefix', true).ok);
  assert.ok(!validatePattern('Q', 'prefix', true).ok);
  assert.ok(validatePattern('k5', 'prefix', true).ok);
  assert.ok(validatePattern('mSHT', 'prefix', true).ok); // only char 1 is pinned
  // Case-insensitive: 'K' folds to 'k', which IS in the set — accepted.
  assert.ok(validatePattern('K5', 'prefix', false).ok);
  assert.ok(validatePattern('KNET', 'prefix', false).ok);
  // Suffix mode has no pinned position in either case mode.
  assert.ok(validatePattern('K5', 'suffix', true).ok);
});

test('variantsForChar: case-sensitive always 1', () => {
  assert.equal(variantsForChar('A', true), 1);
  assert.equal(variantsForChar('5', true), 1);
});

test('variantsForChar: case-insensitive letters 2, digits 1', () => {
  assert.equal(variantsForChar('A', false), 2);
  assert.equal(variantsForChar('z', false), 2);
  assert.equal(variantsForChar('5', false), 1);
  assert.equal(variantsForChar('1', false), 1);
});

test('expectedAttempts prefix: pinned first char × 58^(k-1)', () => {
  const P = { caseSensitive: true, position: 'prefix' };
  assert.ok(Math.abs(expectedAttempts('m', P) - 1 / 0.172794) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('k5', P) - (1 / 0.172794) * 58) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('q', P) - WORST_FIRST_FACTOR) < 1e-9);
  // case-insensitive: first char folds to the same probability
  const I = { caseSensitive: false, position: 'prefix' };
  assert.ok(Math.abs(expectedAttempts('K', I) - 1 / 0.172794) < 1e-9);
  assert.ok(Math.abs(expectedAttempts('K5', I) - (1 / 0.172794) * 58) < 1e-9); // digit 58
  assert.ok(Math.abs(expectedAttempts('Ka', I) - (1 / 0.172794) * 29) < 1e-9); // letter folds: 29
  // case-sensitive uppercase at the pinned position: probability exactly 0
  assert.equal(expectedAttempts('K', P), Infinity);
  assert.equal(expectedAttempts('KNET', P), Infinity);
});

test('expectedAttempts suffix: 58^k (approximate, checksum-coupled)', () => {
  const S = { caseSensitive: true, position: 'suffix' };
  assert.equal(expectedAttempts('A', S), 58);
  assert.equal(expectedAttempts('AB', S), 58 * 58);
  const SI = { caseSensitive: false, position: 'suffix' };
  assert.equal(expectedAttempts('A5', SI), 29 * 58);
});

test('probFoundBy: ~63.2% at n = expected (1 - 1/e)', () => {
  const p = probFoundBy(5800, 5800);
  assert.ok(Math.abs(p - (1 - 1 / Math.E)) < 1e-3, p);
  assert.equal(probFoundBy(0, 5800), 0);
  assert.ok(probFoundBy(1e12, 58) > 0.999999);
});

test('median is ln2 * expected', () => {
  const m = medianAttempts(100000);
  assert.ok(Math.abs(m - 100000 * Math.LN2) < 1, m);
});

test('attemptsForQuantile: 90th percentile', () => {
  const q90 = attemptsForQuantile(0.9, 1000);
  assert.ok(Math.abs(probFoundBy(q90, 1000) - 0.9) < 1e-9);
});

test('expectedSeconds: Infinity at zero rate', () => {
  assert.equal(expectedSeconds(1000, 0), Infinity);
  assert.equal(expectedSeconds(1000, 50), 20);
});

test('fmtDuration bands', () => {
  assert.equal(fmtDuration(0.2), '< 1 second');
  assert.equal(fmtDuration(45), '45 seconds');
  assert.equal(fmtDuration(600), '10 minutes');
  assert.equal(fmtDuration(5400), '1.5 hours');
  assert.equal(fmtDuration(90000), '25 hours');
  assert.equal(fmtDuration(864000), '10 days');
  assert.equal(fmtDuration(1e8), '3.2 years');
  assert.equal(fmtDuration(Infinity), '—');
});

test('fmtInt', () => {
  assert.equal(fmtInt(3364), '3,364');
  assert.equal(fmtInt(Infinity), '—');
});

test('difficultyLadder: 6 rows, worst-first-char × 58^(k-1)', () => {
  const rows = difficultyLadder(100);
  assert.equal(rows.length, MAX_PATTERN);
  assert.ok(Math.abs(rows[0].expected - WORST_FIRST_FACTOR) < 1e-9);
  assert.ok(Math.abs(rows[2].expected - WORST_FIRST_FACTOR * 58 * 58) < 1e-6);
  assert.ok(Math.abs(rows[5].expected - WORST_FIRST_FACTOR * 58 ** 5) < 1e-3);
  assert.ok(Math.abs(rows[2].median - rows[2].expected * Math.LN2) < 1);
  assert.ok(Math.abs(rows[0].seconds - WORST_FIRST_FACTOR / 100) < 1e-9);
});

test('addressMatches: prefix mode', () => {
  const addr = 'qzKSHOTabc123xyz';
  assert.ok(addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(!addressMatches(addr, 'kshot', { caseSensitive: true, position: 'prefix' }));
  assert.ok(addressMatches(addr, 'kshot', { caseSensitive: false, position: 'prefix' }));
  assert.ok(!addressMatches(addr, 'SHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(!addressMatches('abKSHOTxx', 'KSHOT', { caseSensitive: true, position: 'prefix' }));
});

test('SS58_189_RE: qz + 47 base58, fleet-shaped addresses only', () => {
  assert.ok(SS58_189_RE.test('qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv'));
  assert.ok(SS58_189_RE.test('qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau'));
  assert.ok(!SS58_189_RE.test('qzshort'));
  assert.ok(!SS58_189_RE.test('qz0sbEcAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv')); // 0 not base58
});

const GOOD_REC = {
  address: 'qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv',
  scheme: '65', pattern: 'msb', caseSensitive: false, position: 'prefix',
  attempts: 1234, ms: 5678, date: '2026-10-01T00:00:00.000Z', secretHex: 'abcd',
};

test('sanitizeVault: well-formed records survive, poison is dropped', () => {
  assert.equal(sanitizeVault([GOOD_REC]).length, 1);
  assert.equal(sanitizeVault('junk').length, 0);
  assert.equal(sanitizeVault(null).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, scheme: '99' }]).length, 0); // was a boot crash
  assert.equal(sanitizeVault([{ ...GOOD_REC, address: '<img src=x>' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, pattern: '<b>x</b>' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, attempts: -1 }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, date: 'whenever' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, secretHex: 'zz' }]).length, 0);
  assert.equal(sanitizeVault([{ ...GOOD_REC, secretHex: null }]).length, 1);
  assert.equal(sanitizeVault([GOOD_REC, null, 42, GOOD_REC]).length, 2);
  assert.ok(sanitizeVault(Array.from({ length: 500 }, () => GOOD_REC)).length <= 200);
});

test('sanitizeBench: only plausible measured rates survive', () => {
  assert.equal(sanitizeBench({ '65': 42.5 })['65'], 42.5);
  assert.equal(sanitizeBench({ '65': 1e15 })['65'], undefined);
  assert.equal(sanitizeBench({ '65': 'fast' })['65'], undefined);
  assert.equal(sanitizeBench({ '65': -3 })['65'], undefined);
  assert.deepEqual(sanitizeBench('junk'), {});
  assert.equal(sanitizeBench({ '87': 12, evil: 5 }).evil, undefined);
});

test('addressMatches: suffix mode', () => {
  const addr = 'qzabc123KSHOT';
  assert.ok(addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'suffix' }));
  assert.ok(!addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(addressMatches(addr, 'kshot', { caseSensitive: false, position: 'suffix' }));
});
