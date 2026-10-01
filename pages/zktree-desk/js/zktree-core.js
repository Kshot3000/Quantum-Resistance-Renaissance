/* QTC ZkTree Desk — pure ZK-tree logic (no DOM).
 *
 * Faithful in-browser re-implementation of Quantus-Network/chain
 * pallets/zk-tree/src/tree.rs @ 482c5b9 (the 4-ary Poseidon Merkle tree that
 * stores ZK transfer proofs for the wormhole privacy flow).
 *
 * Mirrored exactly:
 *   - hash_leaf:  8 felts [to_account x4 (lossy 8-byte/felt LE, canonical
 *                 limbs asserted), transfer_count (u64 -> two 32-bit limbs,
 *                 HIGH then LOW), asset_id (u32-saturated, 8-byte LE -> felt),
 *                 amount (quantized amount/10^10, u32-saturated, 8-byte LE)]
 *                 -> Poseidon2-Goldilocks hash_to_bytes
 *   - hash_node:  sort 4 children lexicographically, concat (128 bytes),
 *                 16 felts (lossy 8-byte/felt) -> hash_to_bytes
 *   - empty_hash = 32 zero bytes
 *   - canonicalize_account_bytes: per-8-byte-limb reduction mod Goldilocks p
 *   - capacity_at_depth(d) = 4^d (d = 0 -> 0)
 *   - generate_proof / verify_proof: index-free, order-independent via sort
 *   - grow_tree parking semantics reflected in the simulator's depth handling
 *
 * Poseidon2 sponge itself is the repo-verified implementation
 * (js/quantus-crypto.js <- qp-poseidon-core 3.1.0: WIDTH=12, RATE=8,
 * 8 ext + 22 int rounds, seed 0x3141592653589793), validated against the
 * crates' own test vectors in key-forge.
 *
 * Decisive cross-check: the hash_leaf golden vector pinned in
 * pallets/zk-tree/src/tests.rs::hash_leaf_golden_vector
 * (to=[0x11;32], transfer_count=7, asset_id=5, amount=1234*10^10).
 *
 * Environment: ES module. Browser: imported by js/app.js. Node: imported
 * directly by tests/zktree-tests.mjs. No DOM, no network here.
 */
import {
  hashToBytes,
  ss58Decode,
  hexEncode,
  hexDecode,
  P as GOLDILOCKS_P,
} from "./quantus-crypto.js";

export const ARITY = 4;
export const MAX_TREE_DEPTH = 32; // chain cap (pallet constant)
export const CIRCUIT_MAX_TREE_DEPTH = 16; // wormhole-circuit ceiling (qp-zk-circuits-common)
export const AMOUNT_SCALE_DOWN_FACTOR = 10000000000n; // 10^10: 2 decimals of QTC in the leaf
export const PLANCKS_PER_QTC = 1000000000000n;
export const QUANTUS_SS58_PREFIX = 189;
export const U32_MAX = 4294967295n;

// Golden vector: pallets/zk-tree/src/tests.rs::hash_leaf_golden_vector
export const GOLDEN_LEAF = {
  toHex: "11".repeat(32),
  transferCount: 7n,
  assetId: 5,
  amountPlancks: 1234n * AMOUNT_SCALE_DOWN_FACTOR,
  expectedHex:
    "c35ed21b60b17f4410e72fe36815affedb55e06f40a22077e2598f7ecbfe335d",
};

// ---------------------------------------------------------------- helpers

function u64le(bytes, off) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(bytes[off + i]) << BigInt(8 * i);
  return v;
}

function u64leBytes(v) {
  v = BigInt(v);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u128leBytes(v) {
  v = BigInt(v);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u32leBytes(v) {
  v = BigInt(v);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic byte comparison, like Rust's [u8; 32] Ord used by hash_node's sort(). */
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function emptyHash() {
  return new Uint8Array(32);
}

// ---------------------------------------------------------------- canonicalization
// pallets/zk-tree/src/tree.rs::canonicalize_account_bytes

/** Reduce each 8-byte LE limb mod the Goldilocks prime. Returns {bytes, reducedLimbs}. */
export function canonicalizeAccountBytes(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length !== 32) throw new Error("account must be 32 bytes");
  let reduced = 0;
  for (let limb = 0; limb < 4; limb++) {
    const v = u64le(b, limb * 8);
    if (v >= GOLDILOCKS_P) {
      const r = v - GOLDILOCKS_P; // a u64 is < 2p: one subtraction suffices
      const rb = u64leBytes(r);
      b.set(rb, limb * 8);
      reduced++;
    }
  }
  return { bytes: b, reducedLimbs: reduced, canonical: reduced === 0 };
}

// ---------------------------------------------------------------- felt encodings
// qp-poseidon-core serialization, as used by tree.rs:
//   bytes_to_felts_compact_lossy = 8-byte LE chunks -> u64 -> Goldilocks::from_u64
//   (from_noncanonical: reduce mod p — the "lossy" encoding)
//   u64_to_felts = two 32-bit limbs, HIGH then LOW

function feltsFromBytesCompactLossy(bytes) {
  if (bytes.length % 8 !== 0) throw new Error("compact encoding needs a multiple of 8 bytes");
  const felts = [];
  for (let o = 0; o < bytes.length; o += 8) felts.push(u64le(bytes, o) % GOLDILOCKS_P);
  return felts;
}

/** u64 -> [high32, low32] felts (mirrors qp_poseidon_core::serialization::u64_to_felts). */
function u64ToFelts(v) {
  v = BigInt(v);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("transfer_count must fit in u64");
  return [(v >> 32n) & 0xffffffffn, v & 0xffffffffn];
}

// ---------------------------------------------------------------- hash_leaf
// pallets/zk-tree/src/tree.rs::hash_leaf

/**
 * leaf = { to: Uint8Array(32), transferCount: BigInt, assetId: BigInt|number, amountPlancks: BigInt }
 * Returns { hash: Uint8Array(32), felts: BigInt[8], quantized, assetIdU32, canonical }.
 * The felt table mirrors the doc comment on hash_leaf exactly.
 */
export function hashLeaf(leaf) {
  const to = Uint8Array.from(leaf.to);
  if (to.length !== 32) throw new Error("leaf.to must be 32 bytes");
  const canon = canonicalizeAccountBytes(to);

  const felts = [];
  // to_account: 4 felts, 32 bytes at 8 bytes/felt (lossy compact)
  felts.push(...feltsFromBytesCompactLossy(canon.bytes));
  // transfer_count: 2 felts, u64 as two 32-bit limbs, high then low
  felts.push(...u64ToFelts(leaf.transferCount));
  // asset_id: 1 felt — circuit commits u32; saturate (never wrap) above u32::MAX
  let aid = BigInt(leaf.assetId);
  if (aid < 0n) throw new Error("asset_id must be non-negative");
  const assetIdU32 = aid > U32_MAX ? U32_MAX : aid;
  felts.push(...feltsFromBytesCompactLossy(u64leBytes(assetIdU32)));
  // amount: 1 felt — quantized amount/10^10, committed as u32, saturated above u32::MAX
  let amt = BigInt(leaf.amountPlancks);
  if (amt < 0n) throw new Error("amount must be non-negative");
  const quantized = amt / AMOUNT_SCALE_DOWN_FACTOR;
  const quantizedU32 = quantized > U32_MAX ? U32_MAX : quantized;
  felts.push(...feltsFromBytesCompactLossy(u64leBytes(quantizedU32)));

  if (felts.length !== 8) throw new Error("leaf preimage must be exactly 8 felts");
  const hash = hashToBytes(felts);
  return {
    hash,
    hashHex: hexEncode(hash),
    felts,
    quantized,
    quantizedU32,
    assetIdU32,
    saturated: quantized !== quantizedU32 || aid !== assetIdU32,
    canonical: canon.canonical,
    reducedLimbs: canon.reducedLimbs,
  };
}

// ---------------------------------------------------------------- hash_node
// pallets/zk-tree/src/tree.rs::hash_node

/** children: 4 x Uint8Array(32). Sorts (order-independent), concats, 16 felts -> hash. */
export function hashNode(children) {
  if (!Array.isArray(children) || children.length !== ARITY)
    throw new Error("hash_node needs exactly 4 children");
  const sorted = children.map((c) => Uint8Array.from(c)).sort(compareBytes);
  const data = new Uint8Array(32 * ARITY);
  sorted.forEach((c, i) => data.set(c, i * 32));
  const felts = feltsFromBytesCompactLossy(data); // 128 bytes -> 16 felts
  return hashToBytes(felts);
}

// ---------------------------------------------------------------- capacity / depth

export function capacityAtDepth(depth) {
  depth = Number(depth);
  if (depth === 0) return 0n;
  if (depth < 0 || depth > 64) throw new Error("depth out of range");
  return 4n ** BigInt(depth);
}

/** Smallest depth d with 4^d >= n (n >= 1). Mirrors the on-chain growth rule. */
export function depthForLeaves(n) {
  n = BigInt(n);
  if (n < 1n) return 0;
  let d = 1;
  while (capacityAtDepth(d) < n) d++;
  return d;
}

// ---------------------------------------------------------------- tree math (settled-tree semantics)
// Mirrors update_range for a fully-settled tree: missing children read as
// empty_hash (get_leaf_hash/get_node_hash fall back to empty_hash()).

/**
 * leafHashes: Uint8Array(32)[] in index order. depth: tree depth.
 * Returns the root, exactly as on_finalize's batched fold would for a settled tree.
 */
export function computeRoot(leafHashes, depth) {
  const n = leafHashes.length;
  if (n === 0) return emptyHash();
  if (capacityAtDepth(depth) < BigInt(n)) throw new Error("depth too small for leaf count");
  let level = leafHashes.map((h) => Uint8Array.from(h));
  for (let l = 1; l <= depth; l++) {
    const next = [];
    for (let i = 0; i < level.length; i += ARITY) {
      const children = [];
      for (let k = 0; k < ARITY; k++) children.push(i + k < level.length ? level[i + k] : emptyHash());
      next.push(hashNode(children));
    }
    level = next;
    if (level.length === 1 && l < depth) {
      // Deeper levels wrap the single node with empty siblings — but note the
      // on-chain tree parks the old root and keeps hashing upward; folding a
      // lone node with empty siblings is exactly what update_range does when
      // the dirty range has converged (boundary siblings are empty_hash).
      // Continue so the loop runs `depth` levels like the pallet.
    }
    if (level.length === 1 && l === depth) break;
  }
  // If depth exceeds what's needed, keep wrapping with empty siblings.
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += ARITY) {
      const children = [];
      for (let k = 0; k < ARITY; k++) children.push(i + k < level.length ? level[i + k] : emptyHash());
      next.push(hashNode(children));
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------- proofs
// pallets/zk-tree/src/tree.rs::generate_proof / verify_proof

/**
 * Generate a ZkMerkleProof for leafIndex.
 * getLeafHash(i) -> Uint8Array(32) (empty_hash for missing), getNodeHash(level, i) likewise.
 * Mirrors tree.rs::generate_proof exactly, incl. sibling order (child-index order, self skipped).
 */
export function generateProof(leafIndex, depth, getLeafHash, getNodeHash) {
  leafIndex = BigInt(leafIndex);
  depth = Number(depth);
  if (depth === 0) throw new Error("LeafNotFound: empty tree");
  let currentIndex = leafIndex;
  let currentHash = getLeafHash(leafIndex);
  const siblings = [];
  for (let level = 1; level <= depth; level++) {
    const parentIndex = currentIndex / BigInt(ARITY);
    const baseIndex = parentIndex * BigInt(ARITY);
    const levelSiblings = [];
    for (let i = 0; i < ARITY; i++) {
      const childIndex = baseIndex + BigInt(i);
      if (childIndex === currentIndex) continue;
      levelSiblings.push(level === 1 ? getLeafHash(childIndex) : getNodeHash(level - 1, childIndex));
    }
    const children = [currentHash, ...levelSiblings];
    currentHash = hashNode(children);
    siblings.push(levelSiblings.map((s) => hexEncode(s)));
    currentIndex = parentIndex;
  }
  return { leaf_index: leafIndex.toString(), siblings };
}

/**
 * Verify a proof: recompute the leaf hash from fields, fold with siblings
 * (hash_node sorts internally, so order never matters), compare to root.
 * Mirrors tree.rs::verify_proof.
 */
export function verifyProof(leafFields, proof, expectedRootHex) {
  const { hash } = hashLeaf(leafFields);
  let current = hash;
  for (const levelSiblings of proof.siblings) {
    const sibs = levelSiblings.map((s) => hexDecode(typeof s === "string" ? s : hexEncode(s)));
    current = hashNode([current, ...sibs]);
  }
  return hexEncode(current) === hexEncode(hexDecode(expectedRootHex));
}

// ---------------------------------------------------------------- SCALE leaf decode
// ZkLeaf<AccountId32, u32, u128>: to[32] ++ transfer_count u64 LE ++ asset_id u32 LE ++ amount u128 LE = 60 bytes

export function decodeLeaf(scaleBytes) {
  const b = Uint8Array.from(typeof scaleBytes === "string" ? hexDecode(scaleBytes) : scaleBytes);
  if (b.length !== 60) throw new Error("ZkLeaf SCALE encoding must be 60 bytes, got " + b.length);
  const to = b.slice(0, 32);
  let transferCount = 0n;
  for (let i = 0; i < 8; i++) transferCount |= BigInt(b[32 + i]) << BigInt(8 * i);
  let assetId = 0n;
  for (let i = 0; i < 4; i++) assetId |= BigInt(b[40 + i]) << BigInt(8 * i);
  let amount = 0n;
  for (let i = 0; i < 16; i++) amount |= BigInt(b[44 + i]) << BigInt(8 * i);
  return { to, transferCount, assetId, amountPlancks: amount };
}

export function encodeLeafForTest(leaf) {
  const out = new Uint8Array(60);
  out.set(Uint8Array.from(leaf.to).slice(0, 32), 0);
  out.set(u64leBytes(leaf.transferCount), 32);
  out.set(u32leBytes(leaf.assetId), 40);
  out.set(u128leBytes(leaf.amountPlancks), 44);
  return out;
}

// ---------------------------------------------------------------- storage keys & RPC
// Pallet storage prefix "ZkTree" (runtime/src/lib.rs: #[pallet_index(21)] pub type ZkTree).

export function storageKeyPlain(twox, pallet, item) {
  return "0x" + twox.storageKeyPlain(pallet, item).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Leaves map: Identity hasher over u64 LE index. */
export function leavesStorageKey(twox, index) {
  const keyBytes = Array.from(u64leBytes(index));
  return "0x" + twox.storageKeyMap("ZkTree", "Leaves", keyBytes, "identity").map((b) => b.toString(16).padStart(2, "0")).join("");
}

let _rpcId = 1;
export function rpcReq(method, params) {
  return { jsonrpc: "2.0", id: _rpcId++, method, params: params || [] };
}
export function rpcResetIds() {
  _rpcId = 1;
}
/** Runtime API call: state_call("<Trait>_<method>", "0x" ++ SCALE(params)). */
export function rpcStateCall(apiMethod, paramHex) {
  return rpcReq("state_call", [apiMethod, paramHex || "0x"]);
}
export const ZK_RPC = {
  getLeafCount: () => rpcStateCall("ZkTreeApi_get_leaf_count"),
  getDepth: () => rpcStateCall("ZkTreeApi_get_depth"),
  getRoot: () => rpcStateCall("ZkTreeApi_get_root"),
  getMerkleProof: (index) => rpcStateCall("ZkTreeApi_get_merkle_proof", "0x" + hexEncode(u64leBytes(index))),
  getStorage: (keyHex) => rpcReq("state_getStorage", [keyHex]),
  getHeader: () => rpcReq("chain_getHeader", []),
};

/** Decode a state_call u64 LE result ("0x" hex) -> BigInt. */
export function decodeU64LeHex(hex) {
  const b = hexDecode(hex);
  if (b.length !== 8) throw new Error("expected 8 bytes, got " + b.length);
  return u64le(b, 0);
}

// ---------------------------------------------------------------- SCALE proof-RPC decode
// ZkMerkleProofRpc { leaf_index: u64, siblings: Vec<[Hash256; 3]>, root: Hash256, depth: u8 }
// as returned by ZkTreeApi_get_merkle_proof via state_call (SCALE Option<...>).

/** Decode a SCALE compact integer at offset. Returns {value: BigInt, bytesRead}. */
export function decodeCompact(bytes, offset) {
  const b0 = bytes[offset];
  const mode = b0 & 0x03;
  if (mode === 0) return { value: BigInt(b0 >> 2), bytesRead: 1 };
  if (mode === 1) {
    const v = BigInt(b0 >> 2) | (BigInt(bytes[offset + 1]) << 6n);
    return { value: v, bytesRead: 2 };
  }
  if (mode === 2) {
    let v = BigInt(b0 >> 2);
    for (let i = 1; i < 4; i++) v |= BigInt(bytes[offset + i]) << BigInt(6 + 8 * (i - 1));
    return { value: v, bytesRead: 4 };
  }
  const len = Number(b0 >> 2);
  let v = 0n;
  for (let i = 0; i < len; i++) v |= BigInt(bytes[offset + 1 + i]) << BigInt(8 * i);
  return { value: v, bytesRead: 1 + len };
}

export function decodeMerkleProofRpc(hex) {
  const b = Uint8Array.from(hexDecode(hex));
  if (b.length < 1) throw new Error("empty proof response");
  if (b[0] === 0x00) return null; // None: leaf not provable (out of bounds / not yet settled)
  if (b[0] !== 0x01) throw new Error("bad Option prefix");
  let o = 1;
  let leafIndex = 0n;
  for (let i = 0; i < 8; i++) leafIndex |= BigInt(b[o + i]) << BigInt(8 * i);
  o += 8;
  const { value: levels, bytesRead } = decodeCompact(b, o);
  o += bytesRead;
  const siblings = [];
  for (let l = 0n; l < levels; l++) {
    const triple = [];
    for (let k = 0; k < 3; k++) {
      triple.push(hexEncode(b.slice(o, o + 32)));
      o += 32;
    }
    siblings.push(triple);
  }
  const root = hexEncode(b.slice(o, o + 32));
  o += 32;
  const depth = b[o];
  o += 1;
  if (o !== b.length) throw new Error("trailing bytes in proof encoding");
  return { leaf_index: leafIndex.toString(), siblings, root: "0x" + root, depth };
}

/** Encode a ZkMerkleProofRpc the way the runtime API would (for tests). */
export function encodeMerkleProofRpcForTest(proof, rootHex, depth) {
  const out = [0x01];
  const li = BigInt(proof.leaf_index);
  for (let i = 0; i < 8; i++) out.push(Number((li >> BigInt(8 * i)) & 0xffn));
  const n = proof.siblings.length;
  if (n >= 64) throw new Error("test encoder: compact single-byte only");
  out.push(n << 2);
  for (const triple of proof.siblings)
    for (const h of triple) out.push(...hexDecode(h));
  out.push(...hexDecode(rootHex));
  out.push(depth);
  return "0x" + out.map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- amount / address parsing

export function parseQtcToPlancks(str) {
  const s = String(str).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error("invalid QTC amount: " + str);
  const parts = s.split(".");
  const frac = (parts[1] || "").padEnd(12, "0");
  return BigInt(parts[0]) * PLANCKS_PER_QTC + BigInt(frac);
}

export function formatQtc(plancks) {
  let p = BigInt(plancks);
  if (p === 0n) return "0";
  const neg = p < 0n;
  if (neg) p = -p;
  const whole = p / PLANCKS_PER_QTC;
  const frac = p % PLANCKS_PER_QTC;
  const ws = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac === 0n) return (neg ? "-" : "") + ws;
  return (neg ? "-" : "") + ws + "." + frac.toString().padStart(12, "0").replace(/0+$/, "");
}

/** Accept an SS58 qz… address, 0x/hex 32-byte account, or 64-hex-char account id. */
export function parseAccount(input) {
  const s = String(input).trim();
  if (!s) throw new Error("empty account");
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return { bytes: hexDecode(s), kind: "hex" };
  const { prefix, accountId } = ss58Decode(s);
  if (prefix !== QUANTUS_SS58_PREFIX)
    throw new Error("SS58 prefix " + prefix + " is not Quantus (" + QUANTUS_SS58_PREFIX + ")");
  return { bytes: accountId, kind: "ss58" };
}

// ---------------------------------------------------------------- exhaustion math

export const BLOCK_TIME_S = 12; // QPoW target block time (pallet_qpow)

export function exhaustionProjection(currentLeaves, leavesPerBlock) {
  const cap = capacityAtDepth(CIRCUIT_MAX_TREE_DEPTH); // 4^16
  const remaining = cap - BigInt(currentLeaves);
  const rate = Number(leavesPerBlock);
  if (!(rate > 0)) throw new Error("rate must be positive");
  const blocksLeft = Number(remaining) / rate;
  const secondsLeft = blocksLeft * BLOCK_TIME_S;
  return {
    capacity: cap,
    remaining,
    blocksLeft,
    yearsLeft: secondsLeft / 31557600,
  };
}

export const ZK = {
  ARITY,
  MAX_TREE_DEPTH,
  CIRCUIT_MAX_TREE_DEPTH,
  AMOUNT_SCALE_DOWN_FACTOR,
  PLANCKS_PER_QTC,
  GOLDEN_LEAF,
  emptyHash,
  canonicalizeAccountBytes,
  hashLeaf,
  hashNode,
  capacityAtDepth,
  depthForLeaves,
  computeRoot,
  generateProof,
  verifyProof,
  decodeLeaf,
  encodeLeafForTest,
  decodeCompact,
  decodeMerkleProofRpc,
  encodeMerkleProofRpcForTest,
  storageKeyPlain,
  leavesStorageKey,
  rpcReq,
  rpcResetIds,
  rpcStateCall,
  ZK_RPC,
  decodeU64LeHex,
  parseQtcToPlancks,
  formatQtc,
  parseAccount,
  exhaustionProjection,
  bytesEqual,
  hexEncode,
  hexDecode,
};
