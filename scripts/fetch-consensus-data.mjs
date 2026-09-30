#!/usr/bin/env node
/* Fetch Quantus consensus data from the public Subsquid indexer (server-side; no CORS).
 * Writes data/consensus.json for same-origin consumption on GitHub Pages.
 *
 * Method: the indexer does not expose QPoW.CurrentDifficulty storage, so difficulty
 * history is RECOMPUTED block-by-block from real block timestamps using an exact
 * BigInt port of pallet_qpow::calculate_difficulty (Ethereum-Homestead-style,
 * per-block retarget). This is deterministic: timestamps are on-chain data, so the
 * recompute reproduces the chain's actual difficulty values.
 *
 * Sources (Quantus-Network/chain, main):
 *  - formula:        pallets/qpow/src/lib.rs :: calculate_difficulty
 *  - target 12_000ms: runtime/src/lib.rs :: TARGET_BLOCK_TIME_MS
 *  - initial 99_999_999_999: runtime/src/configs/mod.rs :: QPoWInitialDifficulty
 *  - min 131_072:    pallets/qpow/src/lib.rs :: get_min_difficulty
 *  - max reorg 100:  runtime/src/configs/mod.rs :: MaxReorgDepth
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "consensus.json");

/* --- exact port of pallet_qpow::calculate_difficulty (all integer math) --- */
const MIN_RETARGET_MS = 500n;
const MIN_DIFF = 131072n; // 2^17, same as Ethereum
const MAX_DIFF = (1n << 512n) - 1n; // U512::MAX
const INITIAL_DIFF = 99999999999n;
const TARGET_MS = 12000n;

function calculateDifficulty(parent, blockTimeMs, targetMs) {
  const bt = blockTimeMs > MIN_RETARGET_MS ? blockTimeMs : MIN_RETARGET_MS;
  let divisor = (targetMs * 10n) / 12n;
  if (divisor < 1n) divisor = 1n;
  const timeFactor = bt / divisor;
  let adj = 1n - timeFactor;
  if (adj < -99n) adj = -99n;
  const inc = parent / 2048n;
  let next = adj >= 0n ? parent + inc * adj : parent - inc * -adj;
  if (next < MIN_DIFF) next = MIN_DIFF;
  if (next > MAX_DIFF) next = MAX_DIFF;
  return next;
}

async function gql(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}

async function fetchPage(from, attempt = 0) {
  const q = `query { block(limit: 1000, order_by: {height: asc}, where: {height: {_gte: ${from}}}) { height timestamp } }`;
  try {
    const d = await gql(q);
    return d.block;
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return fetchPage(from, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  const headRow = await gql(`query { s: chain_stats_by_pk(id: "global") { block_height } }`);
  const head = headRow.s.block_height;
  console.log("head =", head, "- fetching block timestamps...");

  const stamps = []; // [height, tsMs]
  let from = 1;
  const workers = [];
  const PAGE = 1000;
  const CONC = 4;
  let next = 1;
  async function worker() {
    while (next <= head) {
      const f = next;
      next += PAGE;
      const rows = await fetchPage(f);
      for (const r of rows) stamps.push([r.height, Date.parse(r.timestamp)]);
      if (f % 20000 === 1) console.log("  ...height", f);
    }
  }
  for (let i = 0; i < CONC; i++) workers.push(worker());
  await Promise.all(workers);
  stamps.sort((a, b) => a[0] - b[0]);

  // detect missing heights
  let missing = 0;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i][0] !== stamps[i - 1][0] + 1) missing += stamps[i][0] - stamps[i - 1][0] - 1;
  }

  // recompute difficulty: D[1] = initial; on_finalize(1) uses target; n>=2 uses real deltas
  const D = new Array(stamps.length);
  D[0] = INITIAL_DIFF;
  let maxD = INITIAL_DIFF, maxH = stamps[0][0];
  let minD = INITIAL_DIFF, minH = stamps[0][0];
  let longestGap = 0, longestGapH = 0;
  for (let i = 1; i < stamps.length; i++) {
    const h = stamps[i][0];
    const prevTs = stamps[i - 1][1];
    const ts = stamps[i][1];
    const delta = h === 2 ? TARGET_MS : (ts > prevTs ? BigInt(ts - prevTs) : 0n);
    if (h > 2 && ts - prevTs > longestGap) { longestGap = ts - prevTs; longestGapH = h; }
    const d = calculateDifficulty(D[i - 1], delta, TARGET_MS);
    D[i] = d;
    if (d > maxD) { maxD = d; maxH = h; }
    if (d < minD) { minD = d; minH = h; }
  }

  const N = stamps.length;
  const trend = [];
  for (let i = 0; i < N; i += 100) trend.push([stamps[i][0], stamps[i][1], D[i].toString()]);
  trend.push([stamps[N - 1][0], stamps[N - 1][1], D[N - 1].toString()]);
  const recent = [];
  for (let i = Math.max(0, N - 1500); i < N; i++) recent.push([stamps[i][0], stamps[i][1], D[i].toString()]);
  const times = [];
  for (let i = Math.max(1, N - 3000); i < N; i++) times.push(stamps[i][1] - stamps[i - 1][1]);
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;

  const curD = D[N - 1];
  const payload = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    method: "Difficulty recomputed block-by-block from real indexer block timestamps with an exact BigInt port of pallet_qpow::calculate_difficulty. D[1]=initial; on_finalize(1) uses the 12s target; blocks >=2 use real timestamp deltas (500ms floor).",
    constants: {
      target_block_time_ms: 12000,
      divisor_ms: 10000,
      step_denominator: 2048,
      max_up_step_bps: "0.0488%/block",
      max_down_step: "-99/2048 (~-4.83%)/block",
      min_retarget_block_time_ms: 500,
      initial_difficulty: INITIAL_DIFF.toString(),
      min_difficulty: MIN_DIFF.toString(),
      max_difficulty: "2^512 - 1",
      max_reorg_depth: 100,
    },
    head: stamps[N - 1][0],
    blocks_indexed: N,
    missing_heights: missing,
    genesis_ts: stamps[0][1],
    current: {
      height: stamps[N - 1][0],
      difficulty: curD.toString(),
      difficulty_hex: "0x" + curD.toString(16),
      est_hashrate_hs: (curD / 12n).toString(),
    },
    difficulty: {
      max: maxD.toString(), max_height: maxH,
      min: minD.toString(), min_height: minH,
      net_change_pct: Number(((curD - INITIAL_DIFF) * 10000n) / INITIAL_DIFF) / 100,
    },
    block_times_ms: {
      sample: times.length,
      avg_ms: Math.round(avg),
      median_ms: sorted[Math.floor(sorted.length / 2)],
      p90_ms: sorted[Math.floor(sorted.length * 0.9)],
      max_ms: sorted[sorted.length - 1],
      longest_gap_ms: longestGap, longest_gap_height: longestGapH,
      last: times,
    },
    trend,
    recent,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload) + "\n");
  console.log("wrote", outPath, "head=", payload.head, "missing=", missing,
    "currentD=", curD.toString(), "avgBlockMs=", Math.round(avg));
}

main().catch((e) => { console.error("fetch-consensus-data failed:", e.message || e); process.exit(1); });
