/* Unit tests for the Quantus Key Forge crypto core.
 * Run: node tests/run-tests.mjs
 *
 * Vectors:
 *  - Poseidon2 permutation: P3_ZERO_RESULT / P3_SEQ_RESULT (poseidon2.rs tests,
 *    generated against p3-goldilocks + qp-poseidon-constants seed 0x3141592653589793)
 *  - Goldilocks arithmetic: goldilocks.rs test_against_p3_expected_values
 *  - bytes_to_felts: serialization.rs doc example (b"hello" -> 2 felts)
 *  - hash_twice / rehash_to_bytes: lib.rs test_hash_twice_vectors (5 vectors)
 *  - SS58: live Quantus mainnet address (prefix 189, 'qz' prefix, checksum)
 *  - ML-DSA: FIPS-204 parameter sizes + sign/verify round-trip (noble, seeded)
 */
import {
  P,
  poseidon2Permute,
  hashToFelts,
  hashToBytes,
  hashBytes,
  hashTwice,
  base58Encode,
  base58Decode,
  ss58Encode,
  ss58Decode,
  accountIdFromPubkey,
  pubkeyToAddress,
  hexEncode,
  hexDecode,
  QUANTUS_SS58_PREFIX,
} from '../js/quantus-crypto.js';
import { ml_dsa65, ml_dsa87 } from '../../../assets/vendor/noble/post-quantum/ml-dsa.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name} ${extra}`); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${a}, want ${b}`);
const eqHex = (name, bytes, hex) => eq(name, hexEncode(bytes), hex);

// ---- 1. permutation vs p3 vectors ----
const P3_ZERO = ['c9bc9432e1686884','03ecbab0dcdd2189','5e7ac885b3dc1215','6ac07513801d191f','ca5c593fb184dcfc','414dec5f3e455287','1a17df170127ae41','e7e592bd0af9b0a5','c71a9b27edc66a4c','2728671759ac43c2','b9969c20f7f672f9','c5140b586823b92f'];
const P3_SEQ  = ['7e9574e2a3d6c48b','9d7bc16d282d2f2b','798826626d94a498','0831011bb22304c7','bdccb5931fffd16c','e98687714dacbefc','c6a1ed29dd75e027','1aec96681d15f765','c74b2c710b170a23','5fb4aff45e9c24fb','1fb3d228db0127eb','e201a7e214b16e74'];
{
  const s = new Array(12).fill(0n);
  poseidon2Permute(s);
  ok('permute(zero) matches p3', s.every((v, i) => v === BigInt('0x' + P3_ZERO[i])));
  const t = Array.from({ length: 12 }, (_, i) => BigInt(i + 1));
  poseidon2Permute(t);
  ok('permute(1..12) matches p3', t.every((v, i) => v === BigInt('0x' + P3_SEQ[i])));
}

// ---- 2. field arithmetic (goldilocks.rs p3 vectors) ----
{
  const a = 13835875475997267463n, b = 13593300247443167546n;
  const add = (x, y) => { const s = x + y; return s >= P ? s - P : s; };
  const mul = (x, y) => (x * y) % P;
  const exp7 = (x) => { const x2 = mul(x,x), x3 = mul(x2,x), x4 = mul(x2,x2); return mul(x3,x4); };
  eq('field add', add(a, b).toString(), '8982431654025850688');
  eq('field sub', ((a - b + P) % P).toString(), '242575228554099917');
  eq('field mul', mul(a, b).toString(), '16746386726560462281');
  eq('field exp7', exp7(a).toString(), '5716687150516714629');
  eq('sbox(2)=128', exp7(2n).toString(), '128');
}

// ---- 3. hash_twice vectors (end-to-end sponge) ----
{
  const v = (felts, want) => eqHex(`hashTwice([${felts}])`, hashTwice(felts.map(BigInt)), want);
  v([], 'b8a2f205ad2e2682ab8af6e49946a597920a24d916ca1139b6fce113c207365b');
  v([0], '6e962ae00104d1c8907142439156035ad71242caab590a74ba8c9850df03ff11');
  v([1], '50be997dba65a402610d93f8fe853b0974fc72e4605effd5603deb900667e497');
  v([1, 2, 3, 4], '153624f84074a4503ea9139d64ad54da77849d83eb0e6a8e1f839bfe31c222b5');
  v([1, 2, 3, 4, 5, 6, 7, 8], '958293c7f14ec2ef872955b510eee16f041217f37f8db0c0287fbe182afde6af');
}
// rehash_to_bytes vectors: decode 32 bytes -> 4 canonical felts -> hash_to_bytes
{
  const rehash = (bytes) => {
    const felts = [];
    for (let i = 0; i < 4; i++) {
      let v = 0n;
      for (let b = 0; b < 8; b++) v |= BigInt(bytes[i * 8 + b]) << BigInt(8 * b);
      if (v >= P) throw new Error('non-canonical limb');
      felts.push(v);
    }
    return hashToBytes(felts);
  };
  eqHex('rehash(zeros)', rehash(new Uint8Array(32)), 'ca0aefbd2e87c9ecc4716b7db8e83937a45dfb06ea10e1d62a4c2f2784002290');
  eqHex('rehash(0..31)', rehash(Uint8Array.from({ length: 32 }, (_, i) => i)), 'c0877470eb2fbfc7cc6f22ab70955509de54f3b89856d6a58399a7b7d9d26252');
}

// ---- 4. hashBytes sanity (deterministic, 32 bytes, avalanche) ----
{
  const h1 = hashBytes(new TextEncoder().encode('test'));
  const h2 = hashBytes(new TextEncoder().encode('test'));
  const h3 = hashBytes(new TextEncoder().encode('tesu'));
  ok('hashBytes deterministic', hexEncode(h1) === hexEncode(h2));
  ok('hashBytes 32 bytes', h1.length === 32);
  ok('hashBytes avalanche', hexEncode(h1) !== hexEncode(h3));
  ok('hashBytes empty input works', hashBytes(new Uint8Array(0)).length === 32);
}

// ---- 5. SS58 against a real mainnet address ----
const KYLE_QTC = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';
{
  const d = ss58Decode(KYLE_QTC);
  eq('ss58 prefix is 189', d.prefix, 189);
  eq('ss58 prefix const', QUANTUS_SS58_PREFIX, 189);
  ok('account id 32 bytes', d.accountId.length === 32);
  ok('address starts with qz', KYLE_QTC.startsWith('qz'));
  eq('ss58 round-trip', ss58Encode(d.accountId, 189), KYLE_QTC);
  // tamper detection
  const bad = KYLE_QTC.slice(0, -1) + (KYLE_QTC.endsWith('u') ? 'v' : 'u');
  let threw = false;
  try { ss58Decode(bad); } catch { threw = true; }
  ok('ss58 rejects bad checksum', threw);
  // base58 round-trip
  const raw = base58Decode(KYLE_QTC);
  eq('base58 round-trip', base58Encode(raw), KYLE_QTC);
}

// ---- 6. ML-DSA keygen + full address pipeline ----
{
  for (const [name, mod, pkLen, skLen, sigLen] of [
    ['ml-dsa-65', ml_dsa65, 1952, 4032, 3309],
    ['ml-dsa-87', ml_dsa87, 2592, 4896, 4627],
  ]) {
    const seed = new Uint8Array(32).fill(7);
    const { publicKey, secretKey } = mod.keygen(seed);
    eq(`${name} pubkey bytes`, publicKey.length, pkLen);
    eq(`${name} secretkey bytes`, secretKey.length, skLen);
    const msg = new TextEncoder().encode('quantus key forge self-test');
    const sig = mod.sign(msg, secretKey);
    eq(`${name} sig bytes`, sig.length, sigLen);
    ok(`${name} verify`, mod.verify(sig, msg, publicKey));
    ok(`${name} verify rejects tampered`, !mod.verify(sig, new TextEncoder().encode('quantus key forge self-tesu'), publicKey));
    const addr = pubkeyToAddress(publicKey);
    ok(`${name} address starts with qz`, addr.startsWith('qz'));
    const dec = ss58Decode(addr);
    eq(`${name} decoded prefix`, dec.prefix, 189);
    eq(`${name} accountId == hashBytes(pubkey)`, hexEncode(dec.accountId), hexEncode(accountIdFromPubkey(publicKey)));
    eq(`${name} deterministic from seed`, pubkeyToAddress(mod.keygen(seed).publicKey), addr);
  }
}

// ---- 7. hex helpers ----
{
  const b = hexDecode('0x00ff10');
  eq('hexDecode', hexEncode(b), '00ff10');
  let threw = false;
  try { hexDecode('zz'); } catch { threw = true; }
  ok('hexDecode rejects garbage', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
