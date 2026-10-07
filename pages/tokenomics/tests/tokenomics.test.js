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
  const f = A.wormholeFee("1000");
  assert.equal(f.amountPlancks, 1000000000000000n);
  assert.equal(f.feeQuanta, 40n);       // 100000 quanta * 4 / 10000 = 40 quanta = 0.40 QTC
  assert.equal(f.burnQuanta, 10n);
  assert.equal(f.minerQuanta, 20n);
  assert.equal(f.aggQuanta, 10n);
  assert.equal(f.feeQuanta, f.burnQuanta + f.minerQuanta + f.aggQuanta);
});

t("wormhole fee: dust exits pay the 1-quantum minimum", () => {
  const f = A.wormholeFee("1");
  assert.equal(f.feeQuanta, 1n);
  assert.equal(f.burnQuanta, 1n);
  assert.equal(f.minerQuanta, 0n);
  assert.equal(f.aggQuanta, 0n);
  const tiny = A.wormholeFee("0.01");
  assert.equal(tiny.feeQuanta, 1n);
});

t("wormhole fee conserves quanta across sizes", () => {
  ["0.5", "25", "137.42", "1000000"].forEach(v => {
    const f = A.wormholeFee(v);
    assert.equal(f.feeQuanta, f.burnQuanta + f.minerQuanta + f.aggQuanta, "v=" + v);
    assert.ok(f.feeQuanta >= 1n);
  });
});

t("wormhole fee: sub-quantum amounts are NOT silently rounded up", () => {
  // Regression: the old float version ceiled the amount to whole quanta
  // before computing/displaying, so 25.004 QTC was shown as a 25.01 exit.
  const f = A.wormholeFee("25.004");
  assert.equal(f.amountPlancks, 25004000000000n);
  assert.equal(f.feeQuanta, 2n); // ceil(2500.4 quanta * 4 / 10000)
  assert.equal(A.fmtPlancksExact(f.amountPlancks), "25.004");
  const g = A.wormholeFee("2073.273");
  assert.equal(A.fmtPlancksExact(g.amountPlancks), "2,073.273");
});

t("wormhole fee matches the pallet fixed point on a 20k-quanta sweep", () => {
  // Pallet (net basis): fee = ceil(net * 4 / 9996) quanta for a gross exit
  // whose net = gross - fee decomposes exactly. Gross-basis formula used
  // here must agree wherever the gross amount is a whole number of quanta.
  for (let q = 1; q <= 20000; q++) {
    const f = A.wormholeFee((q / 100).toFixed(2));
    assert.equal(f.feeQuanta, BigInt(Math.ceil(q * 4 / 10000)), "q=" + q);
    assert.equal(f.feeQuanta, f.burnQuanta + f.minerQuanta + f.aggQuanta, "q=" + q);
  }
});

t("high-security fee is an exact Permill floor to the planck", () => {
  const a = A.hsFee("1000");
  assert.equal(a.feePlancks, 10000000000000n); // exactly 10 QTC
  assert.equal(a.netPlancks, a.amountPlancks - a.feePlancks);
  // 123.456 QTC: the float version rendered fee 1.23 / recipient 122.22 at
  // 2 dp and the row stopped adding up; exact fee is 1.23456 QTC.
  const b = A.hsFee("123.456");
  assert.equal(b.feePlancks, 1234560000000n);
  assert.equal(A.fmtPlancksExact(b.feePlancks), "1.23456");
  assert.equal(A.fmtPlancksExact(b.netPlancks), "122.22144");
  // Permill floors: 0.000000000001 QTC (1 planck) pays no fee; 199 plancks pay 1.
  assert.equal(A.hsFee("0.000000000001").feePlancks, 0n);
  assert.equal(A.hsFee("0.000000000199").feePlancks, 1n);
});

t("high-security rows always add up exactly", () => {
  for (let i = 1; i <= 5000; i++) {
    const s = (i * 1.6180339887 % 10000).toFixed(3);
    const f = A.hsFee(s);
    assert.equal(f.feePlancks + f.netPlancks, f.amountPlancks, "v=" + s);
    assert.equal(f.feePlancks, f.amountPlancks / 100n, "v=" + s);
  }
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
