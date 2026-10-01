/* QTC ZkTree Desk — logic tests (Node).
 * Run: node tests/zktree-tests.mjs
 * Every vector below is pinned to Quantus-Network/chain @ 482c5b9,
 * pallets/zk-tree/src/{lib,tree}.rs and src/tests.rs.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const TWOX = require("../js/vendor/twox.js");

import { ZK } from "../js/zktree-core.js";
import { ss58Encode, hexEncode, hexDecode } from "../js/quantus-crypto.js";

let pass = 0,
  fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
  }
}
function eq(name, a, b) {
  ok(name, a === b, "got " + a + ", want " + b);
}
function throws(name, fn) {
  try {
    fn();
    ok(name, false, "did not throw");
  } catch (e) {
    ok(name, true);
  }
}

// --- 1. hash_leaf golden vector (tests.rs::hash_leaf_golden_vector) ---
{
  const g = ZK.GOLDEN_LEAF;
  const r = ZK.hashLeaf({
    to: hexDecode(g.toHex),
    transferCount: g.transferCount,
    assetId: g.assetId,
    amountPlancks: g.amountPlancks,
  });
  eq("golden vector hash", r.hashHex, g.expectedHex);
  eq("golden vector felt count", r.felts.length, 8);
  // felt layout: to_account limbs (0x1111...11 each), tc high=0 low=7, asset=5, amount=1234
  const limb = 0x1111111111111111n;
  eq("felt[0] to limb0", r.felts[0], limb);
  eq("felt[3] to limb3", r.felts[3], limb);
  eq("felt[4] tc high limb", r.felts[4], 0n);
  eq("felt[5] tc low limb", r.felts[5], 7n);
  eq("felt[6] asset_id", r.felts[6], 5n);
  eq("felt[7] quantized amount", r.felts[7], 1234n);
  eq("quantized math", r.quantized, 1234n);
  ok("canonical recipient", r.canonical === true);
  ok("no saturation", r.saturated === false);
}

// --- 2. transfer_count limb order: high then low ---
{
  const r = ZK.hashLeaf({
    to: hexDecode(ZK.GOLDEN_LEAF.toHex),
    transferCount: 0x0102030405060708n,
    assetId: 5,
    amountPlancks: 1234n * ZK.AMOUNT_SCALE_DOWN_FACTOR,
  });
  eq("tc high limb first", r.felts[4], 0x01020304n);
  eq("tc low limb second", r.felts[5], 0x05060708n);
}

// --- 3. hash_node: determinism, order-independence, sensitivity ---
{
  const c = (b) => new Uint8Array(32).fill(b);
  const h1 = ZK.hashNode([c(1), c(2), c(3), c(4)]);
  const h2 = ZK.hashNode([c(4), c(3), c(2), c(1)]);
  const h3 = ZK.hashNode([c(1), c(2), c(3), c(5)]);
  ok("hash_node deterministic", ZK.bytesEqual(h1, ZK.hashNode([c(1), c(2), c(3), c(4)])));
  ok("hash_node order-independent (sorted children)", ZK.bytesEqual(h1, h2));
  ok("hash_node sensitive to input", !ZK.bytesEqual(h1, h3));
  ok("hash_node non-empty", !ZK.bytesEqual(h1, ZK.emptyHash()));
}

// --- 4. canonicalize_account_bytes (tests.rs vectors) ---
{
  const P = 0xffffffff00000001n;
  const u64le = (v) => {
    const o = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      o[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return o;
  };
  // identity on canonical: largest canonical limb is p-1
  const b1 = new Uint8Array(32).fill(0x11);
  b1.set(u64le(P - 1n), 24);
  const r1 = ZK.canonicalizeAccountBytes(b1);
  ok("canonicalize identity on canonical", r1.canonical && ZK.bytesEqual(r1.bytes, b1));
  // reduces each non-canonical limb p+i -> i
  const b2 = new Uint8Array(32);
  for (let i = 0n; i < 4n; i++) b2.set(u64le(P + i), Number(i) * 8);
  const r2 = ZK.canonicalizeAccountBytes(b2);
  ok("canonicalize reduces p+i limbs", r2.reducedLimbs === 4 && !r2.canonical);
  const expect2 = new Uint8Array(32);
  for (let i = 0n; i < 4n; i++) expect2.set(u64le(i), Number(i) * 8);
  ok("canonicalize reduction values", ZK.bytesEqual(r2.bytes, expect2));
  // u64::MAX = p + (2^32 - 2)
  const b3 = new Uint8Array(32);
  b3.set(u64le(0xffffffffffffffffn), 0);
  const r3 = ZK.canonicalizeAccountBytes(b3);
  const reduced = u64le(0xffffffffffffffffn - P);
  ok(
    "canonicalize reduces u64::MAX limb",
    ZK.bytesEqual(r3.bytes.slice(0, 8), reduced) && ZK.bytesEqual(r3.bytes.slice(8), b3.slice(8))
  );
}

// --- 5. amount quantization + u32 saturation (tests.rs amount tests) ---
{
  const mk = (amt) =>
    ZK.hashLeaf({ to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: 7n, assetId: 5, amountPlancks: amt });
  const S = ZK.AMOUNT_SCALE_DOWN_FACTOR;
  const small = 1234n * S;
  const wrappingAlias = small + (1n << 32n) * S; // quantizes to 1234 + 2^32
  ok("oversized amount does not alias small amount", mk(small).hashHex !== mk(wrappingAlias).hashHex);
  const cap = 4294967295n * S;
  ok(
    "saturation: cap+1unit == cap",
    mk(cap).hashHex === mk(cap + S).hashHex && mk(cap).saturated === false && mk(cap + S).saturated === true
  );
  ok("saturation: u128::MAX saturates", mk(2n ** 128n - 1n).hashHex === mk(cap).hashHex);
  ok(
    "below cap commits true value",
    mk(cap - S).hashHex !== mk(cap).hashHex && mk(cap - S).saturated === false
  );
  eq("1 QTC -> 100 quantized units", mk(1000000000000n).quantized, 100n);
  // asset_id saturation
  const a = ZK.hashLeaf({ to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: 7n, assetId: 2n ** 40n, amountPlancks: small });
  eq("asset_id saturates at u32::MAX", a.assetIdU32, 4294967295n);
  throws("negative amount rejected", () => mk(-1n));
}

// --- 6. capacity / depth math ---
{
  eq("capacity(0)", ZK.capacityAtDepth(0), 0n);
  eq("capacity(1)", ZK.capacityAtDepth(1), 4n);
  eq("capacity(2)", ZK.capacityAtDepth(2), 16n);
  eq("capacity(16) = 4.29B", ZK.capacityAtDepth(16), 4294967296n);
  eq("depth(1)", ZK.depthForLeaves(1), 1);
  eq("depth(4)", ZK.depthForLeaves(4), 1);
  eq("depth(5)", ZK.depthForLeaves(5), 2);
  eq("depth(16)", ZK.depthForLeaves(16), 2);
  eq("depth(17)", ZK.depthForLeaves(17), 3);
}

// --- 7. computeRoot settled-tree semantics ---
{
  const lh = (i) => ZK.hashLeaf({ to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: BigInt(i), assetId: 0, amountPlancks: 10n ** 12n }).hash;
  const E = ZK.emptyHash();
  // single leaf, depth 1 == hash_node([leaf, empty, empty, empty])
  const r1 = ZK.computeRoot([lh(0)], 1);
  ok("depth-1 single-leaf root", ZK.bytesEqual(r1, ZK.hashNode([lh(0), E, E, E])));
  // empty tree -> empty hash
  ok("empty tree root is empty_hash", ZK.bytesEqual(ZK.computeRoot([], 1), E));
  // 5 leaves at depth 2: root stable and differs from 4-leaf root
  const five = [0, 1, 2, 3, 4].map(lh);
  const r5 = ZK.computeRoot(five, 2);
  const r4 = ZK.computeRoot(five.slice(0, 4), 2);
  ok("5-leaf root differs from 4-leaf root", !ZK.bytesEqual(r5, r4));
  ok("computeRoot deterministic", ZK.bytesEqual(r5, ZK.computeRoot(five, 2)));
  throws("depth too small rejected", () => ZK.computeRoot(five, 1));
}

// --- 8. proof generation + verification round-trip (mirrors tree.rs) ---
{
  // build a 10-leaf settled tree with node maps like the pallet's Nodes storage
  const leaves = [];
  for (let i = 0; i < 10; i++)
    leaves.push({ to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: BigInt(i), assetId: 0, amountPlancks: 10n ** 12n });
  const leafHashes = leaves.map((l) => ZK.hashLeaf(l).hash);
  const depth = ZK.depthForLeaves(leafHashes.length);
  const E = ZK.emptyHash();
  const nodeMaps = {}; // level -> Map(index -> hash)
  let level = leafHashes.map((h) => Uint8Array.from(h));
  for (let l = 1; l <= depth; l++) {
    const next = [];
    const m = new Map();
    for (let i = 0; i < level.length; i += 4) {
      const ch = [];
      for (let k = 0; k < 4; k++) ch.push(i + k < level.length ? level[i + k] : E);
      const h = ZK.hashNode(ch);
      const pi = Math.floor(i / 4) + (l === 1 ? 0 : 0);
      m.set(next.length, h);
      next.push(h);
    }
    nodeMaps[l] = m;
    level = next;
  }
  const root = ZK.computeRoot(leafHashes, depth);
  const rootHex = hexEncode(root);
  const getLeafHash = (i) => (Number(i) < leafHashes.length ? leafHashes[Number(i)] : E);
  const getNodeHash = (lvl, i) => nodeMaps[lvl].get(Number(i)) || E;
  let allOk = true;
  for (let i = 0; i < leafHashes.length; i++) {
    const proof = ZK.generateProof(i, depth, getLeafHash, getNodeHash);
    if (proof.siblings.length !== depth) allOk = false;
    if (!ZK.verifyProof(leaves[i], proof, rootHex)) allOk = false;
  }
  ok("all 10 proofs verify against the root", allOk);
  // tamper resistance
  const p0 = ZK.generateProof(0, depth, getLeafHash, getNodeHash);
  const bad = JSON.parse(JSON.stringify(p0));
  bad.siblings[0][0] = "ff".repeat(32);
  ok("tampered sibling fails verification", !ZK.verifyProof(leaves[0], bad, rootHex));
  ok("wrong leaf fields fail verification", !ZK.verifyProof({ ...leaves[0], transferCount: 999n }, p0, rootHex));
  ok("wrong root fails verification", !ZK.verifyProof(leaves[0], p0, "00".repeat(32)));
  throws("proof on empty tree rejected", () => ZK.generateProof(0, 0, getLeafHash, getNodeHash));
}

// --- 9. SCALE leaf decode round-trip ---
{
  const leaf = {
    to: hexDecode(ZK.GOLDEN_LEAF.toHex),
    transferCount: 123456789n,
    assetId: 42n,
    amountPlancks: 9876543210987654321n,
  };
  const enc = ZK.encodeLeafForTest(leaf);
  eq("leaf SCALE length", enc.length, 60);
  const dec = ZK.decodeLeaf(enc);
  ok("decode to", ZK.bytesEqual(dec.to, leaf.to));
  eq("decode transfer_count", dec.transferCount, leaf.transferCount);
  eq("decode asset_id", dec.assetId, leaf.assetId);
  eq("decode amount", dec.amountPlancks, leaf.amountPlancks);
  throws("decode rejects bad length", () => ZK.decodeLeaf(new Uint8Array(59)));
}

// --- 10. storage keys (twox_128, Identity map hasher) ---
{
  const plain = ZK.storageKeyPlain(TWOX, "ZkTree", "LeafCount");
  eq("plain key length", plain.length, 66); // 0x + 32 bytes
  const mapKey = ZK.leavesStorageKey(TWOX, 7);
  eq("map key length", mapKey.length, 82); // 0x + 40 bytes
  const base = ZK.storageKeyPlain(TWOX, "ZkTree", "Leaves");
  ok("map key starts with plain prefix", mapKey.startsWith(base));
  const idxBytes = Array.from(hexDecode(mapKey.slice(-16)));
  const expect = [7, 0, 0, 0, 0, 0, 0, 0];
  ok("Identity hasher appends raw u64 LE", JSON.stringify(idxBytes) === JSON.stringify(expect));
  // twox_128("System") cross-check from scale-lab's verified vector
  const te = new TextEncoder();
  eq(
    "twox128 sanity",
    TWOX.twox128hex(Array.from(te.encode("System"))),
    "26aa394eea5630e07c48ae0c9558cef7"
  );
}

// --- 11. account parsing ---
{
  const acct = new Uint8Array(32).fill(0x11);
  const addr = ss58Encode(acct, 189);
  ok("ss58 address starts qz", addr[0] === "q" && addr[1] === "z");
  const p1 = ZK.parseAccount(addr);
  ok("parseAccount ss58 round-trip", p1.kind === "ss58" && ZK.bytesEqual(p1.bytes, acct));
  const p2 = ZK.parseAccount("0x" + "11".repeat(32));
  ok("parseAccount hex", p2.kind === "hex" && ZK.bytesEqual(p2.bytes, acct));
  throws("wrong prefix rejected", () => ZK.parseAccount(ss58Encode(acct, 42)));
  throws("garbage rejected", () => ZK.parseAccount("not an address"));
}

// --- 12. RPC builders ---
{
  ZK.rpcResetIds();
  const r = ZK.ZK_RPC.getLeafCount();
  eq("state_call method", r.method, "state_call");
  eq("leaf_count api", r.params[0], "ZkTreeApi_get_leaf_count");
  eq("empty params", r.params[1], "0x");
  const mp = ZK.ZK_RPC.getMerkleProof(7);
  eq("proof api", mp.params[0], "ZkTreeApi_get_merkle_proof");
  eq("proof param u64 LE", mp.params[1], "0x0700000000000000");
  eq("decode u64 LE", ZK.decodeU64LeHex("0x0700000000000000"), 7n);
}

// --- 13. exhaustion projection ---
{
  const p = ZK.exhaustionProjection(150000, 1); // ~current leaves, 1 leaf/block floor
  eq("circuit capacity 4^16", p.capacity, 4294967296n);
  ok("~1,600 years at 1 leaf/block", p.yearsLeft > 1600 && p.yearsLeft < 1640);
  const p2 = ZK.exhaustionProjection(0, 120); // 10 leaves/sec = 120/block
  ok("~13.6 years at 10 leaves/sec", p2.yearsLeft > 13 && p2.yearsLeft < 14);
}

// --- 14. amount parsing/formatting ---
{
  eq("parse 1.5 QTC", ZK.parseQtcToPlancks("1.5"), 1500000000000n);
  eq("format plancks", ZK.formatQtc(1500000000000n), "1.5");
  throws("too many decimals", () => ZK.parseQtcToPlancks("1.0000000000001"));
}

// --- 15. Merkle proof RPC round-trip ---
{
  const leaves = [];
  for (let i = 0; i < 6; i++)
    leaves.push({ to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: BigInt(i), assetId: 0, amountPlancks: 10n ** 12n });
  const leafHashes = leaves.map((l) => ZK.hashLeaf(l).hash);
  const depth = ZK.depthForLeaves(leafHashes.length);
  const E = ZK.emptyHash();
  const nodeMaps = {};
  let level = leafHashes.map((h) => Uint8Array.from(h));
  for (let l = 1; l <= depth; l++) {
    const next = [];
    const m = new Map();
    for (let i = 0; i < level.length; i += 4) {
      const ch = [];
      for (let k = 0; k < 4; k++) ch.push(i + k < level.length ? level[i + k] : E);
      m.set(next.length, ZK.hashNode(ch));
      next.push(m.get(next.length));
    }
    nodeMaps[l] = m;
    level = next;
  }
  const rootHex = hexEncode(ZK.computeRoot(leafHashes, depth));
  const getLeafHash = (i) => (Number(i) < leafHashes.length ? leafHashes[Number(i)] : E);
  const getNodeHash = (lvl, i) => nodeMaps[lvl].get(Number(i)) || E;
  const proof = ZK.generateProof(3, depth, getLeafHash, getNodeHash);
  const enc = ZK.encodeMerkleProofRpcForTest(proof, rootHex, depth);
  const dec = ZK.decodeMerkleProofRpc(enc);
  ok("proof RPC round-trips", dec !== null && dec.leaf_index === "3" && dec.depth === depth);
  ok("proof RPC root", dec.root === "0x" + rootHex);
  ok("proof RPC siblings", JSON.stringify(dec.siblings) === JSON.stringify(proof.siblings));
  ok("RPC-decoded proof verifies", ZK.verifyProof(leaves[3], dec, "0x" + rootHex));
  ok("None decodes to null", ZK.decodeMerkleProofRpc("0x00") === null);
  throws("trailing bytes rejected", () => ZK.decodeMerkleProofRpc(enc + "ff"));
  // compact codec sanity
  const c1 = ZK.decodeCompact(new Uint8Array([0x00]), 0);
  eq("compact 0", c1.value, 0n);
  const c2 = ZK.decodeCompact(new Uint8Array([0xa9, 0x07]), 0); // 0x07a9>>2 = 0x1ea4 = 7844? check: mode 1
  eq("compact mode1", c2.value, BigInt((0xa9 >> 2) | (0x07 << 6)));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
