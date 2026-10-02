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
const fixture = {
  block_height: 2,
  accounts_total: 10,
  mint_sentinel_id: A.MINT_SENTINEL,
  genesis: { count: 1, total_plancks: S0.toString(), transfers: [] },
  mined: { reward_events: 2, total_plancks: "610000000000" },
  balances_plancks: { free: (S0 + 610000000000n + 50000000000n).toString(), reserved: "0", frozen: "0" },
  vesting: { schedules: 1, total_plancks: "1000000000000000", claimed_plancks: "0", pool_account: "x", pool_free_plancks: "1000000000000000" },
  mint_sentinel: { free_plancks: "0", out_nongenesis_count: 4, out_nongenesis_plancks: "1220000000000" },
};
const fa = A.computeAudit(fixture);
ok("fixture recorded = s0 + mined", fa.recorded === S0 + 610000000000n);
ok("fixture gap = bal - recorded", fa.gap === 50000000000n);
ok("fixture feeWedge = mined - baselineMined", fa.feeWedge === fa.mined - fa.baselineMined);
ok("fixture baseline(2) = S0 + 2x300B", fa.base.supply === S0 + 600000000000n,
  "got " + fa.base.supply);

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
ok("gap is +0.6..0.9% of reported (flag band)", gapPct > 0.6 && gapPct < 0.9, gapPct.toFixed(3) + "%");
const mult = Number(ra.sentinelOut * 1000n / ra.mined) / 1000;
// Drift band: the ratio creeps as fresh captures land — 2.0210x at block
// ~152,606 (2026-10-02). The substantive claim is "≈2x", asserted tightly.
ok("sentinel outflow ≈ 2x recorded rewards", mult > 1.99 && mult < 2.05, mult.toFixed(4) + "x");
const poolDiff = ra.poolFree - ra.unclaimed;
const apd = poolDiff < 0n ? -poolDiff : poolDiff;
ok("vesting pool ≈ unclaimed (dust-level)", apd <= 100000000000n, A.fmtQtc(apd, 6) + " QTC");
ok("reward events ≈ block height", Math.abs(real.mined.reward_events - real.block_height) <= 5,
  real.mined.reward_events + " vs " + real.block_height);
ok("fee wedge positive (fees recycled)", ra.feeWedge > 0n, A.fmtQtc(ra.feeWedge) + " QTC");
ok("subsidy now ≈ 0.30 QTC", ra.subsidy >= 300000000000n && ra.subsidy < 320000000000n,
  A.fmtQtc(ra.subsidy) + " QTC");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
