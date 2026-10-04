/* QTC Supply Audit — exact protocol math + audit computation (no DOM).
 * UMD: window.QTCAudit in the browser, module.exports under node (tests).
 *
 * Protocol math (verified Sept 30, 2026 against Quantus-Network/chain):
 *  - pallets/mining-rewards/src/lib.rs on_finalize:
 *      total_reward = (MaxSupply - (total_issuance + tx_fees)) / 50_000_000
 *      minted = (tx_fees + total_reward) rounded DOWN to the leaf quantum
 *  - runtime/src/configs/mod.rs: EmissionDivisor = 50_000_000
 *  - pallets/wormhole/src/lib.rs: SCALE_DOWN_FACTOR = 10_000_000_000
 *      => leaf quantum = 1e10 planck = 0.01 QTC
 *  - 1 QTC = 1e12 planck; 21M QTC cap.
 */
(function(root, factory){
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QTCAudit = factory();
})(typeof self !== "undefined" ? self : this, function(){
"use strict";

var PLANCK = 1000000000000n;
var MAX_SUPPLY = 21000000n * PLANCK;
var EMISSION_DIVISOR = 50000000n;
var LEAF_QUANTUM = 10000000000n;
var MINT_SENTINEL = "qzjUYyuN4L3HKmBPMxHvK2n8HYnaLZcQvLSQTgdwB2nQ1g2mc";
var ENDPOINT = "https://sqm.quantus.com/v1/graphql";

/* Exact decimal formatting from BigInt plancks. No floats touch the money. */
function fmtQtc(p, dec){
  dec = (dec === undefined) ? 4 : dec;
  var neg = p < 0n;
  if (neg) p = -p;
  var s = p.toString();
  while (s.length <= 12) s = "0" + s;
  var int = s.slice(0, s.length - 12), frac = s.slice(s.length - 12, s.length - 12 + dec);
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + int + "." + frac;
}
function fmtInt(n){
  return Number(n).toLocaleString("en-US");
}
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* Round down to the leaf quantum (the ZK-tree amount scale factor). */
function quantize(x){ return x - (x % LEAF_QUANTUM); }

/* Fee-free baseline recurrence: S <- S + Q((C - S) / D), iterated `height` times.
 * Returns { supply, samples } with [height, supply] checkpoints. */
function baseline(s0, height, step){
  var s = s0, samples = [[0, s]], i;
  for (i = 1; i <= height; i++){
    s += quantize((MAX_SUPPLY - s) / EMISSION_DIVISOR);
    if (step && i % step === 0) samples.push([i, s]);
  }
  samples.push([height, s]);
  return { supply: s, samples: samples };
}

/* Current per-block subsidy (fee-free) at supply s. */
function subsidyAt(s){
  return quantize((MAX_SUPPLY - s) / EMISSION_DIVISOR);
}

/* Full audit from a supply snapshot (data/supply.json shape).
 * All money stays BigInt. Returns every figure the UI renders. */
function computeAudit(d){
  var s0 = BigInt(d.genesis.total_plancks);
  var h = d.block_height;
  var base = baseline(s0, h, Math.max(1, Math.floor(h / 140)));
  var mined = BigInt(d.mined.total_plancks);
  var recorded = s0 + mined;
  var bal = BigInt(d.balances_plancks.free) + BigInt(d.balances_plancks.reserved) + BigInt(d.balances_plancks.frozen);
  var gap = bal - recorded;
  var baselineMined = base.supply - s0;
  var feeWedge = mined - baselineMined;
  var sentinelOut = BigInt(d.mint_sentinel.out_nongenesis_plancks);
  // Reconciliation remainder: sentinel outflows beyond the recorded rewards
  // (reward proofs double-booked + wormhole exit proofs) should explain the
  // balance gap; what is left over is honestly unattributed (burns, fee dust,
  // indexer noise). 258.32 QTC at height 139,888 (2026-09-30); 268.81 QTC at
  // 166,338 (2026-10-04) — computed live, never hard-coded in the UI again.
  var unattributed = (sentinelOut - mined) - gap;
  var vestTotal = BigInt(d.vesting.total_plancks);
  var vestClaimed = BigInt(d.vesting.claimed_plancks);
  var unclaimed = vestTotal - vestClaimed;
  var poolFree = d.vesting.pool_free_plancks != null ? BigInt(d.vesting.pool_free_plancks) : null;
  return {
    s0: s0, h: h, base: base, mined: mined, recorded: recorded, bal: bal, gap: gap,
    baselineMined: baselineMined, feeWedge: feeWedge, sentinelOut: sentinelOut,
    unattributed: unattributed,
    vestTotal: vestTotal, vestClaimed: vestClaimed, unclaimed: unclaimed, poolFree: poolFree,
    subsidy: subsidyAt(base.supply)
  };
}

return {
  PLANCK: PLANCK, MAX_SUPPLY: MAX_SUPPLY, EMISSION_DIVISOR: EMISSION_DIVISOR,
  LEAF_QUANTUM: LEAF_QUANTUM, MINT_SENTINEL: MINT_SENTINEL, ENDPOINT: ENDPOINT,
  fmtQtc: fmtQtc, fmtInt: fmtInt, esc: esc,
  quantize: quantize, baseline: baseline, subsidyAt: subsidyAt,
  computeAudit: computeAudit
};
});
