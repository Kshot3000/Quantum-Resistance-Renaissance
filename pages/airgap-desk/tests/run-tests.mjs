/* QTC Airgap Desk — protocol tests. Run: node tests/run-tests.mjs
 * Covers: base64url, ticket encode/validate, chunk encode/reassemble,
 * mortal-era decode mirroring, and the full offline signing protocol:
 * cold builds + signs a transfer from a ticket, hot decodes, re-derives the
 * payload, and verifies the ML-DSA signature — with tamper cases failing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  b64urlEncode, b64urlDecode,
  makeTicket, encodeTicket, decodeTicket,
  encodeChunks, decodeChunks,
  decodeMortalEra, decodeSignedExtrinsic, decodeForVerify,
  buildColdPayload, buildColdExtrinsic, reverifySigned,
  computeServiceFee, feeBpsLabel, serviceFeeAccountId,
  SERVICE_FEE_ADDRESS, SERVICE_FEE_MAX_BPS,
} from '../js/airgap.js';
import { encodeMortalEra, qtcToPlancks, buildTransferCall, buildBatchAllCall, buildSigningPayload, buildExtrinsic } from '../js/lib/scale.js';
import { ss58Encode, ss58Decode, hexEncode, hexDecode, QUANTUS_SS58_PREFIX } from '../js/lib/quantus-crypto.js';
import { keypairFromSeed } from '../js/lib/mnemonic.js';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';
import { xxhash128, SYSTEM_ACCOUNT_KEY } from '../js/lib/xxhash.js';

const te = new TextEncoder();
const GENESIS = '0x' + 'ab'.repeat(32);
const BIRTHH = '0x' + 'cd'.repeat(32);
const HEADH = '0x' + 'ef'.repeat(32);

function fixtureTicket(over = {}) {
  const sender = keypairFromSeed(new Uint8Array(32).fill(9), 65);
  return makeTicket({
    addr: sender.address, nonce: 3,
    genesis: GENESIS, spec: 42, txv: 7,
    head: 1_234_500, headHash: HEADH,
    // birth is the eraBirth(head, 64, 52) value the real issuer derives
    // (rpc.js getEraBirthHash): 1_234_484 — congruent to phase mod period
    // with the window [birth, birth+period) containing head 1_234_500.
    era: { period: 64, phase: 52, birth: 1_234_484, birthHash: BIRTHH },
    fee: '1500000000',
    issued: '2026-09-30T21:40:00.000Z',
    ...over,
  });
}

/* ---------------- base64url ---------------- */
test('b64url: round-trip incl. padding edge lengths', () => {
  for (const len of [0, 1, 2, 3, 31, 32, 64, 900]) {
    const b = new Uint8Array(len).map((_, i) => (i * 7 + 3) & 0xff);
    const s = b64urlEncode(b);
    assert.ok(/^[A-Za-z0-9\-_]*$/.test(s), 'url-safe alphabet');
    assert.deepEqual(b64urlDecode(s), b);
  }
});

test('b64url: rejects non-alphabet', () => {
  assert.throws(() => b64urlDecode('abc+def'), /base64url/);
});

/* ---------------- ticket ---------------- */
test('ticket: encode/decode round-trip validates strictly', () => {
  const t = fixtureTicket();
  const s = encodeTicket(t);
  assert.ok(s.startsWith('QAGT1:'));
  const d = decodeTicket(s);
  assert.equal(d.addr, t.addr);
  assert.equal(d.nonce, 3);
  assert.equal(d.spec, 42);
  assert.equal(d.era.period, 64);
  assert.equal(d.fee, '1500000000');
  assert.equal(d.senderAccountId.length, 32);
});

test('ticket: wrong-network prefix rejected', () => {
  const acct = new Uint8Array(32).fill(9);
  const bad = fixtureTicket({ addr: ss58Encode(acct, 42) });
  assert.throws(() => decodeTicket(encodeTicket(bad)), /prefix 42/);
});

test('ticket: bad checksum / garbage rejected', () => {
  const t = fixtureTicket();
  const s = encodeTicket(t);
  assert.throws(() => decodeTicket(s + '!'), /not a QTC chain ticket/);
  const tampered = 'QAGT1:' + s.slice(6, -2) + 'xx';
  assert.throws(() => decodeTicket(tampered), /JSON|ticket/);
  assert.throws(() => decodeTicket('QAGX:aa:1/1:xx'), /not a QTC chain ticket/);
});

test('ticket: unsupported version rejected', () => {
  const t = { ...fixtureTicket(), v: 99 };
  assert.throws(() => decodeTicket(encodeTicket(t)), /unsupported version/);
});

test('ticket: negative nonce rejected', () => {
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ nonce: -1 }))), /nonce/);
});

/* Round 2: era fields are one claim — relations, not just shapes. The
 * fixture era is (period 64, phase 52, birth 1_234_484, head 1_234_500);
 * each case below breaks exactly one relation a genuine issuer's ticket
 * (rpc.js getEraBirthHash: phase = head % period, birth = eraBirth(...))
 * always satisfies. */
test('ticket: era relations enforced (round 2)', () => {
  const era = (over) => fixtureTicket({ era: { period: 64, phase: 52, birth: 1_234_484, birthHash: BIRTHH, ...over } });
  assert.throws(() => decodeTicket(encodeTicket(era({ period: 100 }))), /power of two/);
  assert.throws(() => decodeTicket(encodeTicket(era({ period: 2 }))), /power of two/);
  assert.throws(() => decodeTicket(encodeTicket(era({ period: 131072 }))), /power of two/);
  assert.throws(() => decodeTicket(encodeTicket(era({ phase: 64, birth: 1_234_436 }))), /phase must be below/);
  assert.throws(() => decodeTicket(encodeTicket(era({ birth: 1_234_496 }))), /congruent/);
  assert.throws(() => decodeTicket(encodeTicket(era({ phase: 4, birth: 1_234_564 }))), /after the ticket head/);
  assert.throws(() => decodeTicket(encodeTicket(era({ phase: 4, birth: 1_234_436 }))), /already expired/);
  const big = fixtureTicket({ head: 1_234_500, era: { period: 8192, phase: 3, birth: 1_228_803, birthHash: BIRTHH } });
  assert.throws(() => decodeTicket(encodeTicket(big)), /quantize step/);
});

test('ticket: nonce must fit u32 (producer grammar)', () => {
  // The issuer's parseNonce bounds the nonce to u32 before a ticket
  // exists; u32-max itself is producer-legal and survives.
  assert.equal(decodeTicket(encodeTicket(fixtureTicket({ nonce: 4294967295 }))).nonce, 4294967295);
  assert.equal(decodeTicket(encodeTicket(fixtureTicket({ nonce: 0 }))).nonce, 0);
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ nonce: 4294967296 }))), /nonce must fit u32/);
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ nonce: 9007199254740991 }))), /nonce must fit u32/);
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ nonce: 1e21 }))), /nonce must fit u32/);
  // Raw-JSON precision: the ticket text carries ...993, JSON.parse reads
  // ...992 — the value signed must never silently differ from the text.
  const raw = JSON.stringify(fixtureTicket({ nonce: 9007199254740993 }));
  const s = 'QAGT1:' + b64urlEncode(te.encode(raw));
  assert.throws(() => decodeTicket(s), /nonce must fit u32/);
});

test('ticket: spec/tx versions must fit u32 (round 2)', () => {
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ spec: 4294967296 }))), /fit u32/);
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ txv: 4294967296 }))), /fit u32/);
  assert.throws(() => decodeTicket(encodeTicket(fixtureTicket({ head: 10000001 }))), /chain-height bound/);
});

/* ---------------- chunks ---------------- */
test('chunks: encode/reassemble round-trip, shuffled + duplicated', () => {
  const hex = '0x' + 'deadbeef'.repeat(1500); // 6000 bytes
  const chunks = encodeChunks('a1b2', hex, 900);
  assert.ok(chunks.length > 3, 'multi-chunk expected');
  assert.ok(chunks[0].startsWith('QAGX:a1b2:1/'));
  const shuffled = [...chunks].reverse();
  shuffled.push(chunks[0], chunks[2]); // duplicates tolerated
  const { sessionId, hex: back } = decodeChunks(shuffled);
  assert.equal(sessionId, 'a1b2');
  assert.equal(back.toLowerCase(), hex.toLowerCase());
});

test('chunks: missing chunk detected', () => {
  const chunks = encodeChunks('c3', '0x' + 'ff'.repeat(3000), 500);
  assert.throws(() => decodeChunks(chunks.slice(1)), /missing chunk/);
});

test('chunks: mixed sessions + malformed lines rejected', () => {
  const a = encodeChunks('aa', '0x' + 'ff'.repeat(1200), 500);
  const b = encodeChunks('bb', '0x' + 'ff'.repeat(1200), 500);
  assert.throws(() => decodeChunks([...a, ...b]), /more than one session/);
  assert.throws(() => decodeChunks(['hello world']), /malformed chunk/);
  assert.throws(() => decodeChunks([]), /no chunks/);
});

/* Round 2: duplicates must be IDENTICAL copies, non-final chunks share
 * one byte size (the encoder slices uniformly), and the count is bounded
 * so a hostile header is refused instantly. */
test('chunks: conflicting duplicate rejected (round 2)', () => {
  const good = encodeChunks('a1b2', '0x' + 'deadbeef'.repeat(600), 900);
  const evil = encodeChunks('a1b2', '0x' + 'cafebabe'.repeat(600), 900);
  assert.throws(() => decodeChunks([good[0], evil[1], good[1], good[2]]), /conflicting duplicate/);
  const { hex } = decodeChunks([good[0], good[1], good[1], good[2]]); // identical dup still fine
  assert.equal(hex.toLowerCase(), ('0x' + 'deadbeef'.repeat(600)).toLowerCase());
});

test('chunks: short middle chunk rejected (round 2)', () => {
  const good = encodeChunks('a1b2', '0x' + 'deadbeef'.repeat(600), 900);
  const short = good[1].replace(/:[A-Za-z0-9\-_]+$/, (m) => ':' + m.slice(1, 40));
  assert.throws(() => decodeChunks([good[0], short, good[2]]), /chunk size/);
});

test('chunks: absurd count rejected instantly (round 2)', () => {
  assert.throws(() => decodeChunks(['QAGX:aa:1/999999999:xx']), /exceeds the session bound/);
});

test('chunks: single-chunk payload works', () => {
  const { hex } = decodeChunks(encodeChunks('1', '0x010203', 900));
  assert.equal(hex, '0x010203');
});

/* ---------------- era ---------------- */
test('era: decode mirrors encodeMortalEra', () => {
  for (const [period, phase] of [[64, 0], [64, 63], [256, 128], [4, 2]]) {
    const enc = encodeMortalEra(period, phase);
    const dec = decodeMortalEra(enc);
    assert.equal(dec.period, period);
    assert.equal(dec.phase, phase);
  }
  assert.ok(decodeMortalEra(new Uint8Array([0, 0])).immortal);
});

/* ---------------- full protocol ---------------- */

function coldSign({ scheme = 65, amount = '1.5', serviceFeePlancks = 0n } = {}) {
  const sender = keypairFromSeed(new Uint8Array(32).fill(9), scheme);
  const dest = keypairFromSeed(new Uint8Array(32).fill(7), 65);
  const ticket = fixtureTicket();
  const era = encodeMortalEra(ticket.era.period, ticket.era.phase);
  const amountPlancks = qtcToPlancks(amount);
  const payload = buildColdPayload({
    ticket, destAccountId: dest.accountId, amountPlancks, era, nonce: ticket.nonce, serviceFeePlancks,
  });
  const mod = scheme === 87 ? ml_dsa87 : ml_dsa65;
  const sig = mod.sign(payload, sender.secretKey, { context: te.encode('QUANTUS_EXTRINSIC') });
  const built = buildColdExtrinsic({
    ticket, senderAccountId: sender.accountId, destAccountId: dest.accountId,
    amountPlancks, era, nonce: ticket.nonce, scheme, serviceFeePlancks,
    signResult: { signature: sig, pubkey: sender.publicKey },
  });
  return { sender, dest, ticket, era, amountPlancks, payload, sig, built };
}

test('protocol: cold signs, hot decodes fields exactly', () => {
  const { dest, ticket, amountPlancks, built } = coldSign();
  const d = decodeSignedExtrinsic(built.extrinsicHex);
  assert.equal(d.scheme, 65);
  assert.equal(d.address, ticket.addr);
  assert.equal(d.call.destAddress, dest.address);
  assert.equal(d.call.amountPlancks, amountPlancks);
  assert.equal(d.nonce, 3n);
  assert.equal(d.tip, 0n);
  assert.equal(d.era.period, 64);
  assert.equal(d.call.pallet, 2);
  assert.equal(d.call.callIndex, 3);
});

test('protocol: hot re-verifies signature against the ORIGINAL ticket', () => {
  const { ticket, built } = coldSign();
  const d = decodeForVerify(built.extrinsicHex);
  const { ok } = reverifySigned({ ticket, decoded: d, mlDsa: ml_dsa65 });
  assert.ok(ok, 'valid package must verify');
});

test('protocol: tampered signature fails verification', () => {
  const { ticket, built } = coldSign();
  const d = decodeForVerify(built.extrinsicHex);
  d.signature = new Uint8Array(d.signature);
  d.signature[100] ^= 0xff;
  const { ok } = reverifySigned({ ticket, decoded: d, mlDsa: ml_dsa65 });
  assert.ok(!ok, 'tampered signature must not verify');
});

test('protocol: wrong ticket (different genesis) fails verification', () => {
  const { built } = coldSign();
  const wrong = fixtureTicket({ genesis: '0x' + '00'.repeat(32) });
  const d = decodeForVerify(built.extrinsicHex);
  const { ok } = reverifySigned({ ticket: wrong, decoded: d, mlDsa: ml_dsa65 });
  assert.ok(!ok, 'signature bound to another genesis must not verify');
});

test('protocol: ML-DSA-87 path works end to end', () => {
  const { ticket, built } = coldSign({ scheme: 87 });
  const d = decodeForVerify(built.extrinsicHex);
  assert.equal(d.scheme, 87);
  const { ok } = reverifySigned({ ticket, decoded: d, mlDsa: ml_dsa87 });
  assert.ok(ok);
});

/* ---------------- service fee (profit route) ---------------- */

test('ss58: reserved prefix forms are rejected, never read as prefix 189', () => {
  assert.throws(() => ss58Decode('KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC'), /Reserved SS58 prefix form/);
  assert.throws(() => ss58Decode('LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ'), /Reserved SS58 prefix form/);
});

test('fee: address pins — fee account id derives from the disclosed address', () => {
  const { prefix, accountId } = ss58Decode(SERVICE_FEE_ADDRESS);
  assert.equal(prefix, 189);
  assert.deepEqual(serviceFeeAccountId(), accountId);
  assert.equal(hexEncode(accountId).slice(0, 8), '88714241'); // fleet-pinned builder key
  assert.equal(SERVICE_FEE_MAX_BPS, 100);
});

test('fee: computeServiceFee is exact floor math, capped at 100 bps', () => {
  assert.deepEqual(computeServiceFee(1_000_000_000_000n, 50), { feePlancks: 5_000_000_000n, feeBps: 50 });
  assert.deepEqual(computeServiceFee(1_000_000_000_000n, 0), { feePlancks: 0n, feeBps: 0 });
  assert.deepEqual(computeServiceFee(1_000_000_000_000n, 10_000), { feePlancks: 10_000_000_000n, feeBps: 100 }); // capped
  assert.deepEqual(computeServiceFee(199n, 50), { feePlancks: 0n, feeBps: 50 }); // floors to zero
  assert.deepEqual(computeServiceFee(0n, 50), { feePlancks: 0n, feeBps: 50 });
  for (let amt = 1n; amt < 100_000n; amt += 977n)
    for (const bps of [25, 50, 100]) {
      const { feePlancks } = computeServiceFee(amt, bps);
      assert.ok(feePlancks * 10000n <= amt * BigInt(bps), 'fee never exceeds the quoted percentage');
      assert.ok(feePlancks === (amt * BigInt(bps)) / 10000n, 'fee is the exact floor');
    }
  assert.equal(feeBpsLabel(0), '0%');
  assert.equal(feeBpsLabel(25), '0.25%');
  assert.equal(feeBpsLabel(50), '0.5%');
  assert.equal(feeBpsLabel(100), '1%');
});

test('fee: fee-free call is byte-identical to the plain transfer', () => {
  // ML-DSA signing is hedged, so identity is asserted where it is
  // deterministic: the signing PAYLOAD (which embeds the call bytes).
  const ticket = fixtureTicket();
  const dest = keypairFromSeed(new Uint8Array(32).fill(7), 65);
  const era = encodeMortalEra(ticket.era.period, ticket.era.phase);
  const amountPlancks = qtcToPlancks('1.5');
  const args = { ticket, destAccountId: dest.accountId, amountPlancks, era, nonce: ticket.nonce };
  const plain = buildColdPayload(args);
  const zeroFee = buildColdPayload({ ...args, serviceFeePlancks: 0n });
  assert.deepEqual(zeroFee, plain);
  const withFee = buildColdPayload({ ...args, serviceFeePlancks: 1n });
  assert.notDeepEqual(withFee, plain);
  const d = decodeSignedExtrinsic(coldSign().built.extrinsicHex);
  assert.equal(d.call.batch, false);
  assert.equal(d.call.serviceFeePlancks, 0n);
  assert.equal(d.call.totalPlancks, d.call.amountPlancks);
});

test('fee: batch package decodes both legs exactly and re-verifies', () => {
  const amountPlancks = qtcToPlancks('1.5');
  const { feePlancks } = computeServiceFee(amountPlancks, 50);
  assert.ok(feePlancks > 0n);
  const { dest, ticket, built } = coldSign({ serviceFeePlancks: feePlancks });
  const d = decodeSignedExtrinsic(built.extrinsicHex);
  assert.equal(d.call.pallet, 9);
  assert.equal(d.call.callIndex, 2);
  assert.equal(d.call.batch, true);
  assert.equal(d.call.legs.length, 2);
  // recipient leg passes through untouched and FIRST
  assert.equal(d.call.legs[0].destAddress, dest.address);
  assert.equal(d.call.legs[0].amountPlancks, amountPlancks);
  assert.equal(d.call.destAddress, dest.address);
  assert.equal(d.call.amountPlancks, amountPlancks);
  // fee leg LAST, to the disclosed builder address, exact sum
  assert.equal(d.call.legs[1].destAddress, SERVICE_FEE_ADDRESS);
  assert.equal(d.call.serviceFeePlancks, feePlancks);
  assert.equal(d.call.serviceFeeDestAddress, SERVICE_FEE_ADDRESS);
  assert.equal(d.call.totalPlancks, amountPlancks + feePlancks);
  const dv = decodeForVerify(built.extrinsicHex);
  const { ok } = reverifySigned({ ticket, decoded: dv, mlDsa: ml_dsa65 });
  assert.ok(ok, 'batch package must verify against the original ticket');
});

test('fee: decoder refuses non-transfer batch legs and wrong leg counts', () => {
  // hand-build signed extrinsics over arbitrary call bytes
  const sender = keypairFromSeed(new Uint8Array(32).fill(9), 65);
  const dest = keypairFromSeed(new Uint8Array(32).fill(7), 65);
  const ticket = fixtureTicket();
  const era = encodeMortalEra(ticket.era.period, ticket.era.phase);
  const amountPlancks = qtcToPlancks('1.5');
  const leg = buildTransferCall(dest.accountId, amountPlancks);
  const mkHex = (callBytes) => {
    const payload = buildSigningPayload({
      call: callBytes, era, nonce: BigInt(ticket.nonce), tip: 0n,
      specVersion: ticket.spec, txVersion: ticket.txv,
      genesisHash: hexDecode(ticket.genesis.slice(2)), eraBirthHash: hexDecode(ticket.era.birthHash.slice(2)),
    });
    const sig = ml_dsa65.sign(payload, sender.secretKey, { context: te.encode('QUANTUS_EXTRINSIC') });
    const wire = new Uint8Array(1 + sig.length + sender.publicKey.length);
    wire[0] = 1; wire.set(sig, 1); wire.set(sender.publicKey, 1 + sig.length);
    return '0x' + hexEncode(buildExtrinsic({
      accountId: sender.accountId, signatureWire: wire, era,
      nonce: BigInt(ticket.nonce), tip: 0n, call: callBytes,
    }));
  };
  // one-leg batch: refused (only the exact 2-leg shape is decoded)
  assert.throws(() => decodeSignedExtrinsic(mkHex(buildBatchAllCall([leg]))), /unsupported batch of 1/);
  // three-leg batch: refused
  assert.throws(() => decodeSignedExtrinsic(mkHex(buildBatchAllCall([leg, leg, leg]))), /unsupported batch of 3/);
  // second leg not a transfer (pallet 9/call 2 nested batch bytes as a "leg"): refused
  const notTransfer = new Uint8Array([9, 2, 4, 1, 2, 3]);
  assert.throws(() => decodeSignedExtrinsic(mkHex(buildBatchAllCall([leg, notTransfer]))), /unsupported inner call/);
  // a batch whose second leg pays a DIFFERENT address still decodes — and
  // names that address, so the hot side can warn it is not the builder fee
  const other = keypairFromSeed(new Uint8Array(32).fill(3), 65);
  const two = buildBatchAllCall([leg, buildTransferCall(other.accountId, 5n)]);
  const d = decodeSignedExtrinsic(mkHex(two));
  assert.equal(d.call.batch, true);
  assert.equal(d.call.serviceFeeDestAddress, other.address);
  assert.notEqual(d.call.serviceFeeDestAddress, SERVICE_FEE_ADDRESS);
});

test('protocol: extrinsic length sane (ML-DSA-65 transfer ~5.7 KB)', () => {
  const { built } = coldSign();
  const len = built.extrinsicHex.length / 2 - 1;
  assert.ok(len > 5000 && len < 7000, `unexpected extrinsic length ${len}`);
  // chunked transport of the real package round-trips
  const chunks = encodeChunks('beef', built.extrinsicHex, 900);
  const { hex } = decodeChunks(chunks);
  assert.equal(hex.toLowerCase(), built.extrinsicHex.toLowerCase());
});

test('protocol: decode rejects garbage / wrong version / bad variant', () => {
  assert.throws(() => decodeSignedExtrinsic('0x00'), /not a signed v4/);
  const { built } = coldSign();
  const raw = hexDecode(built.extrinsicHex.slice(2));
  // corrupt the extrinsic version byte (first body byte; compact len is 2 bytes here)
  const v1 = new Uint8Array(raw); v1[2] = 0x04;
  assert.throws(() => decodeSignedExtrinsic('0x' + hexEncode(v1)), /not a signed v4/);
  // corrupt the signature-variant byte (offset 2 + 1 + 1 + 32)
  const v2 = new Uint8Array(raw); v2[36] = 0x09;
  assert.throws(() => decodeSignedExtrinsic('0x' + hexEncode(v2)), /unknown signature variant/);
});

test('protocol: sender address in extrinsic matches ticket sender', () => {
  const { ticket, built } = coldSign();
  const d = decodeSignedExtrinsic(built.extrinsicHex);
  const { accountId } = ss58Decode(d.address);
  assert.deepEqual(accountId, ss58Decode(ticket.addr).accountId);
});

test('protocol: ss58 prefix constant is 189', () => {
  assert.equal(QUANTUS_SS58_PREFIX, 189);
});

/* ---------------- RPC answer validators (rpc-validate.js) ---------------- */
import {
  parseBlockNumber, isHash32, parseVersionNumber, parseNonce, parseFeeField, validStorageHex,
} from '../js/lib/rpc-validate.js';

test('rpc-validate: block numbers accept int / decimal / hex, reject garbage', () => {
  assert.equal(parseBlockNumber(1234500), 1234500);
  assert.equal(parseBlockNumber('1234500'), 1234500);
  assert.equal(parseBlockNumber('0x12d644'), 1234500);
  assert.equal(parseBlockNumber('garbage!!'), null);
  assert.equal(parseBlockNumber(1.5), null);
  assert.equal(parseBlockNumber(-1), null);
  assert.equal(parseBlockNumber(NaN), null);
  assert.equal(parseBlockNumber({}), null);
  assert.equal(parseBlockNumber(null), null);
});

test('rpc-validate: hashes are exactly 0x + 64 hex digits', () => {
  assert.equal(isHash32('0x' + 'ab'.repeat(32)), true);
  assert.equal(isHash32('0x1234'), false);
  assert.equal(isHash32('ab'.repeat(32)), false);
  assert.equal(isHash32({ hash: '0x' + 'ab'.repeat(32) }), false);
  assert.equal(isHash32(null), false);
});

test('rpc-validate: versions and nonces are u32 integers', () => {
  assert.equal(parseVersionNumber(101), 101);
  assert.equal(parseVersionNumber(0xffffffff), 0xffffffff);
  assert.equal(parseVersionNumber(0x100000000), null);
  assert.equal(parseVersionNumber(1.5), null);
  assert.equal(parseVersionNumber(-1), null);
  assert.equal(parseVersionNumber('garbage'), null);
  assert.equal(parseNonce(5), 5);
  assert.equal(parseNonce('abc'), null);
  assert.equal(parseNonce(-5), null);
  assert.equal(parseNonce(3.7), null);
});

test('rpc-validate: fee fields whitelist non-negative integer shapes', () => {
  assert.equal(parseFeeField('1000'), 1000n);
  assert.equal(parseFeeField('0x10'), 16n);
  assert.equal(parseFeeField(42), 42n);
  assert.equal(parseFeeField(7n), 7n);
  assert.equal(parseFeeField('-5'), null);
  assert.equal(parseFeeField(-5), null);
  assert.equal(parseFeeField('1.5'), null);
  assert.equal(parseFeeField(1.5), null);
  assert.equal(parseFeeField(null), null);
  assert.equal(parseFeeField({}), null);
});

test('rpc-validate: storage hex must be 0x-prefixed even-length hex', () => {
  assert.equal(validStorageHex('0x' + 'ab'.repeat(68)), true);
  assert.equal(validStorageHex('ab'.repeat(68)), false);
  assert.equal(validStorageHex('0x'), false);
  assert.equal(validStorageHex('0xabc'), false);
  assert.equal(validStorageHex(1234), false);
});

test('xxhash128: canonical Substrate vector (chain-verified 2026-09-30)', () => {
  // twox_128("System") as the Quantus chain computes it: XxHash64 seeds 0 and 1.
  // Verified against sp-crypto-hashing 0.1.0 (behind the chain's sp-core 39.0.0),
  // Quantus-Network/chain frame/support/src/hash.rs, and @polkadot/util-crypto.
  const got = Buffer.from(xxhash128(te.encode('System'))).toString('hex');
  assert.equal(got, '26aa394eea5630e07c48ae0c9558cef7');
  const key = SYSTEM_ACCOUNT_KEY(new Uint8Array(32).fill(7));
  assert.equal(Buffer.from(key.slice(0, 32)).toString('hex'),
    '26aa394eea5630e07c48ae0c9558cef7' + Buffer.from(xxhash128(te.encode('Account'))).toString('hex'));
});
