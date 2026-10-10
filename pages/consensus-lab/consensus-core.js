/* QTC Consensus Lab — consensus-core.js
 * Exact BigInt port of pallet_qpow::calculate_difficulty
 * (Quantus-Network/chain, pallets/qpow/src/lib.rs) plus display helpers.
 * All math is integer-exact; no floats anywhere near a difficulty value.
 */

export const TARGET_MS = 12000n;          // runtime/src/lib.rs :: TARGET_BLOCK_TIME_MS
export const DIVISOR_MS = 10000n;         // target*10/12  (Homestead-ratio divisor)
export const MIN_RETARGET_MS = 500n;      // floored author-controlled block time
export const MIN_DIFF = 131072n;          // 2^17, same floor as Ethereum
export const MAX_DIFF = (1n << 512n) - 1n; // U512::MAX
export const INITIAL_DIFF = 99999999999n; // runtime/src/configs/mod.rs :: QPoWInitialDifficulty
export const STEP_DENOM = 2048n;
export const MAX_REORG_DEPTH = 100;       // runtime/src/configs/mod.rs :: MaxReorgDepth

/* Mirror of pallet_qpow::calculate_difficulty(parent, block_time_ms, target_ms). */
export function calculateDifficulty(parent, blockTimeMs, targetMs = TARGET_MS) {
  const bt = blockTimeMs > MIN_RETARGET_MS ? blockTimeMs : MIN_RETARGET_MS;
  let divisor = (targetMs * 10n) / 12n;
  if (divisor < 1n) divisor = 1n;
  const timeFactor = bt / divisor;               // integer division, like u64 /
  let adj = 1n - timeFactor;
  if (adj < -99n) adj = -99n;
  const inc = parent / STEP_DENOM;
  let next = adj >= 0n ? parent + inc * adj : parent - inc * -adj;
  if (next < MIN_DIFF) next = MIN_DIFF;
  if (next > MAX_DIFF) next = MAX_DIFF;
  return { difficulty: next, adjustment: adj, increment: inc, divisor, timeFactor, floored: blockTimeMs < MIN_RETARGET_MS };
}

/* Recompute difficulty over a timestamp series. stamps: [[height, tsMs], ...] ascending.
 * Returns { D: BigInt[], gaps: n } where D[i] is the mining difficulty of block i. */
export function recomputeChain(stamps) {
  const D = new Array(stamps.length);
  D[0] = INITIAL_DIFF;
  let gaps = 0;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i][0] !== stamps[i - 1][0] + 1) gaps += stamps[i][0] - stamps[i - 1][0] - 1;
    const h = stamps[i][0];
    const delta = h === 2 ? TARGET_MS
      : (stamps[i][1] > stamps[i - 1][1] ? BigInt(stamps[i][1] - stamps[i - 1][1]) : 0n);
    D[i] = calculateDifficulty(D[i - 1], delta).difficulty;
  }
  return { D, gaps };
}

/* Expected network hashrate implied by a difficulty: E[hashes to win] = D, one block per 12s. */
export function hashrateFromDifficulty(d) { return d / 12n; }

const UNITS = [["H/s", 0], ["kH/s", 3], ["MH/s", 6], ["GH/s", 9], ["TH/s", 12], ["PH/s", 15]];
export function fmtHashrate(hs) {
  const s = hs.toString();
  const exp = s.length - 1;
  let u = UNITS[0];
  for (const cand of UNITS) if (exp >= cand[1]) u = cand;
  if (u[1] === 0) return s + " H/s";
  const int = s.slice(0, s.length - u[1]) || "0";
  const frac = (s.slice(s.length - u[1], s.length - u[1] + 2) + "00").slice(0, 2);
  return `${int}.${frac} ${u[0]}`;
}

export function fmtDiff(d) {
  const s = d.toString();
  if (s.length <= 6) return s;
  const units = [["", 0], ["K", 3], ["M", 6], ["G", 9], ["T", 12], ["P", 15], ["E", 18]];
  let u = units[0];
  for (const c of units) if (s.length - 1 >= c[1]) u = c;
  const int = s.slice(0, s.length - u[1]) || "0";
  const frac = (s.slice(s.length - u[1], s.length - u[1] + 2) + "00").slice(0, 2);
  return `${int}.${frac}${u[0]}`;
}

export function fmtMs(ms) {
  if (ms < 1000) return ms + " ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + " s";
  if (s < 3600) return (s / 60).toFixed(1) + " min";
  return (s / 3600).toFixed(2) + " h";
}

export function pctChange(oldD, newD) {
  const bps = Number(((newD - oldD) * 1000000n) / oldD) / 10000;
  return bps;
}

/* ---------- snapshot boundary ----------
 * data/consensus.json is produced by scripts/fetch-consensus-data.mjs, so
 * every relation the generator guarantees can be re-checked here before a
 * single figure anchors: head == current.height, hashrate == difficulty/12,
 * hex == difficulty, net_change == the exact BigInt recompute, the
 * block-time stats == the stats of the last[] window they summarize,
 * blocks_indexed + missing == head, trend/recent tails == current, and
 * trend[0] == the genesis point. The 2026-10-09 validator checked shapes
 * only (finite / BigInt-parseable): a head of 9,007,199,254,740,991, a
 * tampered avg_ms, or a difficulty.min above the current difficulty all
 * painted as real. Shape is not a boundary — relations are. */
export const GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // chain exists from Sept 2026

/* Fleet block-height shape (tokenomics/whale/miningcalc): a number that is
 * a safe integer, or a canonical digit string, in 1..10,000,000. Booleans,
 * fractions, scientific strings and absurd heights reject. */
export function validBlockHeight(v) {
  let n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)) n = Number(v);
  else return null;
  return (Number.isSafeInteger(n) && n >= 1 && n <= 10000000) ? n : null;
}

/* Difficulty values travel as canonical digit strings; anything else
 * (hex, floats, "1e15", padded) is not a difficulty this chain produced. */
function digitBig(v) {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) return null;
  try { return BigInt(v); } catch { return null; }
}

export function validSnapshot(j, nowMs = Date.now()) {
  try {
    if (!j || typeof j !== "object") return false;
    if (j.ok !== true) return false;
    const fetchedMs = Date.parse(j.fetched_at);
    if (!Number.isFinite(fetchedMs) || fetchedMs < GENESIS_FLOOR_MS || fetchedMs > nowMs + 3600000) return false;
    const head = validBlockHeight(j.head);
    if (head === null) return false;
    // genesis_ts is trend[0]'s timestamp and predates the capture
    if (!Number.isSafeInteger(j.genesis_ts) || j.genesis_ts < GENESIS_FLOOR_MS || j.genesis_ts > fetchedMs) return false;
    // the indexer walked 1..head: what it indexed plus what it missed IS the head
    if (!Number.isSafeInteger(j.blocks_indexed) || j.blocks_indexed < 2) return false;
    if (!Number.isSafeInteger(j.missing_heights) || j.missing_heights < 0) return false;
    if (j.blocks_indexed + j.missing_heights !== head) return false;
    // current: height agrees with head; hashrate and hex are difficulty restated
    const cur = j.current;
    if (!cur || validBlockHeight(cur.height) !== head) return false;
    const D = digitBig(cur.difficulty);
    if (D === null || D < MIN_DIFF || D > MAX_DIFF) return false;
    if (cur.difficulty_hex !== "0x" + D.toString(16)) return false;
    if (digitBig(cur.est_hashrate_hs) !== D / 12n) return false;
    // difficulty extremes bracket the current value; net change recomputes exactly
    const d = j.difficulty;
    if (!d) return false;
    const maxD = digitBig(d.max), minD = digitBig(d.min);
    if (maxD === null || minD === null || minD < MIN_DIFF || minD > D || D > maxD || maxD > MAX_DIFF) return false;
    const maxH = validBlockHeight(d.max_height), minH = validBlockHeight(d.min_height);
    if (maxH === null || minH === null || maxH > head || minH > head) return false;
    if (d.net_change_pct !== Number(((D - INITIAL_DIFF) * 10000n) / INITIAL_DIFF) / 100) return false;
    // block-time stats must BE the stats of the window they summarize
    const bt = j.block_times_ms;
    if (!bt || !Array.isArray(bt.last) || !bt.last.length) return false;
    const last = bt.last;
    if (bt.sample !== last.length) return false;
    if (bt.sample !== Math.min(3000, j.blocks_indexed - 1)) return false;
    for (const t of last) if (!Number.isSafeInteger(t) || t < 0) return false;
    const sorted = [...last].sort((a, b) => a - b);
    const mean = last.reduce((a, b) => a + b, 0) / last.length;
    if (bt.avg_ms !== Math.round(mean)) return false;
    if (bt.median_ms !== sorted[Math.floor(sorted.length / 2)]) return false;
    if (bt.p90_ms !== sorted[Math.floor(sorted.length * 0.9)]) return false;
    if (bt.max_ms !== sorted[sorted.length - 1]) return false;
    // the all-time longest gap cannot be smaller than the window's own max
    if (!Number.isSafeInteger(bt.longest_gap_ms) || bt.longest_gap_ms < 0) return false;
    if (bt.longest_gap_ms === 0) { if (bt.longest_gap_height !== 0) return false; }
    else if (!Number.isSafeInteger(bt.longest_gap_height) || bt.longest_gap_height < 3 || bt.longest_gap_height > head) return false;
    if (head > bt.sample + 1 && bt.longest_gap_ms < bt.max_ms) return false;
    // trend + recent: [height, tsMs, difficulty] triples, ascending, tails == current
    const triples = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      let prevH = 0, prevTs = -1;
      for (const p of arr) {
        if (!Array.isArray(p) || p.length !== 3) return null;
        const h = validBlockHeight(p[0]);
        if (h === null || h > head || h <= prevH) return null;
        if (!Number.isSafeInteger(p[1]) || p[1] < j.genesis_ts || p[1] < prevTs || p[1] > fetchedMs + 300000) return null;
        const dd = digitBig(p[2]);
        if (dd === null || dd < MIN_DIFF || dd > MAX_DIFF) return null;
        prevH = h; prevTs = p[1];
      }
      return arr[arr.length - 1];
    };
    const trendTail = triples(j.trend), recentTail = triples(j.recent);
    if (!trendTail || !recentTail) return false;
    if (j.trend.length < 2 || j.recent.length !== Math.min(1500, j.blocks_indexed)) return false;
    // trend starts at the genesis point: block 1, genesis_ts, initial difficulty
    if (j.trend[0][0] !== 1 || j.trend[0][1] !== j.genesis_ts || j.trend[0][2] !== INITIAL_DIFF.toString()) return false;
    // both series end at the same head point, and it is the current point
    if (trendTail[0] !== head || recentTail[0] !== head) return false;
    if (trendTail[1] !== recentTail[1]) return false;
    if (trendTail[2] !== cur.difficulty || recentTail[2] !== cur.difficulty) return false;
    return true;
  } catch { return false; }
}

/* Zone of the retarget for a given observed block time (for the zone table). */
export function retargetZone(blockTimeMs) {
  const bt = blockTimeMs < 500 ? 500 : blockTimeMs;
  const tf = Math.floor(bt / 10000);
  const adj = Math.max(1 - tf, -99);
  if (adj > 0) return { label: "difficulty rises", adj, cls: "up" };
  if (adj < 0) return { label: "difficulty falls", adj, cls: "down" };
  return { label: "no change", adj: 0, cls: "flat" };
}
