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
} from '../js/airgap.js';
import { encodeMortalEra, qtcToPlancks } from '../js/lib/scale.js';
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
    era: { period: 64, phase: 52, birth: 1_234_496, birthHash: BIRTHH },
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

function coldSign({ scheme = 65, amount = '1.5' } = {}) {
  const sender = keypairFromSeed(new Uint8Array(32).fill(9), scheme);
  const dest = keypairFromSeed(new Uint8Array(32).fill(7), 65);
  const ticket = fixtureTicket();
  const era = encodeMortalEra(ticket.era.period, ticket.era.phase);
  const amountPlancks = qtcToPlancks(amount);
  const payload = buildColdPayload({
    ticket, destAccountId: dest.accountId, amountPlancks, era, nonce: ticket.nonce,
  });
  const mod = scheme === 87 ? ml_dsa87 : ml_dsa65;
  const sig = mod.sign(payload, sender.secretKey, { context: te.encode('QUANTUS_EXTRINSIC') });
  const built = buildColdExtrinsic({
    ticket, senderAccountId: sender.accountId, destAccountId: dest.accountId,
    amountPlancks, era, nonce: ticket.nonce, scheme,
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
