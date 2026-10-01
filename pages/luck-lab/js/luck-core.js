/* QTC Luck Lab — luck-core.js
 * Memoryless-Poisson mining math for the Luck Lab.
 *
 * Difficulty semantics (verified in the Consensus Lab against
 * Quantus-Network/chain pallets/qpow): E[hashes to win a block] = D, the
 * network targets one block per 12 s, so implied network hashrate = D / 12.
 * A miner hashing at h H/s finds blocks as a Poisson process with rate
 * lambda = h / D per second; the wait to the next block is exponential with
 * mean E = D / h seconds. Nothing here depends on luck having a memory.
 *
 * Plain script (no modules): loaded via <script> in the browser, required by
 * node for the test suite. All quantities are plain Numbers; difficulties up
 * to ~1e15 are exactly representable.
 */
"use strict";

var LuckCore = (function () {
  var BLOCK_TARGET_MS = 12000;
  var PLANCK = 1e12;
  var MAX_SUPPLY_QTC = 21e6;
  var EMISSION_DENOM = 50e6;

  /* Deterministic seeded RNG (mulberry32) so simulations are reproducible. */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* --- Solo mining: the exponential wait -------------------------------- */

  // Expected seconds until the next solo block: E = D / h.
  function soloExpectedWaitSec(difficulty, hashrateHs) {
    if (!(hashrateHs > 0) || !(difficulty > 0)) return Infinity;
    return difficulty / hashrateHs;
  }

  // Luck quantile: the wait t with P(wait <= t) = p, i.e. t_p = -E * ln(1-p).
  function soloQuantileWaitSec(difficulty, hashrateHs, p) {
    if (p <= 0) return 0;
    if (p >= 1) return Infinity;
    var E = soloExpectedWaitSec(difficulty, hashrateHs);
    if (!isFinite(E)) return Infinity;
    return -E * Math.log(1 - p);
  }

  // P(finding >= 1 solo block within `seconds`).
  function probAtLeastOneBlock(difficulty, hashrateHs, seconds) {
    var E = soloExpectedWaitSec(difficulty, hashrateHs);
    if (!isFinite(E)) return 0;
    if (!(seconds > 0)) return 0;
    return 1 - Math.exp(-seconds / E);
  }

  /* --- Poisson helpers --------------------------------------------------- */

  function poissonPmf(k, lambda) {
    if (lambda < 0 || k < 0 || Math.floor(k) !== k) return 0;
    if (lambda === 0) return k === 0 ? 1 : 0;
    var logP = -lambda + k * Math.log(lambda);
    for (var i = 2; i <= k; i++) logP -= Math.log(i);
    return Math.exp(logP);
  }

  function samplePoisson(lambda, rand) {
    if (!(lambda > 0)) return 0;
    if (lambda < 30) { // Knuth
      var L = Math.exp(-lambda), k = 0, p = 1;
      do { k++; p *= rand(); } while (p > L);
      return k - 1;
    }
    // Normal approximation with continuity correction (lambda >= 30).
    var u1 = Math.max(rand(), 1e-12), u2 = rand();
    var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }

  /* --- Monte Carlo -------------------------------------------------------- */

  // Inverse-CDF sampling of solo waits: t = -E * ln(1-u). Returns seconds.
  function simulateSoloWaits(difficulty, hashrateHs, trials, seed) {
    var rand = makeRng(seed);
    var E = soloExpectedWaitSec(difficulty, hashrateHs);
    var out = new Array(trials);
    for (var i = 0; i < trials; i++) {
      var u = 1 - rand(); // in (0,1]
      out[i] = -E * Math.log(u);
    }
    return out;
  }

  // Fair-proportional pool: your fraction f of network hashrate, blocks per
  // day ~ Poisson(blocksPerDay). Returns one earnings figure (QTC) per day.
  // Honest model: expected value is exact; variance is pool-level only —
  // PPLNS-window noise is NOT modeled (stated in the UI).
  function simulatePoolDailyEarnings(hashrateHs, netHashrateHs, rewardQtc, feeFrac, blocksPerDay, days, seed) {
    var rand = makeRng(seed);
    var f = netHashrateHs > 0 ? hashrateHs / netHashrateHs : 0;
    var perBlock = f * rewardQtc * (1 - feeFrac);
    var out = new Array(days);
    for (var d = 0; d < days; d++) out[d] = samplePoisson(blocksPerDay, rand) * perBlock;
    return out;
  }

  // Solo daily earnings: your own blocks per day ~ Poisson(h*86400/D).
  function simulateSoloDailyEarnings(hashrateHs, difficulty, rewardQtc, days, seed) {
    var rand = makeRng(seed);
    var lambdaDay = (difficulty > 0 && hashrateHs > 0) ? hashrateHs * 86400 / difficulty : 0;
    var out = new Array(days);
    for (var d = 0; d < days; d++) out[d] = samplePoisson(lambdaDay, rand) * rewardQtc;
    return out;
  }

  // Expected pool earnings per day under the fair-proportional model.
  function poolExpectedDailyQtc(hashrateHs, netHashrateHs, rewardQtc, feeFrac, blocksPerDay) {
    if (!(netHashrateHs > 0) || !(hashrateHs > 0)) return 0;
    return (hashrateHs / netHashrateHs) * blocksPerDay * rewardQtc * (1 - feeFrac);
  }

  /* --- Difficulty scenarios ---------------------------------------------- */
  // Network hashrate jumps by ratio r instantly. New steady-state difficulty
  // is D*r. Catch-up blocks via the runtime retarget (max +1/2048 up,
  // max -99/2048 down per block): up ~ 2048*ln(r) blocks, down geometric at
  // 99/2048 per block.
  function retargetCatchupBlocks(r) {
    if (!(r > 0)) return NaN;
    if (Math.abs(r - 1) < 1e-12) return 0;
    if (r > 1) return Math.ceil(2048 * Math.log(r));
    return Math.ceil(Math.log(r) / Math.log(1 - 99 / 2048));
  }

  /* --- Emission ----------------------------------------------------------- */
  // Exact on-chain reward formula R = (21M - S) / 50,000,000 (planck-exact in
  // the runtime; float here is display-grade only).
  function currentRewardQtc(mintedPlancks) {
    return (MAX_SUPPLY_QTC * PLANCK - mintedPlancks) / EMISSION_DENOM / PLANCK;
  }

  /* --- Statistics / formatting ------------------------------------------- */

  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return NaN;
    if (p <= 0) return sortedAsc[0];
    if (p >= 1) return sortedAsc[sortedAsc.length - 1];
    var idx = (sortedAsc.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  function fmtDuration(sec) {
    if (!isFinite(sec)) return "never";
    if (sec < 0) return "0s";
    var s = Math.round(sec);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) parts.push(d + "d");
    if (h || d) parts.push(h + "h");
    if (m || h || d) parts.push(m + "m");
    parts.push(s + "s");
    return parts.join(" ");
  }

  var RATE_UNITS = [["H/s", 0], ["kH/s", 3], ["MH/s", 6], ["GH/s", 9], ["TH/s", 12], ["PH/s", 15], ["EH/s", 18]];
  function fmtHashrate(hs) {
    if (!(hs > 0)) return "0 H/s";
    if (!isFinite(hs)) return "∞ H/s";
    var exp = Math.floor(Math.log10(hs)), u = RATE_UNITS[0];
    for (var i = 0; i < RATE_UNITS.length; i++) if (exp >= RATE_UNITS[i][1]) u = RATE_UNITS[i];
    var v = hs / Math.pow(10, u[1]);
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + u[0];
  }

  function fmtQtc(x, digits) {
    if (!isFinite(x)) return "—";
    var d = digits === undefined ? 4 : digits;
    return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtPct(x, digits) {
    if (!isFinite(x)) return "—";
    return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  return {
    BLOCK_TARGET_MS: BLOCK_TARGET_MS,
    makeRng: makeRng,
    soloExpectedWaitSec: soloExpectedWaitSec,
    soloQuantileWaitSec: soloQuantileWaitSec,
    probAtLeastOneBlock: probAtLeastOneBlock,
    poissonPmf: poissonPmf,
    samplePoisson: samplePoisson,
    simulateSoloWaits: simulateSoloWaits,
    simulatePoolDailyEarnings: simulatePoolDailyEarnings,
    simulateSoloDailyEarnings: simulateSoloDailyEarnings,
    poolExpectedDailyQtc: poolExpectedDailyQtc,
    retargetCatchupBlocks: retargetCatchupBlocks,
    currentRewardQtc: currentRewardQtc,
    percentile: percentile,
    fmtDuration: fmtDuration,
    fmtHashrate: fmtHashrate,
    fmtQtc: fmtQtc,
    fmtPct: fmtPct
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LuckCore;
}
