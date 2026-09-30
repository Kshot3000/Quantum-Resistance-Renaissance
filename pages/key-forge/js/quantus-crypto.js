/* Quantus chain-format cryptography, implemented from upstream sources.
 *
 * Account derivation (verified against Quantus-Network crates, Sept 30 2026):
 *   - qp-dilithium-crypto 0.6.1, src/traits.rs: `IdentifyAccount for DilithiumSigner`
 *       into_account() = qp_poseidon_core::hash_bytes(public_key_bytes)
 *   - qp-poseidon-core 3.1.0: Poseidon2 over Goldilocks (p = 2^64 - 2^32 + 1),
 *       WIDTH=12, RATE=8, 8 external + 22 internal rounds, seed 0x3141592653589793,
 *       byte encoding = 4-byte LE limbs + 0x01 terminator word, digest = 4 felts
 *       serialized as 8-byte LE limbs (32 bytes).
 *   - SS58: quantus-cli src/cli/address_format.rs -> Ss58AddressFormat::custom(189),
 *       standard sp_core ss58check (blake2b-512 "SS58PRE" checksum).
 *
 * All arithmetic here uses canonical BigInt field elements; every step is covered
 * by tests/vectors.mjs against the crates' own published test vectors.
 */
import {
  INTERNAL_CONSTANTS,
  MATRIX_DIAG,
  INITIAL_EXTERNAL_CONSTANTS,
  TERMINAL_EXTERNAL_CONSTANTS,
} from './poseidon2-consts.js';
import { blake2b } from '../vendor/noble/hashes/blake2.js';

export const P = 0xFFFFFFFF00000001n; // Goldilocks prime 2^64 - 2^32 + 1
const WIDTH = 12;
const RATE = 8;
const HALF_EXT = 4;

// ---------------------------------------------------------------- field ops
const add = (a, b) => {
  const s = a + b;
  return s >= P ? s - P : s;
};
const mul = (a, b) => (a * b) % P;
const dbl = (a) => add(a, a);
const exp7 = (x) => {
  const x2 = mul(x, x);
  const x3 = mul(x2, x);
  const x4 = mul(x2, x2);
  return mul(x3, x4);
};

// ---------------------------------------------------------------- Poseidon2
function applyMat4(x) {
  // x: BigInt[4], mutated in place; mirrors apply_mat4 in poseidon2.rs
  const t01 = add(x[0], x[1]);
  const t23 = add(x[2], x[3]);
  const t0123 = add(t01, t23);
  const t01123 = add(t0123, x[1]);
  const t01233 = add(t0123, x[3]);
  const nx3 = add(t01233, dbl(x[0]));
  const nx1 = add(t01123, dbl(x[2]));
  const nx0 = add(t01123, t01);
  const nx2 = add(t01233, t23);
  x[0] = nx0; x[1] = nx1; x[2] = nx2; x[3] = nx3;
}

function externalLinearLayer(state) {
  for (let c = 0; c < WIDTH; c += 4) {
    const chunk = state.slice(c, c + 4);
    applyMat4(chunk);
    for (let i = 0; i < 4; i++) state[c + i] = chunk[i];
  }
  const sums = [0n, 0n, 0n, 0n];
  for (let j = 0; j < WIDTH; j += 4)
    for (let k = 0; k < 4; k++) sums[k] = add(sums[k], state[j + k]);
  for (let i = 0; i < WIDTH; i++) state[i] = add(state[i], sums[i % 4]);
}

function internalLinearLayer(state) {
  let sum = 0n;
  for (let i = 0; i < WIDTH; i++) sum = add(sum, state[i]);
  for (let i = 0; i < WIDTH; i++) state[i] = add(sum, mul(state[i], MATRIX_DIAG[i]));
}

export function poseidon2Permute(state) {
  externalLinearLayer(state);
  for (let r = 0; r < HALF_EXT; r++) {
    const rc = INITIAL_EXTERNAL_CONSTANTS[r];
    for (let i = 0; i < WIDTH; i++) state[i] = exp7(add(state[i], rc[i]));
    externalLinearLayer(state);
  }
  for (let r = 0; r < INTERNAL_CONSTANTS.length; r++) {
    state[0] = exp7(add(state[0], INTERNAL_CONSTANTS[r]));
    internalLinearLayer(state);
  }
  for (let r = 0; r < HALF_EXT; r++) {
    const rc = TERMINAL_EXTERNAL_CONSTANTS[r];
    for (let i = 0; i < WIDTH; i++) state[i] = exp7(add(state[i], rc[i]));
    externalLinearLayer(state);
  }
}

// ---------------------------------------------------------------- sponge
function bytesToFelts(bytes) {
  // Injective 4-bytes/felt LE encoding + 0x01 terminator (serialization.rs).
  const felts = [];
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    felts.push(
      BigInt(bytes[pos]) |
      (BigInt(bytes[pos + 1]) << 8n) |
      (BigInt(bytes[pos + 2]) << 16n) |
      (BigInt(bytes[pos + 3]) << 24n)
    );
    pos += 4;
  }
  const rem = bytes.length - pos;
  let last = 0n;
  for (let i = 0; i < rem; i++) last |= BigInt(bytes[pos + i]) << BigInt(8 * i);
  last |= 1n << BigInt(8 * rem); // terminator byte
  felts.push(last);
  return felts;
}

function spongeAbsorb(felts) {
  const state = new Array(WIDTH).fill(0n);
  let buf = [];
  const absorbBlock = () => {
    for (let i = 0; i < RATE; i++) state[i] = add(state[i], buf[i]);
    poseidon2Permute(state);
    buf = [];
  };
  for (const f of felts) {
    buf.push(f);
    if (buf.length === RATE) absorbBlock();
  }
  // finalize: pad with 1 then zeros to a full block
  buf.push(1n);
  while (buf.length !== 0) {
    buf.push(0n);
    if (buf.length === RATE) absorbBlock();
  }
  return state.slice(0, 4); // POSEIDON2_OUTPUT = 4
}

function feltsToBytes32(felts) {
  // digest_to_bytes: each felt as 8-byte LE u64.
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let v = felts[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** qp_poseidon_core::hash_to_felts — hash field elements to 4 felts. */
export function hashToFelts(felts) {
  return spongeAbsorb(felts.map((f) => BigInt(f) % P));
}

/** qp_poseidon_core::hash_to_bytes — hash field elements to 32 bytes. */
export function hashToBytes(felts) {
  return feltsToBytes32(hashToFelts(felts));
}

/** qp_poseidon_core::hash_bytes — the account-ID derivation hash. */
export function hashBytes(bytes) {
  return feltsToBytes32(spongeAbsorb(bytesToFelts(bytes)));
}

/** Double-hash helper mirroring hash_twice for test-vector validation. */
export function hashTwice(felts) {
  return hashToBytes(hashToFelts(felts));
}

// ---------------------------------------------------------------- base58
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  let zeros = 0;
  for (const b of bytes) {
    if (b === 0) zeros++;
    else break;
  }
  return '1'.repeat(zeros) + s;
}

export function base58Decode(str) {
  let n = 0n;
  for (const ch of str) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new Error('Invalid base58 character');
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const ch of str) {
    if (ch === '1') zeros++;
    else break;
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

// ---------------------------------------------------------------- SS58
export const QUANTUS_SS58_PREFIX = 189;

function prefixBytes(prefix) {
  if (prefix < 64) return new Uint8Array([prefix]);
  if (prefix < 16384)
    return new Uint8Array([
      ((prefix & 0xfc) >> 2) | 0x40,
      (prefix >> 8) | ((prefix & 0x03) << 6),
    ]);
  throw new Error('SS58 prefix out of range');
}

function ss58Checksum(prefixB, accountId) {
  const pre = new TextEncoder().encode('SS58PRE');
  const msg = new Uint8Array(pre.length + prefixB.length + accountId.length);
  msg.set(pre, 0);
  msg.set(prefixB, pre.length);
  msg.set(accountId, pre.length + prefixB.length);
  return blake2b(msg, { dkLen: 64 }).slice(0, 2);
}

export function ss58Encode(accountId, prefix = QUANTUS_SS58_PREFIX) {
  if (accountId.length !== 32) throw new Error('AccountId must be 32 bytes');
  const pb = prefixBytes(prefix);
  const chk = ss58Checksum(pb, accountId);
  const body = new Uint8Array(pb.length + 32 + 2);
  body.set(pb, 0);
  body.set(accountId, pb.length);
  body.set(chk, pb.length + 32);
  return base58Encode(body);
}

export function ss58Decode(address) {
  const raw = base58Decode(address.trim());
  if (raw.length < 3) throw new Error('Address too short');
  let prefix, pb;
  if ((raw[0] & 0x40) === 0) {
    prefix = raw[0];
    pb = raw.slice(0, 1);
  } else {
    if (raw.length < 4) throw new Error('Address too short');
    prefix = ((raw[1] & 0x3f) << 8) | ((raw[0] & 0x3f) << 2) | (raw[1] >> 6);
    pb = raw.slice(0, 2);
  }
  const accountId = raw.slice(pb.length, raw.length - 2);
  if (accountId.length !== 32) throw new Error('Not a 32-byte account address');
  const chk = raw.slice(raw.length - 2);
  const expect = ss58Checksum(pb, accountId);
  if (chk[0] !== expect[0] || chk[1] !== expect[1])
    throw new Error('Invalid SS58 checksum');
  return { prefix, accountId };
}

// ---------------------------------------------------------------- chain ops
/** AccountId32 = hash_bytes(pubkey) — matches qp-dilithium-crypto into_account(). */
export function accountIdFromPubkey(pubkey) {
  return hashBytes(pubkey);
}

/** Full pipeline: ML-DSA public key bytes -> qz... SS58 address. */
export function pubkeyToAddress(pubkey, prefix = QUANTUS_SS58_PREFIX) {
  return ss58Encode(accountIdFromPubkey(pubkey), prefix);
}

export function hexEncode(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexDecode(hex) {
  const h = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0)
    throw new Error('Invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
