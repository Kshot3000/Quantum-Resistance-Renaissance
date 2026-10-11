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

/* ---------------- payload boundary (fleet pattern) ----------------
 * Every field that crosses from the live indexer or data/supply.json is
 * validated by sanitizeSupply BEFORE it anchors a verdict figure, a
 * ledger row, or a genesis entry. A malformed CORE payload rejects
 * wholesale (throws): the caller reads that exactly like a failed load
 * — no figures rather than invented ones. Cross-checks that cost
 * nothing and catch the historically real failure modes:
 *  - the genesis total must equal the sum of its own transfer list
 *    (the 2026-09-30 pipeline once truncated that list to 3 rows);
 *  - no money total may exceed the 21M hard cap, and genesis + mined
 *    (the provable money stock) may not exceed it either;
 *  - vesting claimed may not exceed vesting total;
 *  - the mint-sentinel id must be the canonical MintingAccount;
 *  - addresses must be prefix-189 SS58 shape (qz + 47 base58 chars,
 *    as in Vesting Desk / Governance Tracker);
 *  - block_height is bounded (MAX_HEIGHT) so a poisoned height cannot
 *    make baseline() iterate effectively forever.
 * Round 2 (relations, not just shapes): reward_events == block_height
 * (one MinerRewarded per block); genesis flows only from the sentinel,
 * amount-descending, distinct recipients, covered by accounts_total;
 * fetched_at is a real capture time; the mined total fits the emission
 * schedule in aggregate; the vesting pool IS genesis row 0 (identity,
 * total, and free == received - claimed to the planck); sentinel
 * outflows cover the recorded rewards; and the payload's redundant
 * totals (total_supply_plancks, sentinel out_count/out_total) restate
 * their components exactly when present.
 */
var MAX_HEIGHT = 10000000;
var ADDR_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/;
var GENESIS_FLOOR_MS = Date.UTC(2026, 8, 1); // chain genesis: Sept 2026

function nonNegInt(v){
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^(0|[1-9]\d*)$/.test(v)){
    var n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}
/* Fleet block-height shape: strict integer 1..10,000,000 only —
 * "007", 2.5, 2e5, true and 9,007,199,254,740,991 all reject. */
function validBlockHeight(v){
  var n = nonNegInt(v);
  return (n !== null && n >= 1 && n <= MAX_HEIGHT) ? n : null;
}
/* A fetched_at must be a real capture time: at/after the genesis
 * floor and at most an hour ahead of now (clock-skew slack). */
function validFetchedAt(v, nowMs){
  if (typeof v !== "string") return null;
  var ms = Date.parse(v);
  if (!isFinite(ms)) return null;
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : Date.now();
  return (ms >= GENESIS_FLOOR_MS && ms <= now + 3600000) ? ms : null;
}
function validPlancks(v){
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return v.replace(/^0+(?=\d)/, "");
  return null;
}
function validAddress(v){
  return typeof v === "string" && ADDR_RE.test(v) ? v : null;
}
function malformed(field){
  throw new Error("malformed supply payload: " + field);
}
function planckField(v, field){
  var p = validPlancks(v);
  if (p === null) malformed(field);
  if (BigInt(p) > MAX_SUPPLY) malformed(field + " exceeds the 21M cap");
  return p;
}
function countField(v, field, min){
  var n = nonNegInt(v);
  if (n === null || n < min) malformed(field);
  return n;
}
function sanitizeSupply(d, nowMs){
  if (!d || typeof d !== "object" || Array.isArray(d)) malformed("payload is not an object");
  if (d.ok !== true) malformed("ok flag");
  /* Round 2: the capture time itself is a relation — a pre-genesis or
   * future fetched_at is not a snapshot of this chain. */
  if (validFetchedAt(d.fetched_at, nowMs) === null) malformed("fetched_at is not a real capture time");
  var h = validBlockHeight(d.block_height);
  if (h === null) malformed("block_height");
  var accounts = countField(d.accounts_total, "accounts_total", 1);
  if (d.mint_sentinel_id !== MINT_SENTINEL) malformed("mint_sentinel_id is not the canonical minting account");

  var g = d.genesis;
  if (!g || typeof g !== "object" || Array.isArray(g)) malformed("genesis");
  if (!Array.isArray(g.transfers) || g.transfers.length < 1 || g.transfers.length > 100) malformed("genesis.transfers");
  var gCount = countField(g.count, "genesis.count", 1);
  if (gCount !== g.transfers.length) malformed("genesis.count != transfers length");
  /* Every genesis recipient holds an account on the chain the same
   * payload counts — a smaller accounts_total describes a different
   * (or truncated) chain state. */
  if (accounts < g.transfers.length) malformed("accounts_total < genesis recipients");
  var gTotal = planckField(g.total_plancks, "genesis.total_plancks");
  var sum = 0n, transfers = [], seenTo = {}, prevAmt = null;
  g.transfers.forEach(function(t, i){
    if (!t || typeof t !== "object" || Array.isArray(t)) malformed("genesis.transfers[" + i + "]");
    var amt = planckField(t.amount_plancks, "genesis.transfers[" + i + "].amount_plancks");
    if (BigInt(amt) <= 0n) malformed("genesis.transfers[" + i + "].amount_plancks is not positive");
    var from = validAddress(t.from), to = validAddress(t.to);
    if (from === null || to === null) malformed("genesis.transfers[" + i + "] address");
    /* Genesis relations: the block-1 allocation flows OUT of the
     * minting account only (the fetcher selects block_height = 1 and
     * live data shows a single sender), the list runs amount-descending
     * as queried (order_by amount desc — row 0 IS the vesting pool,
     * which the pool identity below and the UI both rely on), and no
     * recipient appears twice. */
    if (from !== MINT_SENTINEL) malformed("genesis.transfers[" + i + "] is not from the mint sentinel");
    if (to === from) malformed("genesis.transfers[" + i + "] is a self-transfer");
    if (seenTo[to]) malformed("genesis.transfers[" + i + "] duplicates a genesis recipient");
    seenTo[to] = true;
    if (prevAmt !== null && BigInt(amt) > prevAmt) malformed("genesis.transfers is not amount-descending");
    prevAmt = BigInt(amt);
    sum += BigInt(amt);
    transfers.push({ amount_plancks: amt, from: from, to: to });
  });
  if (sum !== BigInt(gTotal)) malformed("genesis.total_plancks != sum of its transfers");

  var m = d.mined;
  if (!m || typeof m !== "object" || Array.isArray(m)) malformed("mined");
  var rewardEvents = countField(m.reward_events, "mined.reward_events", 1);
  var minedTotal = planckField(m.total_plancks, "mined.total_plancks");
  if (BigInt(minedTotal) <= 0n) malformed("mined.total_plancks is not positive");
  if (BigInt(gTotal) + BigInt(minedTotal) > MAX_SUPPLY) malformed("genesis + mined exceeds the 21M cap");
  /* One MinerRewarded event per block, genesis included — the count
   * and the height are two aggregates over the same chain in the same
   * query and agree exactly in live data (verified at heights 202,509
   * and 203,246). */
  if (rewardEvents !== h) malformed("mined.reward_events != block_height");
  /* The mined total must fit the emission schedule in aggregate.
   * Floor is definitional: every block mints at least the fee-free
   * subsidy at that height, the subsidy only falls as supply grows,
   * and fees only add — so total >= events x subsidyAt(recorded).
   * Ceiling is a labeled sanity bound: events x (the genesis subsidy
   * + 0.5 QTC of fee slack per block; the largest observed per-block
   * total is ~0.37 QTC against a ~0.305 schedule). */
  var minedFloor = BigInt(rewardEvents) * subsidyAt(BigInt(gTotal) + BigInt(minedTotal));
  if (BigInt(minedTotal) < minedFloor) malformed("mined.total_plancks below the schedule floor for its event count");
  var minedCeil = BigInt(rewardEvents) * (subsidyAt(BigInt(gTotal)) + 500000000000n);
  if (BigInt(minedTotal) > minedCeil) malformed("mined.total_plancks above the schedule sanity ceiling for its event count");

  var b = d.balances_plancks;
  if (!b || typeof b !== "object" || Array.isArray(b)) malformed("balances_plancks");
  var free = planckField(b.free, "balances_plancks.free");
  var reserved = planckField(b.reserved, "balances_plancks.reserved");
  var frozen = planckField(b.frozen, "balances_plancks.frozen");
  var balTotal = BigInt(free) + BigInt(reserved) + BigInt(frozen);
  if (balTotal <= 0n) malformed("balances_plancks total is not positive");
  if (balTotal > MAX_SUPPLY) malformed("balances_plancks total exceeds the 21M cap");
  /* The snapshot's redundant total (fetch-supply-data.mjs and the live
   * builder both restate the component sum) must agree exactly when
   * present — a second copy of one number from the same query. */
  if (d.total_supply_plancks !== null && d.total_supply_plancks !== undefined){
    var statedTotal = planckField(d.total_supply_plancks, "total_supply_plancks");
    if (BigInt(statedTotal) !== balTotal) malformed("total_supply_plancks != free+reserved+frozen");
  }

  var v = d.vesting;
  if (!v || typeof v !== "object" || Array.isArray(v)) malformed("vesting");
  var schedules = countField(v.schedules, "vesting.schedules", 0);
  var vestTotal = planckField(v.total_plancks, "vesting.total_plancks");
  var vestClaimed = planckField(v.claimed_plancks, "vesting.claimed_plancks");
  if (BigInt(vestClaimed) > BigInt(vestTotal)) malformed("vesting.claimed_plancks exceeds vesting.total_plancks");
  if (BigInt(vestTotal) > 0n && schedules < 1) malformed("vesting.total_plancks is positive with zero schedules");
  /* Pool identity: the vesting pool is the recipient of the largest
   * block-1 transfer, schedules are carved out of what it received,
   * and its free balance is exactly what it received minus what has
   * been claimed (verified to the planck in live data at 203,246:
   * pool_free == genesis[0] - claimed). */
  var poolAmount = BigInt(transfers[0].amount_plancks);
  if (BigInt(vestTotal) > poolAmount) malformed("vesting.total_plancks exceeds the genesis pool allocation");
  var poolAccount = (v.pool_account === null || v.pool_account === undefined) ? null : validAddress(v.pool_account);
  if (v.pool_account !== null && v.pool_account !== undefined && poolAccount === null) malformed("vesting.pool_account");
  if (poolAccount !== null && poolAccount !== transfers[0].to) malformed("vesting.pool_account is not the genesis pool recipient");
  var poolFree = (v.pool_free_plancks === null || v.pool_free_plancks === undefined)
    ? null : planckField(v.pool_free_plancks, "vesting.pool_free_plancks");
  if (poolFree !== null && BigInt(poolFree) !== poolAmount - BigInt(vestClaimed))
    malformed("vesting.pool_free_plancks != genesis pool allocation - claimed");

  var ms = d.mint_sentinel;
  if (!ms || typeof ms !== "object" || Array.isArray(ms)) malformed("mint_sentinel");
  var sentinelFree = planckField(ms.free_plancks, "mint_sentinel.free_plancks");
  var sentinelOutCount = countField(ms.out_nongenesis_count, "mint_sentinel.out_nongenesis_count", 0);
  var sentinelOut = planckField(ms.out_nongenesis_plancks, "mint_sentinel.out_nongenesis_plancks");
  /* Every recorded reward is paid out of the sentinel (reward proofs),
   * so its non-genesis outflows cover the recorded rewards in total
   * and — at least one transfer per reward — in count. */
  if (BigInt(sentinelOut) < BigInt(minedTotal)) malformed("mint_sentinel outflows below the recorded rewards");
  if (sentinelOutCount < rewardEvents) malformed("mint_sentinel outflow count below the reward event count");
  /* The snapshot's all-time sentinel totals restate genesis +
   * non-genesis exactly when present (fetcher aggregates). */
  if (ms.out_count !== null && ms.out_count !== undefined){
    var outCount = countField(ms.out_count, "mint_sentinel.out_count", 0);
    if (outCount !== sentinelOutCount + gCount) malformed("mint_sentinel.out_count != nongenesis count + genesis count");
  }
  if (ms.out_total_plancks !== null && ms.out_total_plancks !== undefined){
    var outTotal = planckField(ms.out_total_plancks, "mint_sentinel.out_total_plancks");
    if (BigInt(outTotal) !== BigInt(sentinelOut) + BigInt(gTotal)) malformed("mint_sentinel.out_total_plancks != nongenesis + genesis totals");
  }

  return {
    ok: true, source: typeof d.source === "string" ? d.source : ENDPOINT,
    fetched_at: d.fetched_at, live: d.live === true,
    block_height: h, accounts_total: accounts, mint_sentinel_id: MINT_SENTINEL,
    genesis: { count: gCount, total_plancks: gTotal, transfers: transfers },
    mined: { reward_events: rewardEvents, total_plancks: minedTotal },
    balances_plancks: { free: free, reserved: reserved, frozen: frozen },
    total_supply_plancks: balTotal.toString(),
    vesting: { schedules: schedules, total_plancks: vestTotal, claimed_plancks: vestClaimed,
      pool_account: poolAccount, pool_free_plancks: poolFree },
    mint_sentinel: { free_plancks: sentinelFree,
      out_nongenesis_count: sentinelOutCount, out_nongenesis_plancks: sentinelOut }
  };
}

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
function computeAudit(raw){
  var d = sanitizeSupply(raw);
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
  nonNegInt: nonNegInt, validPlancks: validPlancks, validAddress: validAddress,
  validBlockHeight: validBlockHeight, validFetchedAt: validFetchedAt,
  sanitizeSupply: sanitizeSupply, computeAudit: computeAudit
};
});
