/* Quantum Shield logic tests — node:test, no dependencies.
 * Run: node tests/shield.test.js */
const t = require("node:test");
const assert = require("node:assert/strict");
const A = require("../app.js");

t("parameter table matches FIPS 204", () => {
  assert.equal(A.PARAMS["44"].sig, 2420);
  assert.equal(A.PARAMS["44"].pk, 1312);
  assert.equal(A.PARAMS["44"].cat, 2);
  assert.equal(A.PARAMS["65"].sig, 3309);
  assert.equal(A.PARAMS["65"].pk, 1952);
  assert.equal(A.PARAMS["65"].cat, 3);
  assert.equal(A.PARAMS["87"].sig, 4627);
  assert.equal(A.PARAMS["87"].pk, 2592);
  assert.equal(A.PARAMS["87"].cat, 5);
  assert.equal(A.ECDSA_SIG, 65);
});

t("fmtBytes", () => {
  assert.equal(A.fmtBytes(65), "65 B");
  assert.equal(A.fmtBytes(2420), "2.4 KB");
  assert.equal(A.fmtBytes(4627), "4.5 KB");
  assert.equal(A.fmtBytes(0), "0 B");
  assert.equal(A.fmtBytes(null), "—");
  assert.equal(A.fmtBytes(-5), "—");
});

t("ecdsaFit floors against 65 bytes", () => {
  assert.equal(A.ecdsaFit(4627), 71);      // 4627/65 = 71.18…
  assert.equal(A.ecdsaFit(3309), 50);      // 3309/65 = 50.9…
  assert.equal(A.ecdsaFit(2420), 37);      // 2420/65 = 37.2…
  assert.equal(A.ecdsaFit(65), 1);
  assert.equal(A.ecdsaFit(64), 0);
  assert.equal(A.ecdsaFit(0), 0);
});

t("barPct scales against ML-DSA-87 max", () => {
  assert.equal(A.barPct(4627), 100);
  assert.ok(A.barPct(65) < 2 && A.barPct(65) > 1);   // 65/4627 ≈ 1.4%
  assert.ok(A.barPct(2420) > 52 && A.barPct(2420) < 53); // ≈ 52.3%
  assert.equal(A.barPct(0), 0);
  assert.equal(A.barPct(99999), 100);     // clamped
});

t("packBlocks uses design packing figures", () => {
  assert.equal(A.packBlocks(5000, A.PER_BLOCK.aggregated), 1);
  assert.equal(A.packBlocks(5000, A.PER_BLOCK.transparent), 10);
  assert.equal(A.packBlocks(5200, A.PER_BLOCK.aggregated), 1);
  assert.equal(A.packBlocks(5201, A.PER_BLOCK.aggregated), 2);
  assert.equal(A.packBlocks(510, A.PER_BLOCK.transparent), 1);
  assert.equal(A.packBlocks(0, 510), 0);
  assert.equal(A.packBlocks(100, 0), 0);
});

t("blocksToHuman with 12s blocks", () => {
  assert.equal(A.blocksToHuman(1), "~12 s");
  assert.equal(A.blocksToHuman(10), "~2 min");
  assert.equal(A.blocksToHuman(0), "~0 s");
  assert.ok(A.blocksToHuman(400).includes("h"));  // 400*12s = 80 min
});

t("ratioText", () => {
  assert.equal(A.ratioText(4627), "about 71.2\u00D7 larger");
  assert.equal(A.ratioText(65), "about 1\u00D7 larger");
});

t("exposure verdicts cover all four archetypes", () => {
  for (const k of ["spent", "taproot", "fresh", "mldsa"]) {
    const e = A.exposureInfo(k);
    assert.ok(e && e.verdict && e.why && e.fix, k);
    assert.ok(/^risk-(high|low|none)$/.test(e.risk), k);
  }
  assert.equal(A.exposureInfo("spent").risk, "risk-high");
  assert.equal(A.exposureInfo("mldsa").risk, "risk-none");
  assert.equal(A.exposureInfo("bogus"), null);
});
