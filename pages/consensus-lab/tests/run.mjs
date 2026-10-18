#!/usr/bin/env node
/* QTC Consensus Lab — node logic tests.
 * Known-answer vectors hand-derived from pallet_qpow::calculate_difficulty
 * (Quantus-Network/chain, pallets/qpow/src/lib.rs); several mirror the
 * expectations of the upstream Rust tests in pallets/qpow/src/tests.rs.
 */
import {
  calculateDifficulty, recomputeChain, hashrateFromDifficulty,
  fmtDiff, fmtHashrate, retargetZone, validSnapshot, validBlockHeight, expectedTrendLength,
  TARGET_MS, MIN_DIFF, MAX_DIFF, INITIAL_DIFF,
} from "../consensus-core.js";
import { readFileSync } from "node:fs";

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

// --- snapshot boundary (round 2): shapes AND relations. The real snapshot
// must pass its own boundary unchanged; every relational poison must fail.
{
  const real = JSON.parse(readFileSync(new URL("../../../data/consensus.json", import.meta.url), "utf8"));
  const now = Date.parse(real.fetched_at) + 60000; // pin "now" just after capture
  ok("real snapshot passes its own boundary", validSnapshot(real, now) === true);
  const poison = (name, fn) => {
    const s = JSON.parse(JSON.stringify(real));
    fn(s);
    ok("poison rejected: " + name, validSnapshot(s, now) === false);
  };
  poison("ok false", (s) => { s.ok = false; });
  poison("head absurd", (s) => { s.head = 9007199254740991; s.current.height = 9007199254740991; });
  poison("head fractional", (s) => { s.head += 0.5; s.current.height += 0.5; });
  poison("head boolean", (s) => { s.head = true; });
  poison("current.height disagrees", (s) => { s.current.height = s.head + 1; });
  poison("hashrate off by one", (s) => { s.current.est_hashrate_hs = (BigInt(s.current.est_hashrate_hs) + 1n).toString(); });
  poison("difficulty_hex bogus", (s) => { s.current.difficulty_hex = "0xdeadbeef"; });
  poison("net_change wrong", (s) => { s.difficulty.net_change_pct = 1.5; });
  poison("avg tampered", (s) => { s.block_times_ms.avg_ms += 5000; });
  poison("median tampered", (s) => { s.block_times_ms.median_ms += 1; });
  poison("p90 tampered", (s) => { s.block_times_ms.p90_ms += 1; });
  poison("max tampered", (s) => { s.block_times_ms.max_ms += 9999; });
  poison("sample miscounts window", (s) => { s.block_times_ms.sample = 1234; });
  poison("window entry negative", (s) => { s.block_times_ms.last[7] = -5; });
  poison("blocks_indexed short", (s) => { s.blocks_indexed = s.head - 5; });
  poison("missing invented", (s) => { s.missing_heights = 3; });
  poison("fetched_at 2999", (s) => { s.fetched_at = "2999-01-01T00:00:00.000Z"; });
  poison("fetched_at pre-genesis", (s) => { s.fetched_at = "2020-01-01T00:00:00.000Z"; });
  poison("trend tail difficulty", (s) => { s.trend[s.trend.length - 1][2] = "999999999999999"; });
  poison("recent tail difficulty", (s) => { s.recent[s.recent.length - 1][2] = "999999999999999"; });
  poison("recent tail height", (s) => { s.recent[s.recent.length - 1][0] = s.head - 1; });
  poison("trend head not genesis difficulty", (s) => { s.trend[0][2] = "131072"; });
  poison("trend heights not ascending", (s) => { s.trend[10][0] = s.trend[9][0]; });
  poison("longest gap below window max", (s) => { s.block_times_ms.longest_gap_ms = s.block_times_ms.max_ms - 1; });
  poison("longest gap height 0 with a gap", (s) => { s.block_times_ms.longest_gap_height = 0; });
  poison("min above current", (s) => { s.difficulty.min = (BigInt(s.current.difficulty) + 1n).toString(); });
  poison("max below current", (s) => { s.difficulty.max = (BigInt(s.current.difficulty) - 1n).toString(); });
  poison("genesis_ts disagrees with trend[0]", (s) => { s.genesis_ts += 60000; });
  // round 4: the trend's length is exact-pinned to the producer's sampled
  // size — the producer samples every 100 blocks and appends the head
  // point only when it is not already a sample step.
  eq("trend size N=2 (genesis + head)", expectedTrendLength(2), 2);
  eq("trend size N=101 (head on a sample step)", expectedTrendLength(101), 2);
  eq("trend size N=150 (2 samples + head)", expectedTrendLength(150), 3);
  eq("trend size N=201 (head on a sample step)", expectedTrendLength(201), 3);
  eq("trend size invalid N", expectedTrendLength(1), null);
  eq("real trend is the producer size", real.trend.length, expectedTrendLength(real.blocks_indexed));
  poison("trend one inserted point (producer+1)", (s) => {
    s.trend.splice(500, 0, [s.trend[499][0] + 1, s.trend[499][1], s.trend[0][2]]);
  });
  poison("trend one dropped point (producer-1)", (s) => { s.trend.splice(500, 1); });
  // round 3: producer-recompute relations — interior recent points and the
  // block-time window's chronological tail are pinned, not just the tails.
  poison("recent interior difficulty inflated", (s) => {
    s.recent[700][2] = (BigInt(s.recent[700][2]) * 2n).toString();
  });
  poison("recent interior timestamp +5s at a wide-gap index", (s) => {
    let idx = -1;
    for (let i = 1; i < s.recent.length - 1; i++) {
      if (s.recent[i][1] - s.recent[i - 1][1] > 7000 && s.recent[i + 1][1] - s.recent[i][1] > 7000) { idx = i; break; }
    }
    if (idx < 0) throw new Error("no wide-gap index in real snapshot");
    s.recent[idx][1] += 5000;
  });
  poison("block-time window adjacent swap (stats are order-blind)", (s) => {
    const L = s.block_times_ms.last;
    let a = -1;
    for (let i = L.length - 1499; i < L.length - 1; i++) { if (L[i] !== L[i + 1]) { a = i; break; } }
    if (a < 0) throw new Error("no swap pair in real window");
    const t = L[a]; L[a] = L[a + 1]; L[a + 1] = t;
  });
  // validBlockHeight fleet shape
  eq("height number", validBlockHeight(202254), 202254);
  eq("height digit string", validBlockHeight("202254"), 202254);
  eq("height boolean rejects", validBlockHeight(true), null);
  eq("height fractional rejects", validBlockHeight(1.5), null);
  eq("height scientific rejects", validBlockHeight("2.02e5"), null);
  eq("height absurd rejects", validBlockHeight(9007199254740991), null);
  eq("height zero rejects", validBlockHeight(0), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
