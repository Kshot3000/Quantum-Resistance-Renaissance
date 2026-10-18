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
import { blake2b } from '../../../assets/vendor/noble/hashes/blake2.js';

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
export const UTILITY_PALLET_INDEX = 9;   // runtime/src/lib.rs: Utility
export const BATCH_ALL_CALL_INDEX = 2;   // Utility::batch_all — the Quantus fork exposes only batch_all

/* Optional builder service fee (PROFIT route, added 2026-10-11): the Send
 * flow may add a small, plainly disclosed service fee ON TOP of the amount
 * — the recipient's amount is NEVER reduced. The fee is a second
 * Balances::transfer_keep_alive to the builder's QTC address
 * (SERVICE_FEE_ADDRESS, the same address in this page's footer), wrapped
 * with the recipient transfer in ONE atomic Utility.batch_all (recipient
 * leg FIRST, fee leg LAST), so the sender pays both legs or neither and
 * signs exactly one extrinsic. Exact BigInt math: fee = floor(amount *
 * bps / 10,000), so it never exceeds the quoted percentage; a fee that
 * floors to zero plancks adds NO leg (a 0-planck transfer is invalid) and
 * the send stays a plain transfer. */
export const SERVICE_FEE_ADDRESS = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';
export const SERVICE_FEE_MAX_BPS = 100;
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

export function computeServiceFee(amountPlancks, feeBps) {
  const amount = BigInt(amountPlancks);
  let bps = Number(feeBps);
  if (!isFinite(bps) || bps < 0) bps = 0;
  if (bps > SERVICE_FEE_MAX_BPS) bps = SERVICE_FEE_MAX_BPS;
  bps = Math.floor(bps);
  if (amount <= 0n || bps === 0) return { feePlancks: 0n, feeBps: bps };
  return { feePlancks: (amount * BigInt(bps)) / 10000n, feeBps: bps };
}

export function feeBpsLabel(bps) {
  const b = Math.floor(Number(bps) || 0);
  const whole = Math.floor(b / 100), rem = b % 100;
  if (rem === 0) return whole + '%';
  const frac = String(rem).padStart(2, '0').replace(/0+$/, '');
  return whole + '.' + frac + '%';
}

/* Utility::batch_all call bytes: [9, 2, compact(count), calls…] — the
 * encoding verified against the Extrinsic Lab's fleet batch sample. */
export function buildBatchAllCall(calls) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error('batch_all needs at least one call');
  for (const c of calls) if (!c || c.length === 0) throw new Error('bad call bytes in batch');
  return concat(Uint8Array.of(UTILITY_PALLET_INDEX, BATCH_ALL_CALL_INDEX), compactEncode(calls.length), ...calls);
}

/* Build the Send flow's call, optionally with the disclosed service fee.
 * No fee (or a fee floored to zero) -> the plain transfer_keep_alive,
 * byte-identical to buildTransferCall. Fee on -> one batch_all of
 * [recipient leg untouched and FIRST, fee leg LAST];
 * totalDebitPlancks = amount + fee (the network fee is quoted separately
 * by the node and added by the caller). */
export function buildTransferWithServiceFee(destAccountId, amountPlancks, feeDestAccountId, feeBps) {
  const amount = BigInt(amountPlancks);
  const plain = buildTransferCall(destAccountId, amount);
  const f = computeServiceFee(amount, feeBps);
  if (f.feePlancks <= 0n) {
    return { call: plain, kind: 'transfer_keep_alive', feePlancks: 0n, feeBps: f.feeBps, amountPlancks: amount, totalDebitPlancks: amount };
  }
  if (!feeDestAccountId || feeDestAccountId.length !== 32) throw new Error('fee account id must be 32 bytes');
  const feeLeg = buildTransferCall(feeDestAccountId, f.feePlancks);
  return { call: buildBatchAllCall([plain, feeLeg]), kind: 'batch_all', feePlancks: f.feePlancks, feeBps: f.feeBps, amountPlancks: amount, totalDebitPlancks: amount + f.feePlancks };
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
/* The chain's hard supply cap: 21,000,000 QTC will ever exist, so no
 * transfer amount above it can ever be funded. This parser feeds the
 * signing path — refuse it here, at entry, with the cap named (the same
 * bound SafeSend and the Distribution Planner enforce). Exactly the cap
 * stays valid. */
export const MAX_SUPPLY_PLANCKS = 21000000n * PLANCKS_PER_QTC;

export function plancksToQtc(plancks) {
  const p = BigInt(plancks);
  const whole = p / PLANCKS_PER_QTC;
  const frac = (p % PLANCKS_PER_QTC).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* Amount-input length bound (white-hat): the regex below admits an
 * UNBOUNDED whole part, and BigInt(w) converts the whole digit string
 * before the supply check can refuse it — BigInt decimal conversion is
 * superlinear (measured: 1M digits ~178 ms, 5M ~1.6 s, 20M ~7.1 s), so
 * a multi-million-digit paste froze the tab on the send/review path.
 * The largest genuine amount string is 21 chars ("21000000.000000000000"
 * — the whole supply at full precision); MAX_AMOUNT_CHARS = 512, the
 * fleet cap the exact parsers (Tokenomics / Fee Lab / Pay Desk) already
 * use, is >24x that, and in-cap parses are byte-identical. Refused on
 * length alone, size + cap named, input never echoed. Fail-closed room
 * gate, matching this fleet's other input gates. */
export const MAX_AMOUNT_CHARS = 512;
export function amountInputRoom(chars) {
  return typeof chars === 'number' && isFinite(chars) && chars >= 0 && Math.floor(chars) === chars && chars <= MAX_AMOUNT_CHARS;
}

export function qtcToPlancks(str) {
  const s = String(str).trim();
  if (!amountInputRoom(s.length))
    throw new Error(`amount is ${s.length.toLocaleString('en-US')} characters — over the amount-input cap of ${MAX_AMOUNT_CHARS} characters; refused before parsing`);
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error('amount must look like 1.5 (max 12 decimals)');
  const [w, f = ''] = s.split('.');
  const plancks = BigInt(w) * PLANCKS_PER_QTC + BigInt((f + '000000000000').slice(0, 12));
  if (plancks > MAX_SUPPLY_PLANCKS) throw new Error('amount exceeds the 21,000,000 QTC total supply — no account can ever hold that much');
  return plancks;
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
    ['call', p.callDesc || `pallet 2 (Balances) · call 3 (transfer_keep_alive) → dest ${p.destShort} · ${p.amountDesc}`],
  ];
}
