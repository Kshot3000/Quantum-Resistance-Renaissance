/* QTC Web Wallet — offline logic tests. Run: node tests/run-tests.mjs
 * Covers: xxhash vectors, SCALE compact, era codec, mnemonic (BIP-39 vectors),
 * key derivation determinism, sign/verify with the chain context, extrinsic
 * assembly, account-info decoding, unit conversions. Live RPC checks live in
 * tests/live-rpc-check.mjs (needs network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { xxh64, xxhash128, storageKey } from '../js/xxhash.js';
import {
  concat, u32le, compactEncode, compactDecode, encodeMortalEra, eraBirth,
  buildTransferCall, buildSigningPayload, buildExtrinsic,
  decodeAccountInfo, plancksToQtc, qtcToPlancks,
  BALANCES_PALLET_INDEX, TRANSFER_KEEP_ALIVE_CALL_INDEX,
} from '../js/scale.js';
import {
  setWordlistForTests, entropyToMnemonic, validateMnemonic, mnemonicToSeed,
  keypairFromSeed, keypairFromMnemonic, loadWordlist, embeddedWordlist,
} from '../js/mnemonic.js';
import { readFileSync } from 'node:fs';

test('wordlist: embedded list is the authentic 2048-word BIP-39 English list', () => {
  const emb = embeddedWordlist();
  assert.equal(emb.length, 2048);
  assert.equal(new Set(emb).size, 2048, 'words must be unique');
  assert.equal(emb[0], 'abandon');
  assert.equal(emb[2047], 'zoo');
  const file = readFileSync(new URL('../vendor/bip39-english.txt', import.meta.url), 'utf8')
    .trim().split('\n').map((w) => w.trim());
  assert.deepEqual(emb, file, 'embedded list must be byte-identical to vendor/bip39-english.txt');
  // loadWordlist resolves to the same list with no network
  return loadWordlist().then((w) => assert.deepEqual(w, emb));
});
import { ss58Decode, hexDecode } from '../js/quantus-crypto.js';
import { ml_dsa65 } from '../vendor/noble/post-quantum/ml-dsa.js';

/* BIP-39 English wordlist stand-in: unique filler words (indexOf must resolve
 * to the right index) plus the real words needed by the fixed vectors. */
const MINI_WORDS = (() => {
  const w = new Array(2048);
  for (let i = 0; i < 2048; i++) w[i] = 'word' + i;
  w[0] = 'abandon'; w[3] = 'about'; w[1027] = 'legal'; w[2047] = 'zoo';
  w[1093] = 'winner';
  return w;
})();

test('xxh64: published test vectors', () => {
  const enc = new TextEncoder();
  assert.equal(xxh64(enc.encode(''), 0n), 0xEF46DB3751D8E999n);
  assert.equal(xxh64(enc.encode('abc'), 0n), 0x44BC2CF5AD770999n);
  // seed sensitivity + determinism (no invented magic numbers)
  const s1 = xxh64(enc.encode('abc'), 0x9E3779B97F4A7C15n);
  assert.equal(s1, xxh64(enc.encode('abc'), 0x9E3779B97F4A7C15n));
  assert.notEqual(s1, xxh64(enc.encode('abc'), 0n));
  // long-input path (>= 32 bytes) determinism
  const long = enc.encode('abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(xxh64(long, 0n), xxh64(long, 0n));
});

test('xxhash128: 16 bytes, deterministic', () => {
  const a = xxhash128(new TextEncoder().encode('System'));
  const b = xxhash128(new TextEncoder().encode('System'));
  assert.equal(a.length, 16);
  assert.deepEqual(a, b);
});

test('xxhash128: canonical Substrate vector (chain-verified 2026-09-30)', () => {
  // twox_128("System") as the Quantus chain computes it: XxHash64 seeds 0 and 1.
  // Verified against sp-crypto-hashing 0.1.0 (behind the chain's sp-core 39.0.0),
  // Quantus-Network/chain frame/support/src/hash.rs, and @polkadot/util-crypto.
  const got = Buffer.from(xxhash128(new TextEncoder().encode('System'))).toString('hex');
  assert.equal(got, '26aa394eea5630e07c48ae0c9558cef7');
});

test('storageKey: layout = xxh128(pallet) ++ xxh128(storage) ++ blake2_128(key) ++ key', () => {
  const key = new Uint8Array(32).fill(9);
  const sk = storageKey('System', 'Account', key);
  assert.equal(sk.length, 32 + 16 + 32);
  assert.deepEqual(sk.slice(48), key);
});

test('compact: boundary round-trips', () => {
  for (const v of [0n, 1n, 63n, 64n, 16383n, 16384n, 1073741823n, 1073741824n, 2n ** 64n, 2n ** 128n - 1n]) {
    const enc = compactEncode(v);
    const { value, next } = compactDecode(enc);
    assert.equal(value, v, `round-trip ${v}`);
    assert.equal(next, enc.length);
  }
  // known encodings
  assert.deepEqual(compactEncode(0n), Uint8Array.of(0x00));
  assert.deepEqual(compactEncode(63n), Uint8Array.of(0xfc));
  assert.deepEqual(compactEncode(64n), Uint8Array.of(0x01, 0x01));
});

test('era: mortal encode + birth', () => {
  const e = encodeMortalEra(64, 5);
  assert.deepEqual(e, Uint8Array.of(0x55, 0x00)); // 5 | (5<<4), LE u16
  assert.equal(eraBirth(100, 64, 36), 100);
  assert.equal(eraBirth(100, 64, 40), 40);
  assert.equal(eraBirth(64, 64, 0), 64);
});

test('mnemonic: real list — zero entropy -> 23x abandon + checksum word; round-trip', async () => {
  await loadWordlist(); // real embedded list, no fixture
  const emb = embeddedWordlist();
  const m = entropyToMnemonic(new Uint8Array(32));
  const words = m.split(' ');
  assert.equal(words.length, 24);
  assert.ok(words.slice(0, 23).every((w) => w === 'abandon'));
  assert.equal(words[23], emb[0b00001100110]); // checksum bits of sha256(zeros32)[0]=0x66
  const v = validateMnemonic(m);
  assert.ok(v.ok);
  assert.deepEqual(v.entropy, new Uint8Array(32));
  // every word is a real BIP-39 word
  assert.ok(words.every((w) => emb.includes(w)));
});

test('mnemonic: fixture-based zero-entropy vector (kept for determinism docs)', () => {
  setWordlistForTests(MINI_WORDS);
  const m = entropyToMnemonic(new Uint8Array(32));
  const words = m.split(' ');
  assert.equal(words.length, 24);
  assert.ok(words.slice(0, 23).every((w) => w === 'abandon'));
  // checksum = first 8 bits of sha256(zeros32) = 0x66 -> last index 0b00001100110
  assert.equal(words[23], MINI_WORDS[0b00001100110]);
  const v = validateMnemonic(m);
  assert.ok(v.ok);
  assert.deepEqual(v.entropy, new Uint8Array(32));
});

test('mnemonic: checksum tamper is rejected', () => {
  setWordlistForTests(MINI_WORDS);
  const bad = ('abandon '.repeat(23) + 'zoo').trim();
  const v = validateMnemonic(bad);
  assert.ok(!v.ok, 'tampered checksum must fail');
});

test('mnemonic: unknown word rejected', () => {
  setWordlistForTests(MINI_WORDS);
  const v = validateMnemonic(('abandon '.repeat(23) + 'nope').trim());
  assert.ok(!v.ok);
});

test('mnemonicToSeed: deterministic, 64 bytes', () => {
  setWordlistForTests(MINI_WORDS);
  const m = entropyToMnemonic(new Uint8Array(32).fill(1));
  const s1 = mnemonicToSeed(m);
  const s2 = mnemonicToSeed(m);
  assert.equal(s1.length, 64);
  assert.deepEqual(s1, s2);
});

test('keypair: deterministic from mnemonic; address is SS58-189', async () => {
  setWordlistForTests(embeddedWordlist()); // reset: earlier fixture test overrides WORDLIST
  const m = entropyToMnemonic(new Uint8Array(32).fill(2));
  assert.ok(m.split(' ').every((w) => embeddedWordlist().includes(w)), 'real BIP-39 words');
  const a = keypairFromMnemonic(m, '', 65);
  const b = keypairFromMnemonic(m, '', 65);
  assert.equal(a.address, b.address);
  assert.ok(a.address.startsWith('qz'), 'SS58-189 addresses start with qz, got ' + a.address);
  const { prefix, accountId } = ss58Decode(a.address);
  assert.equal(prefix, 189);
  assert.deepEqual(accountId, a.accountId); // checksum round-trip
  // different mnemonic -> different address
  const c = keypairFromMnemonic(entropyToMnemonic(new Uint8Array(32).fill(3)), '', 65);
  assert.notEqual(a.address, c.address);
});

test('parseRecipient: enforces prefix 189, rejects bad checksum', async () => {
  const { parseRecipient } = await import('../js/rpc.js');
  await loadWordlist();
  const a = keypairFromMnemonic(entropyToMnemonic(new Uint8Array(32).fill(4)), '', 65);
  assert.deepEqual(parseRecipient(a.address), a.accountId);
  // tampered address -> checksum error
  const bad = a.address.slice(0, -1) + (a.address.endsWith('1') ? '2' : '1');
  assert.throws(() => parseRecipient(bad), /checksum/);
  // valid checksum but wrong prefix (e.g. generic Substrate 42) -> rejected
  const { ss58Encode } = await import('../js/quantus-crypto.js');
  const other = ss58Encode(a.accountId, 42);
  assert.throws(() => parseRecipient(other), /prefix/);
});

test('keypair: same seed -> same keys (FIPS-204 determinism)', () => {
  const seed = new Uint8Array(32).fill(42);
  const a = keypairFromSeed(seed, 65);
  const b = keypairFromSeed(seed, 65);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.equal(a.publicKey.length, 1952);
  assert.equal(a.secretKey.length, 4032);
});

test('sign/verify: QUANTUS_EXTRINSIC context binds; plain context fails', () => {
  const kp = keypairFromSeed(new Uint8Array(32).fill(9), 65);
  const ctx = new TextEncoder().encode('QUANTUS_EXTRINSIC');
  const msg = new TextEncoder().encode('payload-bytes');
  const sig = ml_dsa65.sign(msg, kp.secretKey, { context: ctx });
  assert.equal(sig.length, 3309);
  assert.ok(ml_dsa65.verify(sig, msg, kp.publicKey, { context: ctx }));
  assert.ok(!ml_dsa65.verify(sig, msg, kp.publicKey), 'no-context verify must fail');
  assert.ok(!ml_dsa65.verify(sig, new TextEncoder().encode('other'), kp.publicKey, { context: ctx }));
});

test('buildTransferCall: pallet 2, call 3, MultiAddress::Id, compact amount', () => {
  const dest = new Uint8Array(32).fill(7);
  const call = buildTransferCall(dest, 1500000000000n);
  assert.equal(call[0], BALANCES_PALLET_INDEX);
  assert.equal(call[1], TRANSFER_KEEP_ALIVE_CALL_INDEX);
  assert.equal(call[2], 0x00); // MultiAddress::Id
  assert.deepEqual(call.slice(3, 35), dest);
  const { value } = compactDecode(call, 35);
  assert.equal(value, 1500000000000n);
});

test('buildSigningPayload: exact field layout', () => {
  const call = buildTransferCall(new Uint8Array(32).fill(7), 1000n);
  const era = encodeMortalEra(64, 5);
  const p = buildSigningPayload({
    call, era, nonce: 3, tip: 0n,
    specVersion: 153, txVersion: 6,
    genesisHash: new Uint8Array(32).fill(0xaa),
    eraBirthHash: new Uint8Array(32).fill(0xbb),
  });
  let o = 0;
  assert.deepEqual(p.slice(0, call.length), call); o += call.length;
  assert.deepEqual(p.slice(o, o + 2), era); o += 2;
  const n = compactDecode(p, o); assert.equal(n.value, 3n); o = n.next;
  const t = compactDecode(p, o); assert.equal(t.value, 0n); o = t.next;
  assert.equal(p[o], 0x00, 'metadata-hash mode disabled'); o += 1;
  assert.equal(new DataView(p.buffer, p.byteOffset + o, 4).getUint32(0, true), 153); o += 4;
  assert.equal(new DataView(p.buffer, p.byteOffset + o, 4).getUint32(0, true), 6); o += 4;
  assert.deepEqual(p.slice(o, o + 32), new Uint8Array(32).fill(0xaa)); o += 32;
  assert.deepEqual(p.slice(o, o + 32), new Uint8Array(32).fill(0xbb)); o += 32;
  assert.equal(o, p.length);
  assert.ok(p.length < 256, 'transfer payload must stay under the 256-byte hash threshold');
});

test('buildExtrinsic: 0x84, length prefix, variant byte, total layout', () => {
  const accountId = new Uint8Array(32).fill(1);
  const call = buildTransferCall(new Uint8Array(32).fill(7), 1000n);
  const sigWire = new Uint8Array(1 + 3309 + 1952).fill(0xcc);
  sigWire[0] = 1; // Dilithium65 variant
  const xt = buildExtrinsic({
    accountId, signatureWire: sigWire,
    era: encodeMortalEra(64, 5), nonce: 0, tip: 0n, call,
  });
  const { value: bodyLen, next } = compactDecode(xt, 0);
  assert.equal(Number(bodyLen), xt.length - next);
  const body = xt.slice(next);
  assert.equal(body[0], 0x84);
  assert.equal(body[1], 0x00); // MultiAddress::Id
  assert.deepEqual(body.slice(2, 34), accountId);
  assert.equal(body[34], 1, 'DilithiumSignatureScheme::Dilithium65 = variant 1');
  assert.equal(body.length, 1 + 1 + 32 + sigWire.length + 2 + 1 + 1 + 1 + call.length);
});

test('decodeAccountInfo: field layout', () => {
  const buf = new Uint8Array(4 * 4 + 16 * 3 + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 7, true);          // nonce
  dv.setUint32(4, 0, true);          // consumers
  dv.setUint32(8, 1, true);          // providers
  dv.setUint32(12, 0, true);         // sufficients
  dv.setBigUint64(16, 1234567890123n, true); // free lo
  dv.setBigUint64(24, 0n, true);             // free hi
  const info = decodeAccountInfo(buf);
  assert.equal(info.nonce, 7);
  assert.equal(info.free, 1234567890123n);
  assert.equal(info.reserved, 0n);
});

test('units: plancks <-> QTC', () => {
  assert.equal(plancksToQtc(1000000000000n), '1');
  assert.equal(plancksToQtc(1500000000000n), '1.5');
  assert.equal(plancksToQtc(1000000000n), '0.001');
  assert.equal(qtcToPlancks('1.5'), 1500000000000n);
  assert.equal(qtcToPlancks('0.001'), 1000000000n);
  assert.throws(() => qtcToPlancks('abc'));
  assert.throws(() => qtcToPlancks('1.1234567890123')); // >12 decimals
});

test('u32le', () => {
  assert.deepEqual(u32le(153), Uint8Array.of(0x99, 0x00, 0x00, 0x00));
});
