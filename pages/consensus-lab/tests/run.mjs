#!/usr/bin/env node
/* QTC Consensus Lab — node logic tests.
 * Known-answer vectors hand-derived from pallet_qpow::calculate_difficulty
 * (Quantus-Network/chain, pallets/qpow/src/lib.rs); several mirror the
 * expectations of the upstream Rust tests in pallets/qpow/src/tests.rs.
 */
import {
  calculateDifficulty, recomputeChain, hashrateFromDifficulty,
  fmtDiff, fmtHashrate, retargetZone,
  TARGET_MS, MIN_DIFF, MAX_DIFF, INITIAL_DIFF,
} from "../consensus-core.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = String(got), w = String(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${g}, want ${w}`); }
}
function ok(name, cond, extra = "") {
  if (cond) pass++;
  else { fail++; console.error(`FAIL ${name} ${extra}`); }
}

const D = (p, t, tgt = 12000n) => calculateDifficulty(BigInt(p), BigInt(t), BigInt(tgt));

// --- mirrors upstream test_difficulty_calculation (D=1000, observed 2000, target 1000):
// divisor=833, tf=2, adj=-1, inc=1000/2048=0 -> 1000, then clamped UP to the
// 2^17 minimum (the upstream test only asserts the bounds hold)
eq("upstream-vector slow-block", D(1000, 2000, 1000).difficulty, 131072n);

// --- mirrors upstream test_min_difficulty_can_increase (min, observed 1, target 1000):
// floored to 500; divisor=833, tf=0, adj=+1, inc=64 -> 131136
eq("upstream-vector min-increase", D(131072, 1, 1000).difficulty, 131136n);

// --- mirrors upstream test_retarget_floors_small_block_time: 1ms and 500ms identical
eq("floor 1ms==500ms",
  D(5000000, 1).difficulty, D(5000000, 500).difficulty);

// --- mirrors upstream test_zero_observed_block_time: floored, stays >= min
{
  const r = D(200000, 0, 1000);
  ok("zero-time >= min", r.difficulty >= MIN_DIFF);
  eq("zero-time floored flag", r.floored, true);
}

// --- dead zone: exactly target -> no change
eq("target -> no change", D(2048000, 12000).difficulty, 2048000n);
eq("dead zone 10-20s", D(2048000, 19999).difficulty, 2048000n);

// --- step boundaries at 12s target (divisor 10000)
eq("fast 9s -> +1/2048", D(2048000, 9000).difficulty, 2049000n);   // inc=1000
eq("slow 25s -> -1/2048", D(2048000, 25000).difficulty, 2047000n);
eq("very slow -> -99/2048 cap", D(2048000, 1000000).difficulty, 1949000n);
{
  const r = D(2048000, 1000000);
  eq("cap adjustment value", r.adjustment, -99n);
}

// --- clamps
eq("min clamp", D(131072, 10_000_000).difficulty, 131072n);
eq("max clamp", D(MAX_DIFF, 1000).difficulty, MAX_DIFF);
eq("genesis constants", `${TARGET_MS}/${MIN_DIFF}/${INITIAL_DIFF}`, "12000/131072/99999999999");

// --- recomputeChain fixture (hand-computed)
{
  const stamps = [[1, 0], [2, 12000], [3, 24000], [4, 49000], [5, 61000]];
  const { D: seq, gaps } = recomputeChain(stamps);
  // block2: genesis target 12s -> no change; block3: 12s -> no change;
  // block4: 25s -> -1/2048 of 99999999999 (inc=48828124) -> 99951171875; block5: 12s -> flat
  eq("chain[0]", seq[0], 99999999999n);
  eq("chain[1] genesis-target", seq[1], 99999999999n);
  eq("chain[2]", seq[2], 99999999999n);
  eq("chain[3] slow step", seq[3], 99951171875n);
  eq("chain[4] flat", seq[4], 99951171875n);
  eq("chain gaps", gaps, 0);
  const g2 = recomputeChain([[1, 0], [3, 24000]]);
  eq("gap counted", g2.gaps, 1);
}

// --- hashrate: E[hashes]=D, one block per 12s
eq("hashrate genesis", hashrateFromDifficulty(99999999999n), 8333333333n);

// --- formatters
eq("fmtDiff G", fmtDiff(99999999999n), "99.99G");
eq("fmtDiff small", fmtDiff(131072n), "131072");
eq("fmtHashrate", fmtHashrate(8333333333n), "8.33 GH/s");

// --- zones
eq("zone <10s", retargetZone(5000).cls, "up");
eq("zone 10-20s", retargetZone(15000).cls, "flat");
eq("zone 25s", retargetZone(25000).cls, "down");
eq("zone floored", retargetZone(10).cls, "up");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
