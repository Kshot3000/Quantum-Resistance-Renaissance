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

/* Zone of the retarget for a given observed block time (for the zone table). */
export function retargetZone(blockTimeMs) {
  const bt = blockTimeMs < 500 ? 500 : blockTimeMs;
  const tf = Math.floor(bt / 10000);
  const adj = Math.max(1 - tf, -99);
  if (adj > 0) return { label: "difficulty rises", adj, cls: "up" };
  if (adj < 0) return { label: "difficulty falls", adj, cls: "down" };
  return { label: "no change", adj: 0, cls: "flat" };
}
