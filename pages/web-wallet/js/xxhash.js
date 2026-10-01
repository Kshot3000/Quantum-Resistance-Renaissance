/* QTC Web Wallet — xxHash64 (for Substrate storage keys).
 *
 * Substrate storage keys: xxhash128(pallet_name) ++ xxhash128(storage_name) ++
 * Blake2_128Concat(key), where xxhash128 = xxh64(seed=0) ++ xxh64(seed=1)
 * (low 64 bits first). Verified 2026-09-30 against the chain's actual hasher:
 * Quantus-Network/chain frame/support/src/hash.rs (`Twox128::hash` calls
 * `sp_io::hashing::twox_128`), whose implementation is sp-crypto-hashing 0.1.0
 * (the crate behind the chain's sp-core 39.0.0): XxHash64 seeds 0 and 1.
 * Cross-checked with @polkadot/util-crypto: xxhash128("System") must equal
 * 26aa394eea5630e07c48ae0c9558cef7 (asserted in tests/run-tests.mjs).
 * Implemented from the public xxHash specification.
 */
import { blake2b } from '../vendor/noble/hashes/blake2.js';

const P1 = 0x9E3779B185EBCA87n;
const P2 = 0xC2B2AE3D27D4EB4Fn;
const P3 = 0x165667B19E3779F9n;
const P4 = 0x85EBCA77C2B2AE63n;
const P5 = 0x27D4EB2F165667C5n;
const M64 = 0xFFFFFFFFFFFFFFFFn;

const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;
const round = (acc, v) => rotl((acc + v * P2) & M64, 31n) * P1 & M64;
const merge = (acc, v) => ((acc ^ round(0n, v)) * P1 + P4) & M64;

function read64(data, o) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(data[o + i]) << BigInt(8 * i);
  return v;
}

export function xxh64(data, seed = 0n) {
  const len = data.length;
  let h;
  let o = 0;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M64;
    let v2 = (seed + P2) & M64;
    let v3 = seed & M64;
    let v4 = (seed - P1) & M64;
    const limit = len - 32;
    while (o <= limit) {
      v1 = round(v1, read64(data, o)); o += 8;
      v2 = round(v2, read64(data, o)); o += 8;
      v3 = round(v3, read64(data, o)); o += 8;
      v4 = round(v4, read64(data, o)); o += 8;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else {
    h = (seed + P5) & M64;
  }
  h = (h + BigInt(len)) & M64;
  while (o + 8 <= len) {
    h = (rotl(h ^ (round(0n, read64(data, o))), 27n) * P1 + P4) & M64;
    o += 8;
  }
  if (o + 4 <= len) {
    const v = BigInt(data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24));
    h = (rotl(h ^ (v * P1 & M64), 23n) * P2 + P3) & M64;
    o += 4;
  }
  while (o < len) {
    h = (rotl(h ^ (BigInt(data[o]) * P5 & M64), 11n) * P1) & M64;
    o += 1;
  }
  h ^= h >> 33n; h = (h * P2) & M64;
  h ^= h >> 29n; h = (h * P3) & M64;
  h ^= h >> 32n;
  return h & M64;
}

function h64le(h) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((h >> BigInt(8 * i)) & 0xffn);
  return b;
}

export function xxhash128(data) {
  const lo = h64le(xxh64(data, 0n));
  const hi = h64le(xxh64(data, 1n));
  const out = new Uint8Array(16);
  out.set(lo, 0); out.set(hi, 8);
  return out;
}

/* Full storage key for a Blake2_128Concat map entry, e.g. System.Account. */
export function storageKey(pallet, storage, keyBytes) {
  const k1 = xxhash128(new TextEncoder().encode(pallet));
  const k2 = xxhash128(new TextEncoder().encode(storage));
  const h = blake2b(keyBytes, { dkLen: 16 });
  const out = new Uint8Array(32 + 16 + keyBytes.length);
  out.set(k1, 0); out.set(k2, 16); out.set(h, 32); out.set(keyBytes, 48);
  return out;
}

export const SYSTEM_ACCOUNT_KEY = (accountId) => storageKey('System', 'Account', accountId);
