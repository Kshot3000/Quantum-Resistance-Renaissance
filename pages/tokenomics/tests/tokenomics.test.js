/* QTC Tokenomics Explorer logic tests — node:test, no dependencies.
 * Run: node tests/tokenomics.test.js
 * Figures cross-checked against Quantus-Network/chain
 * (mainnet_vesting.rs, configs/mod.rs, pallets/wormhole tests) 2026-09-29. */
const t = require("node:test");
const assert = require("node:assert/strict");
const A = require("../app.js");

const B = {};
A.GENESIS_BUCKETS.forEach(b => { B[b.id] = b; });

t("allocation buckets sum to the verified genesis mint", () => {
  const sum = A.GENESIS_BUCKETS.reduce((a, b) => a + b.amount, 0);
  assert.equal(sum, 5670000);
  assert.equal(sum, A.CHAIN.GENESIS_MINT);
});

t("grants + intents equals the spreadsheet total 4,957,502", () => {
  assert.equal(B.grants.amount + B.intents.amount, 4957502);
  assert.equal(B.treasury.amount, 502438);
  assert.equal(B.liquidity.amount, 210000);
  assert.equal(B.seeds.amount, 60);
});

t("genesis mint + miner tail equals the 21M cap", () => {
  assert.equal(A.CHAIN.GENESIS_MINT + A.MINER_BUCKET.amount, 21000000);
  assert.equal(A.CHAIN.MAX_SUPPLY, 21000000);
});

t("vesting schedules match mainnet_vesting.rs", () => {
  assert.equal(B.liquidity.start, 0); assert.equal(B.liquidity.end, 16);
  assert.equal(B.intents.start, 0); assert.equal(B.intents.end, 365);
  assert.equal(B.grants.start, 365); assert.equal(B.grants.end, 1460); // 365 + 3*365
  assert.equal(B.treasury.start, 365); assert.equal(B.treasury.end, 1460);
});

t("seeds are liquid at TGE", () => {
  assert.equal(A.unlockedAt(B.seeds, 0), 60);
  assert.equal(A.unlockedAt(B.seeds, 5000), 60);
});

t("liquidity vests linearly over 16 days", () => {
  assert.equal(A.unlockedAt(B.liquidity, 0), 0);
  assert.equal(A.unlockedAt(B.liquidity, 8), 105000);
  assert.equal(A.unlockedAt(B.liquidity, 16), 210000);
  assert.equal(A.unlockedAt(B.liquidity, 400), 210000);
});

t("intents grant vests linearly over 365 days from TGE", () => {
  assert.equal(A.unlockedAt(B.intents, 0), 0);
  assert.equal(A.unlockedAt(B.intents, 182.5), 21000);
  assert.equal(A.unlockedAt(B.intents, 365), 42000);
  assert.equal(A.unlockedAt(B.intents, 2000), 42000);
});

t("grants cliff: nothing before day 365, linear to day 1460", () => {
  assert.equal(A.unlockedAt(B.grants, 0), 0);
  assert.equal(A.unlockedAt(B.grants, 364.9), 0);
  assert.equal(A.unlockedAt(B.grants, 365), 0);
  const after = A.unlockedAt(B.grants, 366);
  assert.ok(after > 0 && after < 5000, "day-366 unlock ≈ " + after);
  assert.equal(A.unlockedAt(B.grants, 1460), 4915502);
  assert.ok(Math.abs(A.unlockedAt(B.grants, (365 + 1460) / 2) - 4915502 / 2) < 1);
});

t("treasury remainder follows the grant clock", () => {
  assert.equal(A.unlockedAt(B.treasury, 100), 0);
  assert.equal(A.unlockedAt(B.treasury, 1460), 502438);
});

t("genesisUnlocked: day 0 = seeds only; day 20 ≈ 212,361; day 1460 = full", () => {
  assert.equal(A.genesisUnlocked(0), 60);
  const d20 = A.genesisUnlocked(20);
  assert.ok(Math.abs(d20 - (210000 + 42000 * 20 / 365 + 60)) < 1e-6, "got " + d20);
  assert.equal(A.genesisUnlocked(1460), 5670000);
});

t("emission: supply starts at 5.67M, reward = 0.3066 at genesis", () => {
  assert.equal(A.supplyAtBlocks(0), 5670000);
  assert.ok(Math.abs(A.blockRewardAtBlocks(0) - 15330000 / 50000000) < 1e-9);
  assert.ok(Math.abs(A.blockRewardAtBlocks(0) - 0.3066) < 1e-4);
});

t("emission decays: reward halves in ~13.2 years", () => {
  const halfDays = Math.log(2) * 50000000 / 7200;
  assert.ok(Math.abs(halfDays / 365.25 - 13.18) < 0.01, "half-life " + halfDays / 365.25 + "y");
  const r0 = A.rewardAtDays(0);
  const rh = A.rewardAtDays(halfDays);
  assert.ok(Math.abs(rh / r0 - 0.5) < 1e-6, "ratio " + rh / r0);
  assert.ok(A.blockRewardAtBlocks(7200 * 365) < A.blockRewardAtBlocks(0));
});

t("milestoneDay: ordered, sane, terminal cases", () => {
  const m10 = A.milestoneDay(10000000), m15 = A.milestoneDay(15000000), m20 = A.milestoneDay(20000000);
  assert.ok(m10 > 0 && m10 < m15 && m15 < m20, [m10, m15, m20].join(","));
  assert.equal(A.milestoneDay(5000000), 0);
  assert.equal(A.milestoneDay(21000000), -1);
  // 10M crossing lands in the 2030s under the model
  const y10 = new Date(A.CHAIN.TGE_MS + m10 * A.CHAIN.DAY_MS).getUTCFullYear();
  assert.ok(y10 >= 2031 && y10 <= 2040, "10M year " + y10);
});

t("wormhole fee: 1000 QTC exit splits 40q fee → burn 10 / miner 20 / agg 10", () => {
  const f = A.wormholeFee(1000);
  assert.equal(f.exitQ, 100000);
  assert.equal(f.feeQ, 40);       // 100000 * 4 / 10000 = 40 quanta = 0.40 QTC
  assert.equal(f.burnQ, 10);
  assert.equal(f.minerQ, 20);
  assert.equal(f.aggQ, 10);
  assert.equal(f.feeQ, f.burnQ + f.minerQ + f.aggQ);
});

t("wormhole fee: dust exits pay the 1-quantum minimum", () => {
  const f = A.wormholeFee(1);
  assert.equal(f.feeQ, 1);
  assert.equal(f.burnQ, 1);
  assert.equal(f.minerQ, 0);
  assert.equal(f.aggQ, 0);
  const tiny = A.wormholeFee(0.01);
  assert.equal(tiny.feeQ, 1);
});

t("wormhole fee conserves quanta across sizes", () => {
  [0.5, 25, 137.42, 1e6].forEach(v => {
    const f = A.wormholeFee(v);
    assert.equal(f.feeQ, f.burnQ + f.minerQ + f.aggQ, "v=" + v);
    assert.ok(f.feeQ >= 1);
  });
});

t("high-security fee is 1%, fully burned", () => {
  assert.equal(A.hsFee(1000), 10);
  assert.equal(A.hsFee(0.5), 0.005);
});

t("funding: $2.42M total; implied FDV per QTC", () => {
  const tot = A.FUNDING.reduce((a, r) => a + r.raised, 0);
  assert.equal(tot, 2420000);
  assert.equal(A.FUNDING[1].lead, "Balaji Srinivasan");
  assert.ok(Math.abs(40000000 / 21000000 - 1.9048) < 1e-3);
  assert.ok(Math.abs(100000000 / 21000000 - 4.7619) < 1e-3);
});

t("vestChartSVG: stacked polygons for all 5 buckets + locked cap", () => {
  const svg = A.vestChartSVG(3650, 10);
  assert.ok(svg.includes("<svg"));
  A.GENESIS_BUCKETS.forEach(b => assert.ok(svg.includes('data-bucket="' + b.id + '"'), b.id));
  assert.ok(svg.includes('data-bucket="locked"'));
  assert.ok(svg.includes("2030"));
});

t("emitChartSVG: milestone markers + 21M cap line", () => {
  const svg = A.emitChartSVG(30);
  assert.ok(svg.includes("<svg"));
  [10000000, 15000000, 20000000].forEach(m =>
    assert.ok(svg.includes('data-milestone="' + m + '"'), "ms " + m));
  assert.ok(svg.includes("21M cap"));
});

t("formatters", () => {
  assert.equal(A.fmtInt(5670000), "5,670,000");
  assert.equal(A.fmtInt(null), "—");
  assert.equal(A.fmtDate(Date.parse("2026-09-09T00:00:00Z")), "Sep 9, 2026");
});
