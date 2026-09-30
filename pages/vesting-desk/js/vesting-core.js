/* QTC Vesting Desk — shared core (UMD: browser <script> and Node require()).
 *
 * On-chain semantics verified 2026-09-30 from a fresh clone of
 * Quantus-Network/chain:
 * - pallets/vesting/src/lib.rs `vested_amount`: linear start->end, nothing
 *   before cliff, full total at/after end, floor(total*(now-start)/(end-start)).
 * - Non-final payouts round down to multiples of NON_FINAL_PAYOUT_QUANTA(2500)
 *   x PayoutQuantum(0.01 QTC) = 25 QTC; the final claim pays the exact remainder.
 * - MinClaimInterval = MILLIS_PER_DAY (86,400,000 ms): at most one claim per
 *   schedule per day. claim is permissionless: pallet 22, call 0
 *   Vesting.claim(schedule_id); payout always goes to the stored beneficiary.
 * - runtime/src/genesis_config_presets/mainnet_vesting.rs: 27% TGE mint =
 *   5,670,000 QTC; spreadsheet grants lock 365 days then vest 3 years
 *   (cliff == start, nothing unlocks as a lump); intents grant (id 45)
 *   42,000 QTC vests from TGE over 365 days; treasury initial liquidity
 *   (id 46) 210,000 QTC over 16 days. TGE = first non-zero block-1
 *   timestamp = 1788943917807 ms (2026-09-09 08:51 UTC).
 *
 * All money math is BigInt plancks. 1 QTC = 1,000,000,000,000 plancks.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VestingCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PLANCKS_PER_QTC = 1000000000000n; // 1e12
  const PAYOUT_QUANTUM = 10000000000n; // 0.01 QTC (wormhole SCALE_DOWN_FACTOR)
  const NON_FINAL_PAYOUT_ALIGN = 2500n * PAYOUT_QUANTUM; // 25 QTC
  const MIN_CLAIM_INTERVAL_MS = 86400000; // MILLIS_PER_DAY

  // Genesis cohorts (ms since epoch), from mainnet_vesting.rs
  const TGE_MS = 1788943917807n;
  const GRANT_START_MS = 1820479917807n; // TGE + 365d
  const GRANT_END_MS = 1915087917807n; // TGE + 1460d
  const INTENTS_START_MS = 1788943917807n; // TGE
  const INTENTS_END_MS = 1820479917807n; // TGE + 365d
  const LIQUIDITY_START_MS = 1788943917807n; // TGE
  const LIQUIDITY_END_MS = 1790326317807n; // TGE + 16d

  const GENESIS_MINT_QTC = 5670000n; // 27% of 21M
  const GRANT_TOTAL_QTC = 5417940n; // indexer-observed: 46 grant schedules
  const INTENTS_TOTAL_QTC = 42000n;
  const LIQUIDITY_TOTAL_QTC = 210000n;

  /** Exact upstream vested_amount (pallets/vesting/src/lib.rs). */
  function vestedAmount(total, cliff, start, end, now) {
    total = BigInt(total); cliff = BigInt(cliff); start = BigInt(start);
    end = BigInt(end); now = BigInt(now);
    if (now < cliff) return 0n;
    if (now >= end) return total;
    const elapsed = now - start;
    const duration = end - start;
    if (duration <= 0n) return total;
    return (total * elapsed) / duration; // Rounding::Down
  }

  /**
   * On-chain payable estimate for one claim right now.
   * owed = vested - claimed. Final claim (vested >= total) pays the exact
   * remainder; non-final claims pay floor(owed / 25 QTC) * 25 QTC and must be
   * at least 25 QTC to move anything.
   * This is an estimate: the chain evaluates at the block timestamp of the
   * claim extrinsic, and at most one claim per schedule per day is allowed.
   */
  function claimableEstimate(total, claimed, vested) {
    total = BigInt(total); claimed = BigInt(claimed); vested = BigInt(vested);
    const owed = vested - claimed;
    if (owed <= 0n) return 0n;
    if (vested >= total) return owed; // exact final payout
    const aligned = (owed / NON_FINAL_PAYOUT_ALIGN) * NON_FINAL_PAYOUT_ALIGN;
    return aligned >= NON_FINAL_PAYOUT_ALIGN ? aligned : 0n;
  }

  /** Exact QTC formatting from plancks (BigInt): no floats, ever. */
  function fmtQTC(plancks, decimals) {
    let p = BigInt(plancks);
    const neg = p < 0n;
    if (neg) p = -p;
    const d = decimals === undefined ? 3 : decimals;
    const whole = (p / PLANCKS_PER_QTC).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (d === 0) return (neg ? "-" : "") + whole;
    const frac = ((p % PLANCKS_PER_QTC) * 10n ** BigInt(d)) / PLANCKS_PER_QTC;
    return (neg ? "-" : "") + whole + "." + frac.toString().padStart(d, "0");
  }

  /** Whole-number QTC with thousands separators, from plancks. */
  function fmtQTC0(plancks) {
    let p = BigInt(plancks);
    const neg = p < 0n;
    if (neg) p = -p;
    const s = (p / PLANCKS_PER_QTC).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + s;
  }

  /** Cohort key from (start,end) ms — matches the fetch script taxonomy. */
  function cohortOf(startMs, endMs) {
    const s = String(startMs), e = String(endMs);
    if (s === String(GRANT_START_MS) && e === String(GRANT_END_MS)) return "grant";
    if (s === String(INTENTS_START_MS) && e === String(INTENTS_END_MS)) return "intents";
    if (s === String(LIQUIDITY_START_MS) && e === String(LIQUIDITY_END_MS)) return "liquidity";
    return "unknown";
  }

  /**
   * Monthly unlock curve across schedules: for each month boundary from the
   * TGE month through the last vesting month, the aggregate vested supply at
   * that boundary (BigInt plancks) and the month's newly-unlocked inflow.
   */
  function monthlyCurve(schedules, nowMs) {
    const firstMonth = monthStart(Number(TGE_MS));
    const lastMonth = monthStart(Number(GRANT_END_MS));
    const points = [];
    let prev = 0n;
    // One month past the final boundary so the last point lands after the
    // last schedule's `end` and the curve totals the full vesting allocation.
    for (let t = firstMonth; t <= addMonths(lastMonth, 1); t = addMonths(t, 1)) {
      const tt = BigInt(t);
      let vested = 0n;
      for (const s of schedules) {
        vested += vestedAmount(
          BigInt(s.total_plancks), BigInt(s.cliff_ms),
          BigInt(s.start_ms), BigInt(s.end_ms), tt);
      }
      points.push({ monthMs: t, vested, inflow: vested - prev });
      prev = vested;
    }
    return points;
  }

  function monthStart(ms) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  function addMonths(ms, n) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  }

  /** Human "in Xd Yh" countdown. */
  function countdown(msFromNow) {
    if (msFromNow <= 0) return "now";
    const s = Math.floor(msFromNow / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
      m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtDate(ms) {
    const d = new Date(Number(ms));
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${M[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }

  return {
    PLANCKS_PER_QTC, PAYOUT_QUANTUM, NON_FINAL_PAYOUT_ALIGN,
    MIN_CLAIM_INTERVAL_MS, TGE_MS, GRANT_START_MS, GRANT_END_MS,
    INTENTS_START_MS, INTENTS_END_MS, LIQUIDITY_START_MS, LIQUIDITY_END_MS,
    GENESIS_MINT_QTC, GRANT_TOTAL_QTC, INTENTS_TOTAL_QTC, LIQUIDITY_TOTAL_QTC,
    vestedAmount, claimableEstimate, fmtQTC, fmtQTC0, cohortOf,
    monthlyCurve, monthStart, addMonths, countdown, fmtDate,
  };
});
