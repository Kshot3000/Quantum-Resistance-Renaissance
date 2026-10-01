/* QTC SCALE Lab — node test suite.
 * Proves the codec against canonical vectors, independent oracles, and
 * round-trips. Run: node tests/run-tests.mjs  (from pages/scale-lab/)
 *
 * Oracle strategy (no memorized crypto):
 *  - blake2b-512 vectors: node:crypto (OpenSSL) live at test time, plus
 *    hardcoded values captured from node:crypto.
 *  - blake2b-128 vectors: hardcoded from Python hashlib (digest_size=16).
 *  - SS58 checksum: verified independently with node:crypto blake2b512 over
 *    "SS58PRE" || body.
 *  - twox_128("System") = 26aa394eea5630e07c48ae0c9558cef7, verified
 *    2026-09-30 against @polkadot/util-crypto and the chain's sp-crypto-hashing.
 *  - compact vectors: the canonical SCALE spec table (parity-scale-codec).
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);

const C = require("../js/scale-codec.js");
const CR = require("../js/vendor/scale-crypto.js");
globalThis.QSL_CRYPTO = CR; // twox.js resolves blake2b via the QSL_CRYPTO global
const T = require("../js/vendor/twox.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) {
  const norm = (x) => typeof x === "bigint" ? x.toString() + "n"
    : Array.isArray(x) ? "[" + x.map(norm).join(",") + "]"
    : (x && typeof x === "object") ? "{" + Object.keys(x).map((k) => k + ":" + norm(x[k])).join(",") + "}"
    : JSON.stringify(x);
  const x = norm(a), y = norm(b);
  if (x !== y) throw new Error((msg || "mismatch") + ": got " + x + " want " + y);
}
const hex = (bytes) => C.hexOf(bytes);
const strBytes = (s) => Array.from(new TextEncoder().encode(s));

console.log("— blake2b (vendored, vs node:crypto OpenSSL + python hashlib) —");
test("blake2b-512('') matches OpenSSL", () => {
  eq(hex(CR.blake2b([], 64)),
    "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce");
});
test("blake2b-512('abc') matches OpenSSL", () => {
  const mine = hex(CR.blake2b(strBytes("abc"), 64));
  const ref = createHash("blake2b512").update("abc").digest("hex");
  eq(mine, ref); eq(mine, "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");
});
test("blake2b-512 multi-block (200 bytes) matches OpenSSL", () => {
  const inp = new Array(200).fill(97);
  const mine = hex(CR.blake2b(inp, 64));
  const ref = createHash("blake2b512").update(Buffer.from(inp)).digest("hex");
  eq(mine, ref);
  eq(mine, "932355851d75f09c18646a9da87c25e055bc57f113121ad1ec63d45e7a1d62ab9133f8b7d1d7de9e0afa784eb6a8a11d78683013d0a672611f17668d9577d209");
});
test("blake2b-128 vectors match python hashlib", () => {
  eq(hex(CR.blake2b([], 16)), "cae66941d9efbd404e4d88758ea67670");
  eq(hex(CR.blake2b(strBytes("abc"), 16)), "cf4ab791c62b8d2b2109c90275287816");
  eq(hex(CR.blake2b(strBytes("System"), 16)), "789f1c09383940a7773420432ffd084a");
  eq(hex(CR.blake2b(new Array(200).fill(97), 16)), "d63a46941ee0449fd1a7292005e08096");
});
test("blake2b-128 is not a truncation of blake2b-512 (parameter block differs)", () => {
  const b = strBytes("abc");
  assert(hex(CR.blake2b(b, 16)) !== hex(CR.blake2b(b, 64)).slice(0, 32), "must differ");
});

console.log("— SS58 (prefix 189) —");
test("prefixBytes(189) = [0x6f, 0x40] (two-byte form)", () => {
  eq(CR.prefixBytes(189), [0x6f, 0x40]);
});
const KEY32 = Array.from({ length: 32 }, (_, i) => i); // 00..1f
test("ss58 round-trip: encode -> decode recovers key + prefix 189", () => {
  const addr = CR.ss58Encode(KEY32, 189);
  const d = CR.ss58Decode(addr);
  assert(d.ok, "decode failed: " + d.error);
  eq(d.prefix, 189); eq(d.key, KEY32);
});
test("ss58 checksum verified independently with node:crypto", () => {
  const addr = CR.ss58Encode(KEY32, 189);
  const raw = CR.b58decode(addr);
  const body = raw.slice(0, raw.length - 2), given = raw.slice(raw.length - 2);
  const ref = createHash("blake2b512").update(Buffer.from(strBytes("SS58PRE").concat(body))).digest();
  eq([ref[0], ref[1]], given);
});
test("ss58 tampered address fails checksum", () => {
  const addr = CR.ss58Encode(KEY32, 189);
  const last = addr[addr.length - 1];
  const alt = last === "1" ? "2" : "1";
  const d = CR.ss58Decode(addr.slice(0, -1) + alt);
  assert(!d.ok && d.kind === "checksum", "expected checksum failure, got " + JSON.stringify(d));
});
test("ss58 rejects bad base58 chars", () => {
  const d = CR.ss58Decode("not an address!!");
  assert(!d.ok && d.kind === "base58", "expected base58 failure");
});

console.log("— twox_128 / storage hashers —");
test("twox_128('System') = 26aa394eea5630e07c48ae0c9558cef7 (chain-verified anchor)", () => {
  eq(T.twox128hex(strBytes("System")), "26aa394eea5630e07c48ae0c9558cef7");
});
test("twox_128 output is 16 bytes; twox_64 is 8 bytes", () => {
  eq(T.twox128bytes(strBytes("x")).length, 16);
  eq(T.twox64bytes(strBytes("x")).length, 8);
});
test("storageKeyPlain('System','Account') = 32 bytes, starts with twox_128('System')", () => {
  const k = T.storageKeyPlain("System", "Account");
  eq(k.length, 32);
  eq(hex(k.slice(0, 16)), "26aa394eea5630e07c48ae0c9558cef7");
});
test("storageKeyMap lengths: blake2_128concat 80, twox64concat 72, identity 64", () => {
  const key = new Array(32).fill(7);
  eq(T.storageKeyMap("System", "Account", key, "blake2_128concat").length, 80);
  eq(T.storageKeyMap("System", "Account", key, "twox64concat").length, 72);
  eq(T.storageKeyMap("System", "Account", key, "identity").length, 64);
});
test("blake2_128concat embeds key bytes after the 16-byte hash", () => {
  const key = new Array(32).fill(9);
  const h = T.blake2_128Concat(key);
  eq(h.length, 48);
  eq(h.slice(16), key);
  eq(hex(h.slice(0, 16)), T.blake2_128hex(key));
});

console.log("— compact codec: canonical spec vectors —");
const CV = [
  ["0", "00"], ["1", "04"], ["42", "a8"], ["63", "fc"],
  ["64", "0101"], ["69", "1501"], ["16383", "fdff"], ["16384", "02000100"],
  ["1073741823", "feffffff"], ["1073741824", "0300000040"],
  ["4294967295", "03ffffffff"],
  ["18446744073709551615", "13ffffffffffffffff"],
  ["18446744073709551616", "17000000000000000001"],
];
for (const [dec, want] of CV) {
  test("compactEncode(" + dec + ") = " + want, () => {
    eq(hex(C.compactEncode(BigInt(dec))), want);
  });
  test("compactDecode(" + want + ") = " + dec + " (strict, canonical)", () => {
    const d = C.compactDecode(C.fromHex(want), 0, true);
    eq(d.value, BigInt(dec));
    assert(d.canonical, "should be canonical");
  });
}
test("compact mode names decode correctly", () => {
  eq(C.compactDecode(C.fromHex("a8"), 0, false).modeName, "single-byte");
  eq(C.compactDecode(C.fromHex("0101"), 0, false).modeName, "two-byte");
  eq(C.compactDecode(C.fromHex("02000100"), 0, false).modeName, "four-byte");
  eq(C.compactDecode(C.fromHex("0300000040"), 0, false).modeName, "big-integer");
});
test("strict decode rejects non-canonical mode-2 encoding of 100", () => {
  // 100 fits mode 1 (canonical 9101); 92010000 is the bloated mode-2 form
  let threw = false;
  try { C.compactDecode(C.fromHex("92010000"), 0, true); } catch (e) { threw = /non-canonical/.test(e.message); }
  assert(threw, "strict decode must reject");
  const lax = C.compactDecode(C.fromHex("92010000"), 0, false);
  eq(lax.value, 100n);
  assert(!lax.canonical, "lax decode must flag non-canonical");
  eq(lax.canonicalHex, "0x9101");
});
test("strict decode rejects non-canonical big-int (padded) encoding", () => {
  // 2^30 canonically 0300000040; 8-byte padded form is non-canonical
  let threw = false;
  try { C.compactDecode(C.fromHex("130000004000000000"), 0, true); } catch (e) { threw = /non-canonical/.test(e.message); }
  assert(threw, "strict decode must reject padded big-int");
});
test("compactEncode rejects negatives and > 2^536-1", () => {
  let n = 0;
  try { C.compactEncode(-1n); } catch (e) { n++; }
  try { C.compactEncode(1n << 536n); } catch (e) { n++; }
  eq(n, 2);
});
test("compact round-trip fuzz (boundaries + random)", () => {
  const vals = [0n, 1n, 63n, 64n, 16383n, 16384n, 1073741823n, 1073741824n,
    4294967295n, 4294967296n, (1n << 64n) - 1n, 1n << 64n, (1n << 536n) - 1n,
    123456789012345678901234567890n];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 60; i++) vals.push(BigInt(rnd()) * BigInt(rnd()) * BigInt(rnd()));
  for (const v of vals) {
    const e = C.compactEncode(v);
    const d = C.compactDecode(e, 0, true);
    eq(d.value, v, "round-trip of " + v);
  }
});

console.log("— primitives —");
test("u16 0x1234 -> 3412; u32 0x12345678 -> 78563412; u128 1 -> 01 + 15 zeros", () => {
  eq(hex(C.intEncode("u16", 0x1234)), "3412");
  eq(hex(C.intEncode("u32", 0x12345678)), "78563412");
  eq(hex(C.intEncode("u128", 1n)), "01" + "00".repeat(15));
});
test("i8 -1 -> ff; i16 -256 -> 00ff; i128 min/max round-trip", () => {
  eq(hex(C.intEncode("i8", -1)), "ff");
  eq(hex(C.intEncode("i16", -256)), "00ff");
  for (const v of [-(1n << 127n), -1n, 0n, 1n, (1n << 127n) - 1n]) {
    eq(C.intDecode("i128", C.intEncode("i128", v), 0).value, v);
  }
});
test("int range enforcement", () => {
  let n = 0;
  try { C.intEncode("u8", 256); } catch (e) { n++; }
  try { C.intEncode("u8", -1); } catch (e) { n++; }
  try { C.intEncode("i8", 128); } catch (e) { n++; }
  eq(n, 3);
});
test("bool strict: 0x02 rejected", () => {
  let threw = false;
  try { C.decode({ k: "bool" }, [2], true); } catch (e) { threw = true; }
  assert(threw, "strict bool must reject 0x02");
  eq(C.decode({ k: "bool" }, [1], true).value, true);
});

console.log("— composites —");
test("Option<u8>: None=00, Some(42)=012a", () => {
  const s = { k: "option", inner: { k: "u8" } };
  eq(hex(C.encode(s, null).bytes), "00");
  eq(hex(C.encode(s, 42).bytes), "012a");
  eq(C.decode(s, C.fromHex("012a"), true).value, 42n);
});
test("Vec<u8> [1,2,3] = 0c010203", () => {
  const s = { k: "vec", inner: { k: "u8" } };
  eq(hex(C.encode(s, [1, 2, 3]).bytes), "0c010203");
  eq(C.decode(s, C.fromHex("0c010203"), true).value, [1n, 2n, 3n]);
});
test("str 'hello' = 1468656c6c6f", () => {
  eq(hex(C.encode({ k: "str" }, "hello").bytes), "1468656c6c6f");
  eq(C.decode({ k: "str" }, C.fromHex("1468656c6c6f"), true).value, "hello");
});
test("tuple (u8, bool): (3, true) = 0301", () => {
  const s = { k: "tuple", items: [{ k: "u8" }, { k: "bool" }] };
  eq(hex(C.encode(s, [3, true]).bytes), "0301");
});
test("array [u16; 2] = fixed, no length prefix", () => {
  const s = { k: "array", inner: { k: "u16" }, len: 2 };
  eq(hex(C.encode(s, [0x1234, 0x5678]).bytes), "34127856");
});
test("struct field order + names", () => {
  const s = { k: "struct", fields: [{ name: "a", shape: { k: "u8" } }, { name: "b", shape: { k: "bool" } }] };
  const e = C.encode(s, { a: 1, b: true });
  eq(hex(e.bytes), "0101");
  eq(e.spans.length >= 2, true);
  const d = C.decode(s, e.bytes, true);
  eq(d.value, { a: 1n, b: true });
});
test("enum: B(7) with variants [A, B(u8)] = 0107", () => {
  const s = { k: "enum", variants: [{ name: "A", shape: null }, { name: "B", shape: { k: "u8" } }] };
  eq(hex(C.encode(s, { variant: 1, value: 7 }).bytes), "0107");
  eq(hex(C.encode(s, { variant: "A" }).bytes), "00");
  const d = C.decode(s, C.fromHex("0107"), true);
  eq(d.value.name, "B"); eq(d.value.value, 7n);
});
test("nested: Vec<Option<u32>> round-trip", () => {
  const s = { k: "vec", inner: { k: "option", inner: { k: "u32" } } };
  const v = [null, 1n, null, 4294967295n];
  const d = C.decode(s, C.encode(s, v).bytes, true);
  eq(d.value, v);
});
test("balance: 1 QTC = 1e12 plancks LE", () => {
  const s = { k: "balance" };
  eq(hex(C.encode(s, 1000000000000n).bytes), "0010a5d4e8" + "00".repeat(11));
  eq(C.qtcOf(1000000000000n), "1 QTC");
  eq(C.qtcOf(1500000000000n), "1.5 QTC");
});
test("accountid: 32 raw bytes, no prefix", () => {
  const e = C.encode({ k: "accountid" }, KEY32);
  eq(hex(e.bytes), hex(KEY32));
  eq(e.bytes.length, 32);
});
test("decode reports trailing bytes", () => {
  const d = C.decode({ k: "u8" }, [5, 6, 7], true);
  eq(d.value, 5n); eq(d.trailing, 2);
});
test("spans cover every byte exactly once (struct)", () => {
  const s = { k: "struct", fields: [{ name: "a", shape: { k: "u8" } }, { name: "b", shape: { k: "u16" } }] };
  const e = C.encode(s, { a: 9, b: 0x1234 });
  const covered = new Array(e.bytes.length).fill(0);
  for (const sp of e.spans) for (let i = sp.start; i < sp.end; i++) covered[i]++;
  assert(covered.every((c) => c === 1), "each byte owned by exactly one span");
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
