/* QTC Extrinsic Lab — test suite (node).
 * Builds REAL signed extrinsics with noble ML-DSA (same primitives as the web
 * wallet), then decodes them with js/decode.js and verifies signatures with
 * js/verify.js. A tamper test proves verification actually checks the signature.
 * Run: node tests/run-tests.mjs  (from pages/extrinsic-lab/)
 */
import { createRequire } from 'node:module';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';
import { blake2b } from '../../../assets/vendor/noble/hashes/blake2.js';

const require = createRequire(import.meta.url);
const CALLS = require('../js/call-table.js');
// vendor globals needed by decode.js display helpers (ss58 + human checkphrase)
globalThis.QSS58 = require('../js/vendor/ss58.js');
globalThis.QTC_WORDLIST = require('../js/vendor/wordlist.js');
globalThis.QTC_CHECK = require('../js/vendor/checkphrase-core.js');
const D = require('../js/decode.js');
// verify.js reads global.QEL_NOBLE + global.QEL_DECODE; wire them up first
globalThis.QEL_DECODE = D;
globalThis.QEL_NOBLE = { ml_dsa65, ml_dsa87, blake2b };
const V = require('../js/verify.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  const x = typeof a === 'bigint' ? a.toString() : JSON.stringify(a);
  const y = typeof b === 'bigint' ? b.toString() : JSON.stringify(b);
  if (x !== y) throw new Error((msg || 'mismatch') + ': got ' + x + ' want ' + y);
}

const E = require('../js/encode.js');
const compactEncode = E.compactEncode;

/* ---------- test extrinsic builder (via js/encode.js) ---------- */
function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n), true); return b; }
function ctz(n) { let c = 0; while ((n & 1) === 0 && c < 64) { n = Math.floor(n / 2); c++; } return c; }
function encodeMortalEra(period, phase) {
  const quantize = Math.max(1, Math.floor(period / 4096));
  const encoded = (Math.min(15, Math.max(1, ctz(period) - 1))) | ((Math.floor(phase / quantize)) << 4);
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, encoded, true); return b;
}
function buildCallTransfer(dest32, plancks) {
  return D.concatBytes([Uint8Array.of(2, 3, 0x00), dest32, E.compactEncode(plancks)]);
}
function signAndAssemble({ kp, scheme, call, era, nonce, tip, specVersion, txVersion, genesisHash, birthHash }) {
  const mod = scheme === 87 ? ml_dsa87 : ml_dsa65;
  const hex = E.encodeExtrinsic({
    callBytes: call, pub32: kp.accountId, pubKey: kp.publicKey,
    sigVariant: scheme === 87 ? 0 : 1,
    eraBytes: era, nonce, tip, metadataHashMode: 0,
    specVersion, txVersion, genesisHash, eraBirthHash: birthHash,
    signFn: (msg) => mod.sign(msg, kp.secretKey, { context: new TextEncoder().encode('QUANTUS_EXTRINSIC') }),
  });
  const built = D.buildSigningPayload(
    { callBytes: call, eraBytes: era, nonce, tip, metadataHashMode: 0 },
    { specVersion, txVersion, genesisHash, eraBirthHash: birthHash });
  return { hex, built, kp };
}
function rand32(seed) { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 7) & 255; return b; }

const SPEC = 153, TXV = 6;
const GENESIS = rand32(1), BIRTH = rand32(2);

console.log('QTC Extrinsic Lab tests');

/* ---------- 1: transfer_keep_alive round trip ---------- */
test('decode signed transfer_keep_alive (ML-DSA-65)', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(9);
  const dest = rand32(10);
  const { hex } = signAndAssemble({ kp, scheme: 65, call: buildCallTransfer(dest, 1500000000000n), era: Uint8Array.of(0), nonce: 7n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assert(d.lengthOk, 'length prefix must match');
  assert(d.version.signed && d.version.format === 4, 'signed v4');
  assertEq(d.nonce, 7n, 'nonce');
  assertEq(d.tip, 0n, 'tip');
  assert(d.era.immortal, 'immortal era');
  assertEq(d.call.palletName, 'Balances', 'pallet');
  assertEq(d.call.callName, 'transfer_keep_alive', 'call');
  assertEq(d.call.args[1].decoded, 1500000000000n, 'amount');
  assert(d.call.args[0].decoded.account.ss58.startsWith('qz'), 'dest ss58 prefix qz, got ' + d.call.args[0].decoded.account.ss58);
  assert(d.call.args[0].decoded.account.checkphrase.split(' ').length >= 3, 'checkphrase words present');
  assert(d.signature.scheme === 'ML-DSA-65', 'scheme');
  assertEq(d.trailing, 0, 'no trailing bytes');
});

test('verify signature of decoded transfer (valid)', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(11);
  const dest = rand32(12);
  const { hex, kp: k2 } = signAndAssemble({ kp, scheme: 65, call: buildCallTransfer(dest, 2500000000000n), era: Uint8Array.of(0), nonce: 3n, tip: 1000n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex); d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === true, 'signature must verify, err=' + r.error);
  assert(r.hashed === false, 'small payload not hashed');
});

test('tampered payload fails verification', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(13);
  const dest = rand32(14);
  const call = buildCallTransfer(dest, 1000000000000n);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 1n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  // flip one amount byte deep in the call section, keeping the signature intact
  const raw = D.hexToBytes(hex);
  const d0 = D.decodeExtrinsic(hex);
  const amtByte = d0.call.args[1].start + 1;
  raw[amtByte] ^= 0x01;
  const hex2 = '0x' + D.bytesToHex(raw);
  const d = D.decodeExtrinsic(hex2); d._hex = hex2;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === false, 'tampered payload must NOT verify');
});

/* ---------- 2: ML-DSA-87 + mortal era ---------- */
test('decode + verify ML-DSA-87 mortal-era extrinsic', () => {
  const kp = ml_dsa87.keygen(); kp.accountId = rand32(15);
  const dest = rand32(16);
  const era = encodeMortalEra(64, 8);
  const { hex } = signAndAssemble({ kp, scheme: 87, call: buildCallTransfer(dest, 500000000000n), era, nonce: 12n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: BIRTH });
  const d = D.decodeExtrinsic(hex);
  assert(!d.era.immortal && d.era.period === 64 && d.era.phase === 8, 'mortal era 64/8, got ' + JSON.stringify({ p: d.era.period, ph: d.era.phase }));
  assert(d.signature.scheme === 'ML-DSA-87', 'scheme 87');
  assertEq(V.birthFor(d, 100), 72, 'birth block at height 100');
  d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: BIRTH, eraBirth: 72 });
  assert(r.ok === true, 'mortal sig verifies, err=' + r.error);
});

/* ---------- 3: batch_all with nested calls (payload > 256B hashing rule) ---------- */
test('batch_all nested decode + hashed-payload verify', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(17);
  const inners = [];
  for (let i = 0; i < 6; i++) inners.push(buildCallTransfer(rand32(20 + i), BigInt(1000000000000 + i)));
  const batchCall = D.concatBytes([Uint8Array.of(9, 2), compactEncode(inners.length), ...inners]);
  const { hex, built } = signAndAssemble({ kp, scheme: 65, call: batchCall, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  assert(built.hashed === true, 'batch payload must exceed 256 bytes');
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'batch_all', 'batch_all');
  const vec = d.call.args[0].decoded;
  assertEq(vec.len, 6, 'six inner calls');
  assertEq(vec.items[0].value.call.callName, 'transfer_keep_alive', 'inner call name');
  assertEq(vec.items[5].value.call.args[1].decoded, 1000000000005n, 'inner amount');
  d._hex = hex;
  const r = V.verifyExtrinsic(d, { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS });
  assert(r.ok === true && r.hashed === true, 'hashed payload verifies');
});

/* ---------- 4: schedule_transfer (plain u128, NOT compact) ---------- */
test('schedule_transfer decodes plain-u128 amount', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(30);
  const dest = rand32(31);
  const amt = new Uint8Array(16); new DataView(amt.buffer).setBigUint64(0, 777000000000000n, true);
  const call = D.concatBytes([Uint8Array.of(11, 3, 0x00), dest, amt]);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 2n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'schedule_transfer', 'call name');
  assertEq(d.call.args[1].decoded, 777000000000000n, 'plain u128 amount');
  assertEq(d.trailing, 0, 'exact consumption proves u128-not-compact');
});

/* ---------- 5: multisig create + propose with embedded call ---------- */
test('multisig create_multisig + propose(callbytes) decode', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(40);
  const s1 = rand32(41), s2 = rand32(42);
  const signers = D.concatBytes([compactEncode(2), s1, s2]);
  const call = D.concatBytes([Uint8Array.of(19, 0), signers, u32le(2), (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, 99n, true); return b; })()]);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 5n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.callName, 'create_multisig', 'call name');
  assertEq(d.call.args[0].decoded.len, 2, 'two signers');
  assertEq(d.call.args[1].decoded, 2, 'threshold');
  assertEq(d.call.args[2].decoded, 99n, 'nonce u64');

  // propose with embedded transfer call bytes
  const inner = buildCallTransfer(rand32(43), 1000000000n);
  const call2 = D.concatBytes([Uint8Array.of(19, 1), rand32(44), compactEncode(inner.length), inner, u32le(5000)]);
  const b2 = signAndAssemble({ kp, scheme: 65, call: call2, era: Uint8Array.of(0), nonce: 6n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d2 = D.decodeExtrinsic(b2.hex);
  assertEq(d2.call.callName, 'propose', 'propose');
  assertEq(d2.call.callName && d2.call.args[1].decoded.call.callName, 'transfer_keep_alive', 'embedded call decoded');
  assertEq(d2.call.args[2].decoded, 5000, 'expiry');
});

/* ---------- 6: unsigned inherent (timestamp.set) ---------- */
test('unsigned inherent decodes without signer section', () => {
  const now = compactEncode(1759272000000n);
  const body = D.concatBytes([Uint8Array.of(0x04, 1, 0), now]);
  const hex = '0x' + D.bytesToHex(D.concatBytes([compactEncode(body.length), body]));
  const d = D.decodeExtrinsic(hex);
  assert(!d.version.signed, 'unsigned');
  assertEq(d.call.palletName, 'Timestamp', 'pallet');
  assertEq(d.call.callName, 'set', 'call');
  assertEq(d.call.args[0].decoded, 1759272000000n, 'moment');
});

/* ---------- 7: unknown pallet/call honesty ---------- */
test('unknown pallet index is labeled, not thrown', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(50);
  const call = Uint8Array.of(99, 0, 1, 2, 3);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assert(d.call.unknown && d.call.unknown.indexOf('pallet index 99') === 0, 'honest unknown label');
});
test('unknown call index within known pallet is labeled', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(51);
  const call = Uint8Array.of(2, 99, 7, 7, 7);
  const { hex } = signAndAssemble({ kp, scheme: 65, call, era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex);
  assertEq(d.call.palletName, 'Balances', 'pallet still known');
  assert(d.call.unknown && d.call.unknown.indexOf('call index 99') === 0, 'honest unknown call label');
});
test('malformed hex gives a clear error', () => {
  let threw = false;
  try { D.decodeExtrinsic('0xzzzz'); } catch (e) { threw = /not valid hex/.test(e.message); }
  assert(threw, 'clear hex error');
});
test('bad signature variant gives a clear error', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(52);
  const call = buildCallTransfer(rand32(53), 1n);
  const era = Uint8Array.of(0);
  const body = D.concatBytes([Uint8Array.of(0x84, 0x00), kp.accountId, Uint8Array.of(0x07), era, compactEncode(0n), compactEncode(0n), Uint8Array.of(0), call]);
  const hex = '0x' + D.bytesToHex(D.concatBytes([compactEncode(body.length), body]));
  let threw = false;
  try { D.decodeExtrinsic(hex); } catch (e) { threw = /unknown signature scheme variant 7/.test(e.message); }
  assert(threw, 'clear sig variant error');
});

/* ---------- 8: era vectors ---------- */
test('era decode vectors', () => {
  const r = new D.Reader(Uint8Array.of(0));
  assert(D.decodeEra(r).immortal === true, '0x00 immortal');
  // period 64, phase 8 -> enc = (ctz(64)-1) | (8/1)<<4 = 5 | 128 = 133 -> LE bytes 0x85 0x00
  const e = D.decodeEra(new D.Reader(Uint8Array.of(0x85, 0x00)));
  assert(e.period === 64 && e.phase === 8, 'mortal 64/8');
  assertEq(D.eraBirth(100, 64, 8), 72, 'birth block');
});

/* ---------- 9: compact codec round-trip (all four modes) ---------- */
test('compact round-trip all modes', () => {
  // regression: mode-2 decode once consumed the already-read first byte (u32le over-read)
  const vals = [0n, 1n, 63n, 64n, 1000n, 16383n, 16384n, 1000000000n, 1073741823n, 1073741824n, (1n << 64n) - 1n, 1n << 100n];
  for (const v of vals) {
    const enc = E.compactEncode(v);
    const got = new D.Reader(enc).compact();
    assertEq(got, v, 'compact(' + v + ')');
  }
  // canonical byte shapes per mode
  assertEq(D.bytesToHex(E.compactEncode(63n)), 'fc', 'mode0 max');
  assertEq(D.bytesToHex(E.compactEncode(64n)), '0101', 'mode1 min');
  assertEq(D.bytesToHex(E.compactEncode(16384n)), '02000100', 'mode2 min');
});

/* ---------- 10: RPC answer validators (the node is untrusted) ---------- */
const R = require('../js/rpc-validate.js');
test('parseBlockNumber accepts int / decimal / 0x-hex only', () => {
  assertEq(R.parseBlockNumber(195564), 195564, 'int');
  assertEq(R.parseBlockNumber('195564'), 195564, 'decimal string');
  assertEq(R.parseBlockNumber('0x2fbec'), 195564, 'hex string');
  assertEq(R.parseBlockNumber(0), 0, 'zero');
  for (const bad of [-1, 1.5, NaN, 'garbage', '0xZZ', '12.5', '-3', {}, [], null, undefined, '9007199254740993']) {
    assertEq(R.parseBlockNumber(bad), null, 'reject ' + JSON.stringify(bad));
  }
});
test('isHash32 accepts exactly 0x + 64 hex digits', () => {
  assert(R.isHash32('0x' + 'ab'.repeat(32)), 'valid hash');
  assert(R.isHash32('0x' + 'AB'.repeat(32)), 'uppercase hash');
  for (const bad of ['0x' + 'ab'.repeat(31), '0x' + 'ab'.repeat(33), 'ab'.repeat(32), '0xZZ' + 'ab'.repeat(31), '', {}, null, 42]) {
    assert(!R.isHash32(bad), 'reject ' + JSON.stringify(bad));
  }
});
test('parseVersionNumber accepts u32 shapes, rejects objects/floats/negatives', () => {
  assertEq(R.parseVersionNumber(153), 153, 'int');
  assertEq(R.parseVersionNumber('6'), 6, 'decimal string');
  for (const bad of [{ spec: 153 }, 1.5, -1, 'latest', null, undefined]) {
    assertEq(R.parseVersionNumber(bad), null, 'reject ' + JSON.stringify(bad));
  }
});
test('validExtrinsicHex accepts even 0x hex >= 1 byte only', () => {
  assert(R.validExtrinsicHex('0x8400'), 'short valid');
  assert(R.validExtrinsicHex('0x' + 'aa'.repeat(100)), 'long valid');
  for (const bad of ['0x', '0x0', '0xZZ', 'aa', '', {}, null, 123, ['0x84']]) {
    assert(!R.validExtrinsicHex(bad), 'reject ' + JSON.stringify(bad));
  }
});
/* Round 2 — relations: a version is a u32 (2^32 would wrap in the
 * payload's u32le) and a height must be able to name a block on this
 * chain (fleet bound 10,000,000; genesis 0 valid over RPC). */
test('parseVersionNumber enforces the u32 bound it documents', () => {
  assertEq(R.parseVersionNumber(4294967295), 4294967295, 'u32 max');
  assertEq(R.parseVersionNumber('4294967295'), 4294967295, 'u32 max string');
  for (const bad of [4294967296, '4294967296', '0x100000000', 9007199254740991]) {
    assertEq(R.parseVersionNumber(bad), null, 'reject over-u32 ' + JSON.stringify(bad));
  }
});
test('validChainHeight bounds heights to the fleet 10,000,000 cap', () => {
  assertEq(R.validChainHeight(0), 0, 'genesis valid over RPC');
  assertEq(R.validChainHeight(204469), 204469, 'current head');
  assertEq(R.validChainHeight('0x2fbec'), 195564, 'hex head');
  assertEq(R.validChainHeight(10000000), 10000000, 'cap inclusive');
  for (const bad of [10000001, 99999999999, '99999999999', -1, 1.5, 'garbage', null]) {
    assertEq(R.validChainHeight(bad), null, 'reject ' + JSON.stringify(bad));
  }
});
test('verifyExtrinsic refuses out-of-range versions instead of wrapping them', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(60);
  const { hex } = signAndAssemble({ kp, scheme: 65, call: buildCallTransfer(rand32(61), 1000000000000n), era: Uint8Array.of(0), nonce: 1n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  const d = D.decodeExtrinsic(hex); d._hex = hex;
  for (const badCtx of [
    { specVersion: 4294967296, txVersion: TXV, genesisHash: GENESIS, eraBirthHash: GENESIS },
    { specVersion: SPEC, txVersion: -1, genesisHash: GENESIS, eraBirthHash: GENESIS },
    { specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS.subarray(0, 16), eraBirthHash: GENESIS },
  ]) {
    let threw = false;
    try { V.verifyExtrinsic(d, badCtx); } catch (e) { threw = /u32|32 bytes/.test(e.message); }
    assert(threw, 'must throw a clear bound error for ' + JSON.stringify({ s: String(badCtx.specVersion), t: String(badCtx.txVersion), g: badCtx.genesisHash.length }));
  }
  // eraBirth overshoot documents why the app must gate target >= birth:
  // at a head below the era phase, eraBirth lands AFTER the head.
  assertEq(D.eraBirth(5, 64, 8), 8, 'eraBirth below phase overshoots the head');
  assertEq(D.eraBirth(100, 64, 8), 72, 'eraBirth at/above phase stays <= head');
});

/* ---------- 11: SCALE bool is a discriminant, not a coercion (round 3) ----------
 * Every other single-byte discriminant in decode.js is held to its
 * producer set (Option throws for >1, MultiAddress/signature/era reject
 * unknown forms), but bool used !!r.u8(): byte 0x02/0x80/0xFF painted as
 * a clean `true` keep_alive / aye. parity-scale-codec decodes bool as
 * 0x00 false / 0x01 true and errors on anything else — the runtime
 * rejects such an extrinsic outright, so the decoder must too. */
function transferAllCall(boolByte) {
  return D.concatBytes([Uint8Array.of(2, 4, 0x00), rand32(70), Uint8Array.of(boolByte)]);
}
function burnCall(boolByte) {
  return D.concatBytes([Uint8Array.of(2, 10), compactEncode(1n), Uint8Array.of(boolByte)]);
}
test('bool args decode 0x00 as false and 0x01 as true', () => {
  assertEq(D.decodeCallBytes(transferAllCall(0x00)).args[1].decoded, false, 'transfer_all keep_alive 0x00');
  assertEq(D.decodeCallBytes(transferAllCall(0x01)).args[1].decoded, true, 'transfer_all keep_alive 0x01');
  assertEq(D.decodeCallBytes(burnCall(0x00)).args[1].decoded, false, 'burn keep_alive 0x00');
  assertEq(D.decodeCallBytes(burnCall(0x01)).args[1].decoded, true, 'burn keep_alive 0x01');
});
test('bool args reject non-SCALE bytes 0x02 / 0x80 / 0xFF', () => {
  for (const bad of [0x02, 0x80, 0xff]) {
    for (const build of [transferAllCall, burnCall]) {
      let threw = false;
      try { D.decodeCallBytes(build(bad)); } catch (e) { threw = /bad bool encoding/.test(e.message); }
      assert(threw, 'byte 0x' + bad.toString(16) + ' must throw a bool error, not paint true');
    }
  }
});
test('a signed extrinsic carrying a poisoned bool byte fails decode', () => {
  const kp = ml_dsa65.keygen(); kp.accountId = rand32(71);
  const { hex } = signAndAssemble({ kp, scheme: 65, call: transferAllCall(0x02), era: Uint8Array.of(0), nonce: 0n, tip: 0n, specVersion: SPEC, txVersion: TXV, genesisHash: GENESIS, birthHash: GENESIS });
  let threw = false;
  try { D.decodeExtrinsic(hex); } catch (e) { threw = /bad bool encoding/.test(e.message); }
  assert(threw, 'poisoned keep_alive must fail the whole decode');
});

/* ---------- 12: checkphrase derivation budget (white-hat) ----------
 * A checkphrase is display-only, but each derivation is a synchronous
 * 40,000-iteration PBKDF2 (~0.6 s in Node). accountDisplay derived one
 * for EVERY decoded account with no dedupe: a crafted batch_all of 30
 * distinct dests burned 30 sequential KDFs (~21 s measured) on the
 * Autopsy click, and a duplicated dest paid twice. Derivations are now
 * capped per top-level decode and memoized across decodes. */
test('checkphraseRoom arithmetic is exact and fail-closed', () => {
  assertEq(D.MAX_CHECKPHRASE_DERIVATIONS, 10, 'cap is 10');
  assertEq(D.checkphraseRoom(0), 10, 'full budget at 0 used');
  assertEq(D.checkphraseRoom(9), 1, 'one left at 9');
  assertEq(D.checkphraseRoom(10), 0, 'zero at cap');
  assertEq(D.checkphraseRoom(99), 0, 'zero past cap');
  for (const bad of [-1, NaN, 1.5, '3', null, undefined]) {
    assertEq(D.checkphraseRoom(bad), 0, 'fail-closed for ' + JSON.stringify(bad));
  }
});
test('a duplicated dest derives once and both rows keep the phrase', () => {
  const inner = buildCallTransfer(rand32(950), 1000000000000n);
  const batch = D.concatBytes([Uint8Array.of(9, 2), compactEncode(2), inner, inner]);
  const c = D.decodeCallBytes(batch);
  assert(c.checkphrases && c.checkphrases.derived === 1 && c.checkphrases.skipped === 0,
    'one derivation for two identical dests, got ' + JSON.stringify(c.checkphrases));
  const items = c.args[0].decoded.items;
  assert(items[0].value.call.args[0].decoded.account.checkphrase, 'first dest phrased');
  assertEq(items[1].value.call.args[0].decoded.account.checkphrase,
           items[0].value.call.args[0].decoded.account.checkphrase, 'second dest reuses the phrase');
});
test('derivations stop at the cap and skipped accounts stay honest', () => {
  const inners = [];
  for (let i = 0; i < 12; i++) inners.push(buildCallTransfer(rand32(900 + i), 1000000000000n));
  const batchCall = D.concatBytes([Uint8Array.of(9, 2), compactEncode(inners.length), ...inners]);
  const body = D.concatBytes([Uint8Array.of(0x04), batchCall]);
  const hex = '0x' + D.bytesToHex(D.concatBytes([compactEncode(body.length), body]));
  const d = D.decodeExtrinsic(hex);
  assert(d.checkphrases && d.checkphrases.derived === 10 && d.checkphrases.skipped === 2 && d.checkphrases.cap === 10,
    'stats report the bound, got ' + JSON.stringify(d.checkphrases));
  const items = d.call.args[0].decoded.items;
  assert(items[0].value.call.args[0].decoded.account.checkphrase, 'first dest within budget is phrased');
  const past = items[11].value.call.args[0].decoded.account;
  assert(past.checkphrase === null && past.checkphraseSkipped === true && past.ss58.startsWith('qz'),
    'past-budget account keeps its address, phrase honestly skipped');
});

/* ---------- 13: hex-input parse bound (white-hat) ----------
 * hexToBytes stripped, regex-tested and parseInt-looped the WHOLE
 * paste before the decoder read the length prefix that rejects it:
 * a 20,000,000-char paste built a 10,000,000-byte array (~0.5 s in
 * Node) per Autopsy click, and Live-scan entries from a node faced
 * no bound at all. The cap (1,048,576 chars = 524,288 plain bytes)
 * is ~71x the largest signed single-call extrinsic the lab's own
 * encoder produces (ML-DSA-87 transfer: 7,302 bytes, measured) and
 * admits a 1,000-leg batch_all (49,266 bytes) plain or byte-spaced. */
test('hexInputRoom arithmetic is exact and fail-closed', () => {
  assertEq(D.MAX_HEX_INPUT_CHARS, 1048576, 'cap is 1,048,576 chars');
  assertEq(D.hexInputRoom(0), 1048576, 'full room at 0 chars');
  assertEq(D.hexInputRoom(1048575), 1, 'one left at cap-1');
  assertEq(D.hexInputRoom(1048576), 0, 'zero at cap');
  assertEq(D.hexInputRoom(2000000), 0, 'zero past cap');
  for (const bad of [-1, NaN, 1.5, '100', null, undefined, Infinity]) {
    assertEq(D.hexInputRoom(bad), 0, 'fail-closed for ' + JSON.stringify(bad));
  }
});
test('endpoint URL length bound before connect (white-hat)', () => {
  // The rpc-url field reached new WebSocket with at most a scheme
  // regex (the context fetch had no check at all) and no length
  // bound. Cap 2,048 is >4x the largest genuine endpoint (hostname
  // ≤253 per RFC 1035 + the rest well under 500 total).
  assertEq(D.MAX_ENDPOINT_URL_CHARS, 2048, 'cap is 2,048 chars');
  assertEq(D.endpointUrlRoom(0), 2048, 'full room at 0 chars');
  assertEq(D.endpointUrlRoom(2048), 0, 'zero at cap');
  assertEq(D.endpointUrlRoom(2049), 0, 'zero past cap');
  for (const bad of [-1, NaN, 1.5, '100', null, undefined, Infinity]) {
    assertEq(D.endpointUrlRoom(bad), 0, 'fail-closed for ' + JSON.stringify(bad));
  }
  assert(D.validateEndpointUrl('wss://rpc.quantus.network').ok, 'genuine endpoint ok');
  const atCap = 'ws://127.0.0.1:9944/' + 'p'.repeat(2048 - 'ws://127.0.0.1:9944/'.length);
  assertEq(atCap.length, 2048, 'at-cap fixture is exactly 2,048');
  assert(D.validateEndpointUrl(atCap).ok, 'exactly-cap endpoint still validates');
  const over = D.validateEndpointUrl(atCap + 'p');
  assert(!over.ok && /2049/.test(over.error) && /2048/.test(over.error), 'over-cap refusal names size + cap: ' + over.error);
  const huge = D.validateEndpointUrl('wss://' + 'a'.repeat(20000000));
  assert(!huge.ok && /20000006/.test(huge.error), '20M-char paste refused before connecting: ' + huge.error);
  assert(!D.validateEndpointUrl('https://example.com').ok, 'http refused');
  assert(!D.validateEndpointUrl('').ok, 'empty refused');
  assert(!D.validateEndpointUrl(null).ok, 'non-string refused');
});
test('hexToBytes refuses over-cap inputs unparsed, cap still parses', () => {
  let err = null;
  try { D.hexToBytes('0x' + 'ab'.repeat(524288)); } catch (e) { err = e; }  // cap + 2 chars
  assert(err && /too long/i.test(err.message) && err.message.includes('1048576'),
    'over-cap refusal names the cap, got ' + (err && err.message));
  err = null;
  try { D.hexToBytes('ab'.repeat(1000000)); } catch (e) { err = e; }        // 2,000,000 chars
  assert(err && /too long/i.test(err.message), '2M-char input refused before parsing');
  const atCap = D.hexToBytes('ab'.repeat(524288));                          // exactly cap
  assert(atCap.length === 524288, 'exactly-cap input parses to 524,288 bytes');
  assert(D.hexToBytes('0x' + 'ab'.repeat(32)).length === 32, 'normal hash hex still parses');
});
test('decodeExtrinsic refuses a 20M-char paste before parsing', () => {
  let err = null;
  try { D.decodeExtrinsic('0x' + 'ab'.repeat(10000000)); } catch (e) { err = e; }
  assert(err && /too long/i.test(err.message),
    'the top-level decode surfaces the cap refusal, got ' + (err && err.message));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
