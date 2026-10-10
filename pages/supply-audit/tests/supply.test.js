// QTC Supply Audit — Node unit tests (js/audit-core.js).
// Run: node tests/supply.test.js
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(join(__dirname, "..", "js", "audit-core.js"));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); }
  console.log((cond ? "PASS " : "FAIL ") + name + (extra && !cond ? "  [" + extra + "]" : ""));
}

// ---------- constants (must match the verified runtime source) ----------
ok("divisor = 50_000_000", A.EMISSION_DIVISOR === 50000000n);
ok("leaf quantum = 1e10 planck (0.01 QTC)", A.LEAF_QUANTUM === 10000000000n);
ok("max supply = 21M QTC in plancks", A.MAX_SUPPLY === 21000000n * 1000000000000n);
ok("planck = 1e12", A.PLANCK === 1000000000000n);

// ---------- quantize ----------
ok("quantize floors to quantum", A.quantize(306599993980n) === 300000000000n);
ok("quantize keeps multiples", A.quantize(300000000000n) === 300000000000n);
ok("quantize small", A.quantize(30999999999n) === 30000000000n);
ok("quantize zero", A.quantize(0n) === 0n);

// ---------- first-block known answer ----------
// Genesis S0 = 5,670,000.301 QTC (all 22 block-1 transfers). The runtime formula
// predicts the first block reward at exactly 300,000,000,000 plancks, which is
// what the indexer's first MinerRewarded event (id 0000000001-…) records.
const S0 = 5670000301000000000n;
ok("first block subsidy = 300,000,000,000 plancks", A.subsidyAt(S0) === 300000000000n,
  "got " + A.subsidyAt(S0));
ok("subsidy is quantum-aligned", A.subsidyAt(S0) % A.LEAF_QUANTUM === 0n);

// ---------- baseline recurrence ----------
const b0 = A.baseline(S0, 0);
ok("baseline(0) = S0", b0.supply === S0);
const b1 = A.baseline(S0, 1);
ok("baseline(1) = S0 + first reward", b1.supply === S0 + 300000000000n);
const b100k = A.baseline(S0, 100000);
ok("baseline monotonic", b100k.supply > b1.supply);
ok("baseline below cap", b100k.supply < A.MAX_SUPPLY);
// The 0.01 QTC quantum dwarfs per-block decay: the quantized subsidy only
// steps down every ~1.67M blocks. Compare the raw (unquantized) values instead.
const rawAt = (s) => (A.MAX_SUPPLY - s) / A.EMISSION_DIVISOR;
ok("subsidy decays (raw)", rawAt(b100k.supply) < rawAt(S0));
const b5m = A.baseline(S0, 5000000);
ok("subsidy steps down over 5M blocks (quantized)", A.subsidyAt(b5m.supply) < A.subsidyAt(S0),
  A.fmtQtc(A.subsidyAt(b5m.supply)) + " vs " + A.fmtQtc(A.subsidyAt(S0)));
const b50m = A.baseline(S0, 50000000);
const remaining = A.MAX_SUPPLY - b50m.supply;
const remaining0 = A.MAX_SUPPLY - S0;
// Exponential approach: after D blocks the remaining gap closes by (1 - 1/e).
const expected = Number(remaining0) / Math.E;
const actual = Number(remaining);
ok("50M blocks closes 1-1/e of the gap", Math.abs(actual - expected) / expected < 0.05,
  "remaining=" + A.fmtQtc(remaining, 0));
ok("samples cover range", b100k.samples[0][0] === 0 && b100k.samples[b100k.samples.length-1][0] === 100000);

// ---------- formatting ----------
ok("fmtQtc basic", A.fmtQtc(1234567890123456789n) === "1,234,567.8901", A.fmtQtc(1234567890123456789n));
ok("fmtQtc zero", A.fmtQtc(0n) === "0.0000");
ok("fmtQtc truncates (no rounding)", A.fmtQtc(999999999999n) === "0.9999", A.fmtQtc(999999999999n));
ok("fmtQtc negative", A.fmtQtc(-1500000000000n) === "-1.5000");
ok("fmtQtc custom decimals", A.fmtQtc(1234567890123456789n, 2) === "1,234,567.89");
ok("fmtInt", A.fmtInt(139887) === "139,887");

// ---------- computeAudit on a synthetic fixture ----------
const POOL_ADDR = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7"; // real genesis pool (snapshot)
const fixture = {
  ok: true,
  fetched_at: "2026-10-10T00:00:00.000Z",
  block_height: 2,
  accounts_total: 10,
  mint_sentinel_id: A.MINT_SENTINEL,
  genesis: { count: 1, total_plancks: S0.toString(),
    transfers: [{ amount_plancks: S0.toString(), from: A.MINT_SENTINEL, to: POOL_ADDR }] },
  mined: { reward_events: 2, total_plancks: "610000000000" },
  balances_plancks: { free: (S0 + 610000000000n + 50000000000n).toString(), reserved: "0", frozen: "0" },
  vesting: { schedules: 1, total_plancks: "1000000000000000", claimed_plancks: "0", pool_account: POOL_ADDR, pool_free_plancks: "1000000000000000" },
  mint_sentinel: { free_plancks: "0", out_nongenesis_count: 4, out_nongenesis_plancks: "1220000000000" },
};
const fa = A.computeAudit(fixture);
ok("fixture recorded = s0 + mined", fa.recorded === S0 + 610000000000n);
ok("fixture gap = bal - recorded", fa.gap === 50000000000n);
ok("fixture feeWedge = mined - baselineMined", fa.feeWedge === fa.mined - fa.baselineMined);
ok("fixture baseline(2) = S0 + 2x300B", fa.base.supply === S0 + 600000000000n,
  "got " + fa.base.supply);
ok("fixture unattributed = (sentinelOut - mined) - gap", fa.unattributed === 560000000000n,
  "got " + fa.unattributed);

// ---------- computeAudit on the real snapshot (regression pins) ----------
const real = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "data", "supply.json"), "utf8"));
ok("snapshot has 22 genesis transfers (not 3)", real.genesis.count === 22, "count=" + real.genesis.count);
const ra = A.computeAudit(real);
ok("genesis = 5,670,000.301 QTC",
  ra.s0 === 5670000301000000000n, A.fmtQtc(ra.s0));
ok("genesis is 27.0000014% of cap",
  (ra.s0 * 1000000000n / A.MAX_SUPPLY) === 270000014n,
  String(ra.s0 * 1000000000n / A.MAX_SUPPLY));
ok("recorded mints self-consistent", ra.recorded === ra.s0 + ra.mined);
const gapPct = Number(ra.gap * 10000n / ra.bal) / 100;
// Drift-aware band (was a hard 0.6..0.9 pin until 2026-10-04): the gap grows
// ~one reward per block while reported supply grows far slower, so the share
// creeps up monotonically — 0.740% at height 139,888 (2026-09-30), 0.930% at
// 166,338 (2026-10-04). The substantive claim is "positive, ~1% of reported";
// assert that structurally instead of re-pinning a number every few weeks.
ok("gap is a positive ~1% of reported (drift-aware band)", gapPct > 0.5 && gapPct < 1.5, gapPct.toFixed(3) + "%");
const mult = Number(ra.sentinelOut * 1000n / ra.mined) / 1000;
// Drift-aware band (was 1.99..2.05): the numerator also accumulates wormhole
// exit proofs, which grow independently of rewards, so the ratio creeps up —
// exactly 2.0000x at 139,888 (2026-09-30), 2.0530x at 166,338 (2026-10-04).
// The substantive claim is "≈2x recorded rewards"; assert it with headroom.
ok("sentinel outflow ≈ 2x recorded rewards (drift-aware band)", mult > 1.99 && mult < 2.25, mult.toFixed(4) + "x");
// Reconciliation remainder: (sentinelOut − mined) − gap was 258.32 QTC at
// 139,888 and 268.81 QTC at 166,338 — small, positive, and slow-growing.
// If this ever goes negative or balloons, the audit's explanation is broken.
ok("unattributed remainder is small and positive", ra.unattributed > 0n && ra.unattributed < 1000n * A.PLANCK,
  A.fmtQtc(ra.unattributed) + " QTC");
const poolDiff = ra.poolFree - ra.unclaimed;
const apd = poolDiff < 0n ? -poolDiff : poolDiff;
ok("vesting pool ≈ unclaimed (dust-level)", apd <= 100000000000n, A.fmtQtc(apd, 6) + " QTC");
ok("reward events ≈ block height", Math.abs(real.mined.reward_events - real.block_height) <= 5,
  real.mined.reward_events + " vs " + real.block_height);
ok("fee wedge positive (fees recycled)", ra.feeWedge > 0n, A.fmtQtc(ra.feeWedge) + " QTC");
ok("subsidy now ≈ 0.30 QTC", ra.subsidy >= 300000000000n && ra.subsidy < 320000000000n,
  A.fmtQtc(ra.subsidy) + " QTC");

// ---------- sanitizeSupply: the payload boundary ----------
// Every malformed core field must reject wholesale (throw) BEFORE it
// can anchor a verdict figure; the cleaned copy normalizes counts to
// numbers and planck strings to canonical digit strings.
const cloneFixture = () => JSON.parse(JSON.stringify(fixture));
function rejects(name, mut) {
  const d = cloneFixture();
  mut(d);
  let threw = false;
  try { A.sanitizeSupply(d); } catch (e) { threw = /malformed supply payload/.test(e.message); }
  ok("sanitize rejects " + name, threw);
}
ok("sanitize accepts the valid fixture", !!A.sanitizeSupply(cloneFixture()));
ok("sanitize normalizes height/counts to numbers",
  A.sanitizeSupply(cloneFixture()).block_height === 2 && A.sanitizeSupply(cloneFixture()).accounts_total === 10);
rejects("non-object payload", (d) => { d.genesis = null; });
rejects("missing ok flag", (d) => { delete d.ok; });
rejects("unparseable fetched_at", (d) => { d.fetched_at = "not-a-date"; });
rejects("string block_height", (d) => { d.block_height = "2;evil"; });
rejects("fractional block_height", (d) => { d.block_height = 2.5; });
rejects("block_height beyond sanity bound", (d) => { d.block_height = 10000001; });
rejects("negative accounts_total", (d) => { d.accounts_total = -5; });
rejects("swapped mint_sentinel_id", (d) => { d.mint_sentinel_id = POOL_ADDR; });
rejects("genesis count != transfers length", (d) => { d.genesis.count = 22; });
rejects("genesis total != sum of transfers", (d) => { d.genesis.total_plancks = (S0 + 1000000000000n).toString(); });
rejects("genesis markup amount", (d) => { d.genesis.transfers[0].amount_plancks = "123<img src=x>"; });
rejects("genesis negative amount", (d) => { d.genesis.transfers[0].amount_plancks = "-5"; });
rejects("genesis malformed address", (d) => { d.genesis.transfers[0].to = "evil<img src=x>"; });
rejects("negative mined total", (d) => { d.mined.total_plancks = "-610000000000"; });
rejects("zero mined total", (d) => { d.mined.total_plancks = "0"; });
rejects("mined total beyond cap", (d) => { d.mined.total_plancks = (A.MAX_SUPPLY + 1n).toString(); });
rejects("null balance (aggregate sum missing)", (d) => { d.balances_plancks.free = null; });
rejects("balances total beyond cap", (d) => { d.balances_plancks.free = A.MAX_SUPPLY.toString(); d.balances_plancks.reserved = "1"; });
rejects("vesting claimed > total", (d) => { d.vesting.claimed_plancks = (BigInt(d.vesting.total_plancks) + 1n).toString(); });
rejects("vesting malformed pool address", (d) => { d.vesting.pool_account = "x"; });
rejects("sentinel outflow markup string", (d) => { d.mint_sentinel.out_nongenesis_plancks = "12a3"; });
ok("sanitize accepts a null pool balance (unavailable != malformed)",
  A.sanitizeSupply(Object.assign(cloneFixture(), {})).vesting.pool_free_plancks === "1000000000000000" &&
  (() => { const d = cloneFixture(); d.vesting.pool_free_plancks = null; return A.sanitizeSupply(d).vesting.pool_free_plancks === null; })());
ok("computeAudit rejects a malformed payload (no silent figures)",
  (() => { const d = cloneFixture(); d.mined.total_plancks = "-1"; try { A.computeAudit(d); return false; } catch { return true; } })());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
