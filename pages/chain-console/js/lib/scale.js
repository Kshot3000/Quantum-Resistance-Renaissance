/* QTC Web Wallet — SCALE codec + Quantus extrinsic builder (ES module).
 *
 * Wire format verified against Quantus-Network/chain (main, Sept 30 2026):
 *   - runtime/src/lib.rs:        Signature = DilithiumSignatureScheme;
 *                                  Address = MultiAddress<AccountId, ()>;
 *                                  TxExtension = (CheckNonZeroSender, CheckSpecVersion,
 *                                    CheckTxVersion, CheckGenesis, CheckMortality, CheckNonce,
 *                                    CheckWeight, ReversibleTransactionExtension,
 *                                    WormholeProofRecorderExtension, ChargeTransactionPayment,
 *                                    CheckMetadataHash, WeightReclaim)
 *   - dilithium-crypto types.rs:  DilithiumSignatureScheme = enum { 0: Dilithium87,
 *                                  1: Dilithium65 }, each variant = SignatureWithPublic with
 *                                  byte layout [signature_bytes || public_key_bytes]
 *                                  (65: 3309 + 1952 bytes; 87: 4627 + 2592 bytes)
 *   - signing_context.rs:         on-chain extrinsic signatures use the FIPS-204 context
 *                                  string "QUANTUS_EXTRINSIC" (Pair::sign / Verify::verify)
 *   - pallet-balances 46.0.0:     transfer_keep_alive = call index 3
 *   - runtime construct_runtime:  Balances pallet index = 2
 *   - SignedPayload (sp-runtime 45.0.0, generic::SignedPayload): (call, extension-tuple,
 *                                  implicit-tuple); blake2-256 hashed iff encoded len > 256.
 *     Extra tuple encodes (era, nonce[compact], tip[compact u128], metadata-hash-mode byte);
 *     implicit tuple encodes (spec_version u32, tx_version u32, genesis_hash, era-birth hash).
 *     CheckMetadataHash encodes its Mode byte (0x00 = disabled) — we always disable.
 *
 * The wallet never guesses: every constant above was read from source, not memory.
 */
import { blake2b } from '../../../../assets/vendor/noble/hashes/blake2.js';

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */
/* ------------------------------------------------------------------ */

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, Number(n), true);
  return b;
}

export function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

/* SCALE compact integer (u32/u64/u128 as BigInt). */
export function compactEncode(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('compact: negative value');
  if (v < 64n) return Uint8Array.of(Number(v) << 2);
  if (v < 16384n) {
    const x = Number(v << 2n) | 0b01;
    return Uint8Array.of(x & 0xff, (x >> 8) & 0xff);
  }
  if (v < 1073741824n) {
    const x = (v << 2n) | 0b10n;
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, Number(x), true);
    return b;
  }
  // big-integer mode: low 2 bits 0b11, next 6 bits = (byteLen - 4)
  const bytes = [];
  while (v > 0n) { bytes.push(Number(v & 0xffn)); v >>= 8n; }
  const header = 0b11 | ((bytes.length - 4) << 2);
  return concat(Uint8Array.of(header), Uint8Array.from(bytes));
}

export function compactDecode(bytes, offset = 0) {
  const first = bytes[offset];
  const mode = first & 0b11;
  if (mode === 0) return { value: BigInt(first >> 2), next: offset + 1 };
  if (mode === 1) {
    const v = (first | (bytes[offset + 1] << 8)) >> 2;
    return { value: BigInt(v), next: offset + 2 };
  }
  if (mode === 2) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) >>> 2;
    return { value: BigInt(v), next: offset + 4 };
  }
  const len = (first >> 2) + 4;
  let v = 0n;
  for (let i = 0; i < len; i++) v |= BigInt(bytes[offset + 1 + i]) << BigInt(8 * i);
  return { value: v, next: offset + 1 + len };
}

/* ------------------------------------------------------------------ */
/* Era (sp-runtime 45.0.0, src/generic/era.rs)                          */
/* ------------------------------------------------------------------ */

export function encodeMortalEra(period, phase) {
  const quantize = Math.max(1, Math.floor(period / 4096));
  const encoded = (Math.min(15, Math.max(1, ctz(period) - 1))) | ((Math.floor(phase / quantize)) << 4);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, encoded, true);
  return b;
}

function ctz(n) {
  let c = 0;
  while ((n & 1) === 0 && c < 64) { n = Math.floor(n / 2); c++; }
  return c;
}

/* Era birth block: (current.max(phase) - phase) / period * period + phase */
export function eraBirth(current, period, phase) {
  const c = Math.max(current, phase);
  return Math.floor((c - phase) / period) * period + phase;
}

/* ------------------------------------------------------------------ */
/* Quantus chain constants (verified, see header)                      */
/* ------------------------------------------------------------------ */

export const BALANCES_PALLET_INDEX = 2;
export const TRANSFER_KEEP_ALIVE_CALL_INDEX = 3;
export const EXTRINSIC_VERSION = 0x84; // 0b1000_0100: signed flag + format v4
export const SIGNING_CONTEXT = 'QUANTUS_EXTRINSIC';
export const METADATA_HASH_MODE_DISABLED = 0x00;
export const DILITHIUM65_VARIANT = 1;
export const DILITHIUM87_VARIANT = 0;

/* Build the Balances::transfer_keep_alive call bytes.
 * destAccountId: 32-byte Uint8Array; amountPlancks: BigInt. */
export function buildTransferCall(destAccountId, amountPlancks) {
  if (destAccountId.length !== 32) throw new Error('dest account id must be 32 bytes');
  return concat(
    Uint8Array.of(BALANCES_PALLET_INDEX, TRANSFER_KEEP_ALIVE_CALL_INDEX),
    Uint8Array.of(0x00), // MultiAddress::Id variant
    destAccountId,
    compactEncode(amountPlancks),
  );
}

/* Build the exact byte payload the runtime signs (SignedPayload.using_encoded).
 * Params: { call, era, nonce, tip, specVersion, txVersion, genesisHash, eraBirthHash } */
export function buildSigningPayload(p) {
  const payload = concat(
    p.call,
    p.era,
    compactEncode(p.nonce),
    compactEncode(p.tip),
    Uint8Array.of(METADATA_HASH_MODE_DISABLED),
    u32le(p.specVersion),
    u32le(p.txVersion),
    p.genesisHash,
    p.eraBirthHash,
  );
  // sp-runtime hashes the payload with blake2-256 iff it exceeds 256 bytes.
  if (payload.length > 256) return blake2b(payload, { dkLen: 32 });
  return payload;
}

/* Assemble the full signed extrinsic bytes.
 * Params add: { address (ss58-derived 32B accountId), signatureWire (variant byte +
 * [sig||pubkey]), ...same as payload } */
export function buildExtrinsic(p) {
  const body = concat(
    Uint8Array.of(EXTRINSIC_VERSION),
    Uint8Array.of(0x00), // MultiAddress::Id variant
    p.accountId,
    p.signatureWire,
    p.era,
    compactEncode(p.nonce),
    compactEncode(p.tip),
    Uint8Array.of(METADATA_HASH_MODE_DISABLED),
    p.call,
  );
  return concat(compactEncode(body.length), body);
}

/* ------------------------------------------------------------------ */
/* Decoding (balance reads, extrinsic inspector)                       */
/* ------------------------------------------------------------------ */

/* Decode frame_system AccountInfo: { nonce, consumers, providers, sufficients,
 * data: { free, reserved, frozen, flags } } from a state_getStorage blob. */
export function decodeAccountInfo(bytes) {
  let o = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const nonce = dv.getUint32(o, true); o += 4;
  const consumers = dv.getUint32(o, true); o += 4;
  const providers = dv.getUint32(o, true); o += 4;
  const sufficients = dv.getUint32(o, true); o += 4;
  const u128 = () => {
    const lo = dv.getBigUint64(o, true);
    const hi = dv.getBigUint64(o + 8, true);
    o += 16;
    return (hi << 64n) | lo;
  };
  const free = u128(), reserved = u128(), frozen = u128();
  const flags = dv.getUint32(o, true); o += 4;
  return { nonce, consumers, providers, sufficients, free, reserved, frozen, flags };
}

export const DECIMALS = 12n;
export const PLANCKS_PER_QTC = 10n ** DECIMALS;
export const EXISTENTIAL_DEPOSIT = 1000000000n; // 0.001 QTC (MILII_UNIT)

export function plancksToQtc(plancks) {
  const p = BigInt(plancks);
  const whole = p / PLANCKS_PER_QTC;
  const frac = (p % PLANCKS_PER_QTC).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function qtcToPlancks(str) {
  const s = String(str).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error('amount must look like 1.5 (max 12 decimals)');
  const [w, f = ''] = s.split('.');
  return BigInt(w) * PLANCKS_PER_QTC + BigInt((f + '000000000000').slice(0, 12));
}

/* Human-readable breakdown of a built extrinsic (transparency inspector). */
export function describeExtrinsicParts(p) {
  return [
    ['length prefix', `${p.lengthPrefixLen} byte(s) SCALE-compact — total ${p.bodyLen} bytes follow`],
    ['version', '0x84 — signed extrinsic, format v4'],
    ['signer', `MultiAddress::Id (0x00) + 32-byte account id`],
    ['signature', p.sigDesc],
    ['era', p.eraDesc],
    ['nonce', `compact ${p.nonce}`],
    ['tip', `compact ${p.tip} plancks`],
    ['metadata hash', '0x00 — CheckMetadataHash disabled'],
    ['call', `pallet 2 (Balances) · call 3 (transfer_keep_alive) → dest ${p.destShort} · ${p.amountDesc}`],
  ];
}
