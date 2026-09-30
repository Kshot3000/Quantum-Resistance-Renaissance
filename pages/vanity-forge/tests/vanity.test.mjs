import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B58, LEAD, MAX_PATTERN, FIRST_CHAR_SET, FIRST_CHAR_PROB, WORST_FIRST_FACTOR,
  validatePattern, variantsForChar, expectedAttempts,
  probFoundBy, attemptsForQuantile, medianAttempts,
  expectedSeconds, fmtInt, fmtDuration, difficultyLadder,
  addressMatches,
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
  // 'K' folds to 'k' which IS in the set — accepted (case-insensitive grind finds it)
  const folded = validatePattern('K5', 'prefix');
  assert.ok(folded.ok, folded.error);
  // suffix mode has no pinned position
  assert.ok(validatePattern('AX', 'suffix').ok);
  assert.ok(validatePattern('A0', 'suffix').ok === false); // 0 still not base58
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

test('addressMatches: suffix mode', () => {
  const addr = 'qzabc123KSHOT';
  assert.ok(addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'suffix' }));
  assert.ok(!addressMatches(addr, 'KSHOT', { caseSensitive: true, position: 'prefix' }));
  assert.ok(addressMatches(addr, 'kshot', { caseSensitive: false, position: 'suffix' }));
});
