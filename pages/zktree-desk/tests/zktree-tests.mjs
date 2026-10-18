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

// --- 11. proof bounds: untrusted RPC bodies + pasted proofs (white-hat) ---
// decodeMerkleProofRpc reads a response from a user-supplied endpoint and
// verifyProof folds pasted JSON. The pallet caps depth at MAX_TREE_DEPTH
// (32); every level is exactly 3 siblings of 32 bytes. Both entry points
// now hold that grammar BEFORE looping/hashing: an absurd level count in
// a 14-byte body used to build millions of empty triples (slices past
// the end) before the trailing check fired, a pasted 2,000-level proof
// folded Poseidon for seconds, a truncated leaf_index died as a
// BigInt(undefined) TypeError, and a 1-byte sibling zero-padded into
// its hash slot instead of being rejected as malformed.
{
  const sib = "00".repeat(32);
  const bodyFor = (levels, extraBytes) => {
    const body = [0x01, 0, 0, 0, 0, 0, 0, 0, 0];
    if (levels < 64) body.push(levels << 2);
    else { const w = (levels << 2) | 2; body.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff); }
    for (let i = 0; i < extraBytes; i++) body.push(0);
    return "0x" + body.map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  throws("RPC proof declaring 2,000,000 levels in 14 bytes rejected", () =>
    ZK.decodeMerkleProofRpc(bodyFor(2000000, 0)));
  throws("RPC proof with 33 levels (full budget) rejected — chain max is 32", () =>
    ZK.decodeMerkleProofRpc(bodyFor(33, 33 * 96 + 33)));
  throws("RPC proof with truncated leaf_index rejected cleanly", () =>
    ZK.decodeMerkleProofRpc("0x010203"));
  throws("RPC proof with a truncated root rejected", () =>
    ZK.decodeMerkleProofRpc(bodyFor(1, 96 + 20)));
  throws("compact read past end rejected", () => ZK.decodeCompact(new Uint8Array([0x01]), 5));
  throws("compact mode-3 read past end rejected", () =>
    ZK.decodeCompact(new Uint8Array([0xff, 0x01]), 0));

  const leaf = {
    to: hexDecode(ZK.GOLDEN_LEAF.toHex), transferCount: 0n, assetId: 5n,
    amountPlancks: ZK.AMOUNT_SCALE_DOWN_FACTOR,
  };
  throws("pasted proof with 33 levels rejected before hashing", () =>
    ZK.verifyProof(leaf, { siblings: Array.from({ length: 33 }, () => [sib, sib, sib]) }, sib));
  throws("pasted proof with a 1-byte sibling rejected as malformed", () =>
    ZK.verifyProof(leaf, { siblings: [["ab", sib, sib]] }, sib));
  throws("pasted proof with a 2-sibling level rejected as malformed", () =>
    ZK.verifyProof(leaf, { siblings: [[sib, sib]] }, sib));
  throws("pasted proof with non-array siblings rejected as malformed", () =>
    ZK.verifyProof(leaf, { siblings: "nope" }, sib));
}

// --- 12. proof-paste length gate (white-hat): the verify handler used to
// JSON.parse the WHOLE paste before verifyProof's shape gate ran — a
// 40,600,031-char paste of 200,000 levels paid a full 273.8–723.3 ms
// parse building 200,000 level arrays, all to be rejected 0.3 ms later.
// parseProofPaste refuses over-cap pastes unread. The cap derives from
// the largest legitimate paste: a depth-32 (chain max) proof measures
// 6,536 chars compact / 7,540 pretty — 65,536 is >8x that.
{
  const sib = "ab".repeat(32);
  const proof32 = { leaf_index: "4294967295", siblings: Array.from({ length: 32 }, () => [sib, sib, sib]) };
  const compact = JSON.stringify(proof32);
  ok("paste cap exported at 65,536", ZK.MAX_PROOF_PASTE_CHARS === 65536);
  ok("proofPasteRoom fail-closed", ZK.proofPasteRoom(0) === 65536 && ZK.proofPasteRoom(65536) === 0 &&
    ZK.proofPasteRoom(-1) === 0 && ZK.proofPasteRoom(1.5) === 0 && ZK.proofPasteRoom("5") === 0);
  const parsed = ZK.parseProofPaste(compact);
  ok("depth-32 proof paste round-trips", parsed.siblings.length === 32 && parsed.leaf_index === "4294967295");
  const atCap = compact + " ".repeat(ZK.MAX_PROOF_PASTE_CHARS - compact.length);
  ok("exactly-cap paste still parses", atCap.length === 65536 && ZK.parseProofPaste(atCap).siblings.length === 32);
  let overErr = "";
  try { ZK.parseProofPaste(atCap + " "); } catch (e) { overErr = e.message; }
  ok("over-cap paste refused before parsing, size + cap named", /65537/.test(overErr) && /65536/.test(overErr), overErr);
  throws("malformed JSON still throws", () => ZK.parseProofPaste("[1,"));
  throws("non-string paste refused fail-closed", () => ZK.parseProofPaste(42));
  ok("pretty depth-32 proof (7,540 chars) parses", ZK.parseProofPaste(JSON.stringify(proof32, null, 2)).siblings.length === 32);
}

/* Endpoint length bound (white-hat): the observer endpoint reached
 * new WebSocket with no validation at all, and a constructor failure
 * schedules a reconnect — a hostile paste would be retried forever.
 * Cap 2,048 is >4x the largest genuine endpoint (hostname ≤253 per
 * RFC 1035 + scheme/port/path/key material well under 500 total). */
{
  ok("endpoint cap exported at 2,048", ZK.MAX_ENDPOINT_URL_CHARS === 2048);
  ok("endpointUrlRoom fail-closed", ZK.endpointUrlRoom(0) === 2048 && ZK.endpointUrlRoom(2048) === 0 &&
    ZK.endpointUrlRoom(2049) === 0 && ZK.endpointUrlRoom(-1) === 0 && ZK.endpointUrlRoom(1.5) === 0 && ZK.endpointUrlRoom("5") === 0);
  ok("endpoint: genuine validates", ZK.validateEndpointUrl("wss://rpc.quantus.network").ok === true);
  const atCap = "ws://127.0.0.1:9944/" + "p".repeat(2048 - "ws://127.0.0.1:9944/".length);
  ok("endpoint: exactly-cap validates", atCap.length === 2048 && ZK.validateEndpointUrl(atCap).ok === true);
  const over = ZK.validateEndpointUrl(atCap + "p");
  ok("endpoint: over-cap refused naming size + cap", !over.ok && /2049/.test(over.error) && /2048/.test(over.error), over.error);
  const huge = ZK.validateEndpointUrl("wss://" + "a".repeat(20000000));
  ok("endpoint: 20M-char paste refused before connecting", !huge.ok && /20000006/.test(huge.error), huge.error);
  ok("endpoint: http/empty/non-string refused", !ZK.validateEndpointUrl("https://x").ok && !ZK.validateEndpointUrl("").ok && !ZK.validateEndpointUrl(null).ok);
}

/* Batch 194: amount-input length bound. */
{
  ok("amount bound: cap exported", ZK.MAX_AMOUNT_CHARS === 512);
  eq("amount bound: genuine parses", ZK.parseQtcToPlancks("1.5"), 1500000000000n);
  throws("amount bound: 600 digits refused naming cap", () => ZK.parseQtcToPlancks("9".repeat(600)));
  let e = null; try { ZK.parseQtcToPlancks("9".repeat(600)); } catch (err) { e = err; }
  ok("amount bound: refusal names size + cap, no echo", !!e && /600/.test(e.message) && /512/.test(e.message) && !e.message.includes("9999999999"), e && e.message);
  throws("amount bound: long-but-tiny refused by gate", () => ZK.parseQtcToPlancks("0".repeat(600) + "1.5"));
  eq("amount bound: at-cap parses (no supply cap in this parser)", typeof ZK.parseQtcToPlancks("9".repeat(512)), "bigint");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
