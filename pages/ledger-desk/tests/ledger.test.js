// QTC Ledger Desk tests — run: node tests/run-tests.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const L = require("../ledger-core.js");
const SS58 = require("../../contact-vault/js/ss58.js");
const CHECK = require("../../contact-vault/js/checkphrase-core.js");
const WORDS = require("../../contact-vault/js/wordlist.js");
const VECTORS = require("../../contact-vault/tests/vectors/checksums.json");

let n = 0;
function t(name, fn) { n++; try { fn(); console.log("ok " + n + " - " + name); }
  catch (e) { console.error("FAIL " + n + " - " + name + ": " + e.message); process.exitCode = 1; } }

const D = (iso) => Date.parse(iso);
let seqId = 0;
function ev(o) {
  return Object.assign({ id: "e" + (++seqId), dateMs: D("2026-01-01T00:00:00Z"),
    type: "buy", address: "", qtyPlanck: 1n * L.PLANCK, priceMicro: null,
    feePlanck: 0n, note: "", source: "manual", ref: "", internal: false, flags: [] }, o);
}
const P = (usd) => L.parseUsdPerQtcToMicro(String(usd));
const noPrice = () => null;

// --- parsing / formatting ---
t("parseQtcToPlanck exact", () => {
  assert.equal(L.parseQtcToPlanck("1"), 1000000000000n);
  assert.equal(L.parseQtcToPlanck("0.01"), 10000000000n);
  assert.equal(L.parseQtcToPlanck("1,234.5"), 1234500000000000n);
  assert.equal(L.parseQtcToPlanck("0.000000000001"), 1n);
  assert.equal(L.parseQtcToPlanck("abc"), null);
  assert.equal(L.parseQtcToPlanck("1.1234567890123"), null); // >12 dp
});
t("formatQtc round-trip", () => {
  assert.equal(L.formatQtc(1234567890123n, 4), "1.2345");
  assert.equal(L.formatQtc(1000000000000n, 2), "1.00");
});
t("parseUsdPerQtcToMicro", () => {
  assert.equal(L.parseUsdPerQtcToMicro("12.50"), 12500000n);
  assert.equal(L.parseUsdPerQtcToMicro("$0.000001"), 1n);
  assert.equal(L.parseUsdPerQtcToMicro(""), null);
  assert.equal(L.parseUsdPerQtcToMicro("xyz"), null);
});
t("usdValueMicro exact", () => {
  // 2.5 QTC @ $4/QTC = $10.00
  assert.equal(L.usdValueMicro(2500000000000n, P(4)), 10000000n);
  // 1 planck @ $1e12/QTC = $1.00 exactly
  assert.equal(L.usdValueMicro(1n, P(1000000000000)), 1000000n);
});

// --- emission model ---
t("rewardModelPlancks anchors + quantizes", () => {
  const anchor = 320000000000n; // 0.32 QTC observed at 137536
  assert.equal(L.rewardModelPlancks(137536, 137536, anchor), 320000000000n);
  // one block later: 0.32 * (1 - 1/50M) still rounds to 0.32 QTC quantum
  assert.equal(L.rewardModelPlancks(137537, 137536, anchor), 320000000000n);
  // decay is monotonic decreasing over a long span
  const far = L.rewardModelPlancks(137536 + 50000000, 137536, anchor);
  assert.ok(far < anchor && far > 0n, "decays but stays positive");
  // backward: block 1 reward under the anchored exponential model.
  // 0.32 * (1-1/50M)^(1-137536) ≈ 0.3209 -> quantizes to 0.32 QTC.
  const b1 = L.rewardModelPlancks(1, 137536, anchor);
  assert.ok(b1 === 320000000000n, "block-1 model reward is 0.32 QTC, got " + b1);
});

// --- SS58 reuse: Kyle's donation address validates as prefix 189 ---
t("SS58 decode of known Quantus address", () => {
  const r = SS58.ss58Decode("qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau");
  assert.ok(r.ok, "decodes");
  assert.equal(r.prefix, 189);
});
t("checkphrase spot-check from upstream vectors", () => {
  const v = VECTORS.testCases[0];
  const words = CHECK.addressToChecksum(v.address, WORDS);
  assert.deepEqual(words, v.expected);
});

// --- FIFO known-answer ---
t("FIFO: buy 10@$1, buy 10@$2, sell 15@$5", () => {
  const evs = [
    ev({ type: "buy", dateMs: D("2026-01-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "buy", dateMs: D("2026-02-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "sell", dateMs: D("2026-03-01T00:00:00Z"), qtyPlanck: 15n * L.PLANCK, priceMicro: P(5) }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.matches.length, 2);
  // proceeds 15*5=75; basis 10*1+5*2=20; gain 55
  const gain = r.matches.reduce((a, m) => a + m.gainMicro, 0n);
  assert.equal(gain, 55000000n);
  // remaining: 5 QTC @ $2
  const rem = r.lots.filter((l) => l.qtyPlanck > 0n);
  assert.equal(rem.length, 1);
  assert.equal(rem[0].qtyPlanck, 5n * L.PLANCK);
  assert.equal(rem[0].unitCostMicro, P(2));
});
// --- LIFO known-answer ---
t("LIFO consumes newest first", () => {
  const evs = [
    ev({ type: "buy", dateMs: D("2026-01-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "buy", dateMs: D("2026-02-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "sell", dateMs: D("2026-03-01T00:00:00Z"), qtyPlanck: 15n * L.PLANCK, priceMicro: P(5) }),
  ];
  const r = L.runLedger(evs, "LIFO", noPrice);
  const gain = r.matches.reduce((a, m) => a + m.gainMicro, 0n);
  // basis 10*2+5*1=25; gain 75-25=50
  assert.equal(gain, 50000000n);
});
// --- HIFO known-answer ---
t("HIFO consumes highest basis first", () => {
  const evs = [
    ev({ type: "buy", dateMs: D("2026-01-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(3) }),
    ev({ type: "buy", dateMs: D("2026-02-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "sell", dateMs: D("2026-03-01T00:00:00Z"), qtyPlanck: 10n * L.PLANCK, priceMicro: P(5) }),
  ];
  const r = L.runLedger(evs, "HIFO", noPrice);
  const gain = r.matches.reduce((a, m) => a + m.gainMicro, 0n);
  // sells the $3 lot: gain 10*(5-3)=20
  assert.equal(gain, 20000000n);
});
// --- mining income + holding period ---
t("mining income creates lot at FMV; >365d = long-term", () => {
  const evs = [
    ev({ type: "mining_income", dateMs: D("2025-01-01T00:00:00Z"), qtyPlanck: 100n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "sell", dateMs: D("2026-06-01T00:00:00Z"), qtyPlanck: 100n * L.PLANCK, priceMicro: P(10) }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.income.length, 1);
  assert.equal(r.income[0].usdMicro, 200000000n); // $200
  assert.equal(r.matches[0].gainMicro, 800000000n); // $800
  assert.ok(r.matches[0].longTerm, "516 days held");
  assert.equal(r.matches[0].heldDays, 516);
});
t("short-term when held <= 365 days", () => {
  const evs = [
    ev({ type: "buy", dateMs: D("2026-01-01T00:00:00Z"), qtyPlanck: 5n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "sell", dateMs: D("2026-06-01T00:00:00Z"), qtyPlanck: 5n * L.PLANCK, priceMicro: P(3) }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.ok(!r.matches[0].longTerm);
});
// --- unpriced + shortfall errors ---
t("unpriced buy flagged, not silently zeroed", () => {
  const evs = [ev({ type: "buy", qtyPlanck: 5n * L.PLANCK, priceMicro: null })];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.ok(r.errors.some((e) => e.kind === "unpriced"));
  assert.ok(r.lots[0].basisUnknown);
});
t("disposal exceeding inventory is an error, not negative lots", () => {
  const evs = [ev({ type: "sell", qtyPlanck: 5n * L.PLANCK, priceMicro: P(1) })];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.ok(r.errors.some((e) => e.kind === "shortfall"));
  assert.ok(r.lots.every((l) => l.qtyPlanck >= 0n));
});
t("internal transfer is neither disposal nor acquisition", () => {
  const evs = [
    ev({ type: "buy", qtyPlanck: 5n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "transfer_out", qtyPlanck: 5n * L.PLANCK, priceMicro: P(9), internal: true }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.matches.length, 0);
  assert.equal(r.lots[0].qtyPlanck, 5n * L.PLANCK);
});
t("gift_out removes basis with no gain", () => {
  const evs = [
    ev({ type: "buy", qtyPlanck: 5n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "gift_out", qtyPlanck: 5n * L.PLANCK }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].gainMicro, 0n);
  assert.equal(r.lots[0].qtyPlanck, 0n);
});
// --- price-table fallback ---
t("price table lookup: latest entry on/before date", () => {
  const table = [
    { day: "2026-01-01", micro: P(1) },
    { day: "2026-06-01", micro: P(3) },
  ];
  const lookup = (ms) => {
    const k = L.dayKey(ms);
    let best = null;
    for (const r of table) if (r.day <= k) best = r.micro;
    return best;
  };
  assert.equal(lookup(D("2026-03-01T00:00:00Z")), P(1));
  assert.equal(lookup(D("2026-07-01T00:00:00Z")), P(3));
  assert.equal(lookup(D("2025-12-01T00:00:00Z")), null);
});
// --- tax year report ---
t("taxYearReport aggregates mining income + short/long gains", () => {
  const evs = [
    ev({ type: "mining_income", dateMs: D("2026-02-01T00:00:00Z"), qtyPlanck: 100n * L.PLANCK, priceMicro: P(2) }),
    ev({ type: "buy", dateMs: D("2024-01-01T00:00:00Z"), qtyPlanck: 50n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "sell", dateMs: D("2026-03-01T00:00:00Z"), qtyPlanck: 150n * L.PLANCK, priceMicro: P(10) }),
  ];
  const rep = L.taxYearReport(evs, "FIFO", noPrice, 2026);
  assert.equal(rep.mining.usd, 200000000n); // $200
  // FIFO: sells 50@$1 (long-term, from 2024) then 100@$2 (short-term, Feb 2026)
  assert.equal(rep.longTerm.gain, (10n - 1n) * 50n * L.MICRO);
  assert.equal(rep.shortTerm.gain, (10n - 2n) * 100n * L.MICRO);
  assert.equal(rep.inventory.qty, 0n);
});
// --- CSV round-trip ---
t("eventsToCsv escapes and parses back", () => {
  const e = ev({ type: "buy", note: 'pool "alpha", fee', priceMicro: P(1.5) });
  const csv = L.eventsToCsv([e]);
  const rows = L.parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][10], 'pool "alpha", fee');
  assert.equal(rows[1][5], "1.500000");
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nAll " + n + " tests passed.");
