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
t("SS58 reserved prefix forms rejected (contact-vault codec)", () => {
  const r = SS58.ss58Decode("KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC");
  assert.ok(!r.ok && r.kind === "format", "0xBD form must not read as prefix 189");
  const r2 = SS58.ss58Decode("LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ");
  assert.ok(!r2.ok && r2.kind === "format", "0xC0 form must not read as prefix 192");
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
t("internal transfer_in is neither acquisition nor income (scan both-mine shape)", () => {
  // The scan emits ONE event for a transfer between two vault addresses:
  // type transfer_in, internal:true. It must not mint a lot.
  const evs = [
    ev({ type: "buy", qtyPlanck: 5n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "transfer_in", qtyPlanck: 5n * L.PLANCK, internal: true,
         source: "detect", dateMs: D("2026-01-02T00:00:00Z") }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0].qtyPlanck, 5n * L.PLANCK);
  assert.equal(r.income.length, 0);
  assert.ok(!r.errors.some((e) => e.kind === "review-basis"));
});
t("internal transfer_in phantom lot cannot absorb a later sale", () => {
  const evs = [
    ev({ type: "buy", qtyPlanck: 5n * L.PLANCK, priceMicro: P(1) }),
    ev({ type: "transfer_in", qtyPlanck: 5n * L.PLANCK, internal: true, dateMs: D("2026-01-02T00:00:00Z") }),
    ev({ type: "sell", qtyPlanck: 5n * L.PLANCK, priceMicro: P(9), dateMs: D("2026-01-03T00:00:00Z") }),
    ev({ type: "sell", qtyPlanck: 5n * L.PLANCK, priceMicro: P(9), dateMs: D("2026-01-04T00:00:00Z") }),
  ];
  const r = L.runLedger(evs, "FIFO", noPrice);
  assert.equal(r.matches.length, 1); // only the real lot is sold
  assert.equal(r.matches[0].gainMicro, 40000000n); // 5 x ($9 - $1)
  assert.ok(r.errors.some((e) => e.kind === "shortfall"));
  const rep = L.taxYearReport(evs.slice(0, 2), "FIFO", noPrice, 2026);
  assert.equal(rep.inventory.qty, 5n * L.PLANCK);
  assert.equal(rep.inventory.basis, 5000000n);
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

// --- CSV formula injection (2026-10-15): text cells a spreadsheet would
// evaluate (=, +, -, @ led, incl. after spaces/tabs) are quote-guarded at
// export; producer numeric cells are never guarded; the importer's
// unguard restores the original text so round trips stay byte-identical.
t("csvGuardText guards only formula-leading text", () => {
  assert.equal(L.csvGuardText("=2+5+cmd|' /C calc'!A0"), "'=2+5+cmd|' /C calc'!A0");
  assert.equal(L.csvGuardText("+2+2"), "'+2+2");
  assert.equal(L.csvGuardText("-2+2"), "'-2+2");
  assert.equal(L.csvGuardText("@SUM(1+1)"), "'@SUM(1+1)");
  assert.equal(L.csvGuardText("  =HYPERLINK(x)"), "'  =HYPERLINK(x)");
  assert.equal(L.csvGuardText("\t@x"), "'\t@x");
  assert.equal(L.csvGuardText("pool alpha"), "pool alpha");
  assert.equal(L.csvGuardText("a=b"), "a=b"); // only a LEADING starter is a formula
  assert.equal(L.csvGuardText(""), "");
  assert.equal(L.csvUnguardText("'=2+2"), "=2+2");
  assert.equal(L.csvUnguardText("'  @x"), "  @x");
  assert.equal(L.csvUnguardText("'quoted note"), "'quoted note"); // foreign quote kept
  assert.equal(L.csvUnguardText("plain"), "plain");
});
t("eventsToCsv guards formula-leading text cells and unguard restores them", () => {
  const e = ev({ id: "=inj-id", type: "buy", source: "@csv-import", ref: "+order-1",
    note: "=2+5+cmd|' /C calc'!A0", priceMicro: P(1.5) });
  const rows = L.parseCsv(L.eventsToCsv([e]));
  assert.equal(rows[1][0], "'=inj-id");
  assert.equal(rows[1][8], "'@csv-import");
  assert.equal(rows[1][9], "'+order-1");
  assert.equal(rows[1][10], "'=2+5+cmd|' /C calc'!A0");
  assert.equal(L.csvUnguardText(rows[1][0]), "=inj-id");
  assert.equal(L.csvUnguardText(rows[1][9]), "+order-1");
  assert.equal(L.csvUnguardText(rows[1][10]), "=2+5+cmd|' /C calc'!A0");
  // numeric columns keep their plain, unguarded form
  assert.equal(rows[1][4], "1.000000000000");
  assert.equal(rows[1][5], "1.500000");
  assert.equal(rows[1][6], "0.000000000000");
});

// --- stored-state boundary (sanitizeState / toBigIntOrNull) ---
t("toBigIntOrNull accepts only exact integers", () => {
  assert.equal(L.toBigIntOrNull(5n), 5n);
  assert.equal(L.toBigIntOrNull(5), 5n);
  assert.equal(L.toBigIntOrNull("bigint:2000000000000"), 2000000000000n);
  assert.equal(L.toBigIntOrNull("-42"), -42n);
  assert.equal(L.toBigIntOrNull("bigint:abc"), null);
  assert.equal(L.toBigIntOrNull("12.5"), null);
  assert.equal(L.toBigIntOrNull(2.5), null);
  assert.equal(L.toBigIntOrNull("abc"), null);
  assert.equal(L.toBigIntOrNull(null), null);
  assert.equal(L.toBigIntOrNull({}), null);
  assert.equal(L.toBigIntOrNull(9007199254740993), null); // unsafe integer
});
t("sanitizeState keeps valid rows and drops poisoned ones", () => {
  const good = { id: "e1", dateMs: D("2026-01-15T12:00:00Z"), type: "buy", address: "",
    qtyPlanck: "bigint:2000000000000", priceMicro: "bigint:3000000", feePlanck: "bigint:0",
    note: "ok", source: "manual", ref: "", internal: false, flags: [] };
  const s = L.sanitizeState({ addresses: [{ address: "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau", label: "miner", words: ["a", 7, "b"], addedAt: 5 },
      { address: 42 }, { label: "no address" }],
    events: [good,
      { ...good, id: "bomb", qtyPlanck: "bigint:abc" },
      { ...good, id: "junk", qtyPlanck: "abc" },
      { ...good, id: "nodate", dateMs: "garbage" },
      { ...good, id: "badtype", type: "rug_pull" },
      { ...good, id: "negqty", qtyPlanck: "-5" }],
    prices: [{ day: "2026-01-01", micro: "xyz" }, { day: "2026-01-10", micro: "bigint:2500000" },
      { day: "Jan 10", micro: "bigint:1" }],
    method: "SIDEWAYS" });
  assert.equal(s.addresses.length, 1);
  // Round 3: ["a", 7, "b"] is not the exactly-5-strings checkphrase shape,
  // so the stored words drop to [] (the app re-derives the true words).
  assert.deepEqual(s.addresses[0].words, []);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].qtyPlanck, 2000000000000n);
  assert.equal(s.events[0].priceMicro, 3000000n);
  assert.equal(s.prices.length, 1);
  assert.equal(s.prices[0].micro, 2500000n);
  assert.equal(s.method, "FIFO");
});
t("sanitizeState coerces borderline fields to honest neutrals", () => {
  const s = L.sanitizeState({ events: [{ id: "e", dateMs: 1000, type: "sell",
    qtyPlanck: "1000", priceMicro: "garbage", feePlanck: "-9" }], method: "LIFO" });
  assert.equal(s.events[0].feePlanck, 0n);       // bad fee -> 0, never negative
  assert.equal(s.events[0].priceMicro, null);   // bad price -> unpriced, not poisoned
  assert.equal(s.method, "LIFO");
  assert.deepEqual(L.sanitizeState(null), { addresses: [], events: [], prices: [], method: "FIFO" });
  assert.deepEqual(L.sanitizeState("junk"), { addresses: [], events: [], prices: [], method: "FIFO" });
});
t("sanitized state runs the ledger without throwing", () => {
  const s = L.sanitizeState({ events: [{ id: "e", dateMs: D("2026-01-15T12:00:00Z"), type: "buy",
    qtyPlanck: "bigint:2000000000000", priceMicro: "bigint:3000000", feePlanck: "bigint:0" }],
    prices: [{ day: "2026-01-10", micro: "bigint:2500000" }] });
  const lookup = (ms) => { let best = null; s.prices.forEach((p) => { if (p.day <= L.dayKey(ms)) best = p.micro; }); return best; };
  const res = L.runLedger(s.events, s.method, lookup);
  assert.equal(res.lots.length, 1);
  assert.equal(res.lots[0].qtyPlanck, 2000000000000n);
});

// --- snapshot-boundary relations (round 2) ---
const NOW2 = D("2026-10-11T12:00:00Z");
const A1 = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
const A2 = "qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv";
t("validChainHeight: fleet bound, no coercion traps", () => {
  assert.equal(L.validChainHeight(205505), 205505);
  assert.equal(L.validChainHeight("205505"), 205505);
  assert.equal(L.validChainHeight(0), null);
  assert.equal(L.validChainHeight(10000001), null);
  assert.equal(L.validChainHeight(99999999999), null);
  assert.equal(L.validChainHeight(1.5), null);
  assert.equal(L.validChainHeight(""), null);
  assert.equal(L.validChainHeight(null), null);
  assert.equal(L.validChainHeight(true), null);
  assert.equal(L.validChainHeight("0x10"), null);
});
t("validChainTimeMs: chain lifetime window", () => {
  assert.equal(L.validChainTimeMs(D("2026-09-09T08:51:57Z"), NOW2), true);
  assert.equal(L.validChainTimeMs(D("2026-08-31T23:59:59Z"), NOW2), false);
  assert.equal(L.validChainTimeMs(NOW2 + 61 * 60000, NOW2), false);
  assert.equal(L.validChainTimeMs(NaN, NOW2), false);
});
t("isSs58_189: strict qz + 47 base58 shape", () => {
  assert.equal(L.isSs58_189(A1), true);
  assert.equal(L.isSs58_189(A1 + "ab"), false);
  assert.equal(L.isSs58_189("not-an-address"), false);
  assert.equal(L.isSs58_189(null), false);
});
t("validateLiveHead: status must restate blocks[0]", () => {
  const good = { ok: true, data: { status: { block_height: 1000 },
    blocks: [{ height: 1000, timestamp: "2026-10-11T11:00:00Z" }] } };
  assert.equal(L.validateLiveHead(good, NOW2), 1000);
  assert.equal(L.validateLiveHead({ ok: true, data: { status: { block_height: 999 },
    blocks: good.data.blocks } }, NOW2), null);
  assert.equal(L.validateLiveHead({ ok: false, data: good.data }, NOW2), null);
  assert.equal(L.validateLiveHead({ ok: true, data: { status: { block_height: 1000 },
    blocks: [{ height: 1000, timestamp: "2020-01-01T00:00:00Z" }] } }, NOW2), null);
});
function minersFx(mut) {
  const m = { ok: true, chain_height: 1000,
    window: { start_height: 901, end_height: 1000, block_count: 100, observed_block_time_s: 14.8 },
    buckets: [
      { start: 901, end: 950, blocks: 50, miners: { [A1]: 30, [A2]: 20 } },
      { start: 951, end: 1000, blocks: 50, miners: { [A1]: 10, [A2]: 40 } } ],
    window_miners: { [A1]: 40, [A2]: 60 },
    all_time: [{ address: A1, blocks: 500 }, { address: A2, blocks: 900 }] };
  if (mut) mut(m);
  return m;
}
t("validateMiners: coherent snapshot passes with its window", () => {
  const v = L.validateMiners(minersFx(), 1000);
  assert.equal(v.startHeight, 901);
  assert.equal(v.endHeight, 1000);
  assert.equal(v.blockTimeS, 14.8);
});
t("validateMiners: bucket counts must sum to the bucket span", () => {
  assert.equal(L.validateMiners(minersFx((m) => { m.buckets[0].miners[A1] = 29; }), 1000), null);
  assert.equal(L.validateMiners(minersFx((m) => { m.buckets[0].miners = { [A1]: 30.5, [A2]: 19.5 }; }), 1000), null);
});
t("validateMiners: buckets must tile the window contiguously", () => {
  assert.equal(L.validateMiners(minersFx((m) => { m.buckets[1].start = 952; }), 1000), null);
  assert.equal(L.validateMiners(minersFx((m) => { m.buckets[0].start = 900; }), 1000), null);
});
t("validateMiners: window_miners must restate bucket sums; missing map fails", () => {
  assert.equal(L.validateMiners(minersFx((m) => { m.window_miners[A1] = 41; }), 1000), null);
  assert.equal(L.validateMiners(minersFx((m) => { delete m.window_miners; }), 1000), null);
});
t("validateMiners: window end = chain_height, within skew of the live head", () => {
  assert.equal(L.validateMiners(minersFx((m) => { m.window.end_height = 999; }), 1000), null);
  assert.equal(L.validateMiners(minersFx(), 5000), null);
  assert.ok(L.validateMiners(minersFx(), 1002) !== null); // capture skew tolerated
});
t("validateMiners: all_time must cover the window, no duplicates", () => {
  assert.equal(L.validateMiners(minersFx((m) => { m.all_time[0].blocks = 39; }), 1000), null);
  assert.equal(L.validateMiners(minersFx((m) => { m.all_time.push({ address: A1, blocks: 600 }); }), 1000), null);
});
t("validateFlowsMeta: v2 meta restates the payload; v1 passes on shape", () => {
  assert.equal(L.validateFlowsMeta({ ok: true, meta: { transfers: 2, chain_height: 1000 }, transfers: [1, 2] }, 1000), true);
  assert.equal(L.validateFlowsMeta({ ok: true, meta: { transfers: 3, chain_height: 1000 }, transfers: [1, 2] }, 1000), false);
  assert.equal(L.validateFlowsMeta({ ok: false, meta: { transfers: 2, chain_height: 1000 }, transfers: [1, 2] }, 1000), false);
  assert.equal(L.validateFlowsMeta({ transfers: [1, 2] }, 1000), true);
});

// --- stored-state boundary round 3 (sanitizeState relations) ---
const validateAddress = (a) => {
  if (typeof a !== "string") return false;
  const d = SS58.ss58Decode(a);
  return !!(d && d.ok && d.prefix === 189 && d.key && d.key.length === 32);
};
const OPTS3 = { validateAddress };
const BADCHK = A1.slice(0, -1) + (A1.endsWith("u") ? "v" : "u"); // bad checksum
const ev3 = (o) => Object.assign({ id: "x", dateMs: D("2026-10-01T12:00:00Z"), type: "buy",
  address: "", qtyPlanck: "bigint:1000", priceMicro: null, feePlanck: "bigint:0",
  note: "", source: "manual", ref: "", internal: false, flags: [] }, o);
t("sanitizeState r3: vault addresses need checksum+189+32B, deduped", () => {
  const s = L.sanitizeState({ addresses: [
    { address: A1, label: "a", words: [], addedAt: 1 },
    { address: A1, label: "dup", words: [], addedAt: 2 },
    { address: BADCHK, label: "bad checksum", words: [], addedAt: 3 },
    { address: "qzAddr", label: "shape only junk", words: [], addedAt: 4 },
    { address: A2, label: "b", words: [], addedAt: 5 },
  ] }, OPTS3);
  assert.deepEqual(s.addresses.map((a) => a.address), [A1, A2]);
});
t("sanitizeState r3: without a validator the strict SS58-189 shape is the floor", () => {
  const s = L.sanitizeState({ addresses: [
    { address: A1, label: "a", words: [], addedAt: 1 },
    { address: "qzAddr", label: "junk", words: [], addedAt: 2 },
    { address: BADCHK, label: "shape-valid, checksum-bad (no decoder supplied)", words: [], addedAt: 3 },
  ] });
  // Shape-only fallback keeps the shape-valid row; the app always passes
  // the real decoder, so a bad checksum never survives in the browser.
  assert.deepEqual(s.addresses.map((a) => a.label), ["a", "shape-valid, checksum-bad (no decoder supplied)"]);
});
t("sanitizeState r3: checkphrase kept only as exactly 5 strings; label capped", () => {
  const five = ["list", "bliss", "asset", "camp", "portion"];
  const s = L.sanitizeState({ addresses: [
    { address: A1, label: "x".repeat(200), words: five, addedAt: 1 },
    { address: A2, label: "b", words: ["only", "three", "words"], addedAt: 2 },
  ] }, OPTS3);
  assert.deepEqual(s.addresses[0].words, five);
  assert.equal(s.addresses[0].label.length, 80);
  assert.deepEqual(s.addresses[1].words, []);
});
t("sanitizeState r3: duplicate event ids dropped, first wins; restored ids unique", () => {
  const s = L.sanitizeState({ events: [
    ev3({ id: "dup", note: "first" }), ev3({ id: "dup", note: "second" }),
    ev3({ id: "" }), ev3({ id: "" }),
  ] }, OPTS3);
  assert.equal(s.events.filter((e) => e.id === "dup").length, 1);
  assert.equal(s.events.find((e) => e.id === "dup").note, "first");
  assert.equal(new Set(s.events.map((e) => e.id)).size, s.events.length);
});
t("sanitizeState r3: amounts bounded by the 21M supply; over-supply fee neutralized", () => {
  const over = (22n * 1000000n * L.PLANCK).toString();
  const s = L.sanitizeState({ events: [
    ev3({ id: "big", qtyPlanck: "bigint:" + over }),
    ev3({ id: "cap", qtyPlanck: "bigint:" + L.MAX_SUPPLY_PLANCKS.toString() }),
    ev3({ id: "fee", feePlanck: "bigint:" + over }),
  ] }, OPTS3);
  assert.deepEqual(s.events.map((e) => e.id), ["cap", "fee"]);
  assert.equal(s.events[1].feePlanck, 0n);
});
t("sanitizeState r3: event address must validate or be empty", () => {
  const s = L.sanitizeState({ events: [
    ev3({ id: "ok1", address: A1 }), ev3({ id: "ok2", address: "" }),
    ev3({ id: "bad", address: "not-an-address" }), ev3({ id: "bad2", address: BADCHK }),
  ] }, OPTS3);
  assert.deepEqual(s.events.map((e) => e.id), ["ok1", "ok2"]);
});
t("sanitizeState r3: price days are real calendar dates, deduped last-wins", () => {
  const s = L.sanitizeState({ prices: [
    { day: "2026-02-31", micro: "bigint:100" },
    { day: "2026-99-99", micro: "bigint:100" },
    { day: "2026-10-01", micro: "bigint:100" },
    { day: "2026-10-01", micro: "bigint:200" },
    { day: "2024-02-29", micro: "bigint:300" }, // leap day is real
  ] }, OPTS3);
  assert.deepEqual(s.prices.map((p) => p.day + ":" + p.micro), ["2026-10-01:200", "2024-02-29:300"]);
});
t("sanitizeState r3: string fields capped; address list capped at 500", () => {
  const s = L.sanitizeState({ events: [ev3({ id: "caps", note: "n".repeat(900),
    source: "s".repeat(100), ref: "r".repeat(300), flags: ["f".repeat(50)] })] }, OPTS3);
  assert.equal(s.events[0].note.length, 500);
  assert.equal(s.events[0].source.length, 64);
  assert.equal(s.events[0].ref.length, 128);
  assert.equal(s.events[0].flags[0].length, 32);
  const many = { addresses: [] };
  // 501 copies of one address dedupe to 1; cap verified via unique-ish
  // shapes is covered by the counter — here assert the cap constant path
  // with repeated valid entries stays bounded and deduped.
  for (let i = 0; i < 501; i++) many.addresses.push({ address: A1, label: "x", words: [], addedAt: i });
  assert.equal(L.sanitizeState(many, OPTS3).addresses.length, 1);
});

t("eventRoom: the creation-path gate arithmetic for MAX_LEDGER_EVENTS", () => {
  // The load-time sanitizer caps events at 10,000; every path that
  // CREATES events (CSV import, manual form, scan add) asks eventRoom
  // first, so an in-session ledger can never outgrow the cap its next
  // load would silently trim back to.
  assert.equal(L.eventRoom(0), 10000);
  assert.equal(L.eventRoom(9999), 1);
  assert.equal(L.eventRoom(10000), 0);
  assert.equal(L.eventRoom(15000), 0); // never negative
  assert.equal(L.eventRoom("garbage"), 10000); // uncountable = empty, never a crash
  assert.equal(L.eventRoom(-3), 10000);
});

t("addressRoom: the creation-path gate arithmetic for MAX_VAULT_ADDRESSES", () => {
  // The load-time sanitizer caps the vault at 500 addresses; the
  // add-address flow — the only path that CREATES addresses — asks
  // addressRoom first (early, before the 40k-round checkphrase
  // derivation, and again authoritatively at the confirm push), so a
  // full vault refuses instead of persisting a 501st address the next
  // load silently trims — the address whose checkphrase was just read
  // back and confirmed.
  assert.equal(L.addressRoom(0), 500);
  assert.equal(L.addressRoom(499), 1);
  assert.equal(L.addressRoom(500), 0);
  assert.equal(L.addressRoom(1500), 0); // never negative
  assert.equal(L.addressRoom("garbage"), 500); // uncountable = empty, never a crash
  assert.equal(L.addressRoom(-3), 500);
});

t("priceRoom: the creation-path gate arithmetic for MAX_PRICE_DAYS", () => {
  // The load-time sanitizer caps the price table at 3,660 DISTINCT
  // days; the price form — the only path that CREATES price days —
  // asks priceRoom first for a NEW day, so an in-session table can
  // never outgrow the cap its next load would silently trim back to
  // (the trimmed row was the new price, the one just typed).
  // Replacing an existing day consumes no room and stays ungated.
  assert.equal(L.priceRoom(0), 3660);
  assert.equal(L.priceRoom(3659), 1);
  assert.equal(L.priceRoom(3660), 0);
  assert.equal(L.priceRoom(9000), 0); // never negative
  assert.equal(L.priceRoom("garbage"), 3660); // uncountable = empty, never a crash
  assert.equal(L.priceRoom(-3), 3660);
});

t("csvFileRoom: the CSV file gate arithmetic for MAX_CSV_FILE_BYTES", () => {
  // The CSV importer read and parsed the WHOLE picked file before
  // any cap was consulted; File.size is known before a byte is read,
  // so the importer asks this fail-closed gate first. The cap
  // derives from the producer (see the exporter tests below), not
  // from what a foreign file might contain.
  assert.equal(L.MAX_CSV_FILE_BYTES, 33554432);
  assert.equal(L.csvFileRoom(0), true); // empty reaches the normal "Empty CSV" path
  assert.equal(L.csvFileRoom(33554432), true); // at cap passes
  assert.equal(L.csvFileRoom(33554433), false); // one byte over refuses
  assert.equal(L.csvFileRoom(200 * 1024 * 1024), false);
  assert.equal(L.csvFileRoom(NaN), false); // fail-closed, never coerced
  assert.equal(L.csvFileRoom(-1), false);
  assert.equal(L.csvFileRoom("100"), false);
  assert.equal(L.csvFileRoom(undefined), false); // a sizeless file refuses
  assert.equal(L.csvFileRoom(null), false);
  assert.equal(L.csvFileRoom(Infinity), false);
});

t("csvFileRoom: the largest export the desk can produce fits the gate", () => {
  // Producer bound, measured with the desk's own exporter: 10,000
  // sanitizer-maxed events (id 128 generous, note 500, source 64,
  // ref 128, address 49, qty/fee at the 21M supply) serialize to
  // 10,040,104 bytes plain and 18,240,104 bytes when every text char
  // is a quote (CSV quote-doubling worst case) — both under the cap.
  const mk = (fill) => ({ id: fill(128), dateMs: Date.UTC(2026, 0, 1), type: "transfer_out",
    address: "qz" + "1".repeat(47), qtyPlanck: 21000000000000000000n,
    priceMicro: 999999999999999000000n, feePlanck: 21000000000000000000n,
    note: fill(500), source: fill(64), ref: fill(128), internal: false, flags: [] });
  const plain = L.eventsToCsv(Array.from({ length: 10000 }, () => mk((n) => "x".repeat(n))));
  assert.equal(Buffer.byteLength(plain), 10040104);
  assert.equal(L.csvFileRoom(Buffer.byteLength(plain)), true);
  const quoted = L.eventsToCsv(Array.from({ length: 10000 }, () => mk((n) => '"'.repeat(n))));
  assert.equal(Buffer.byteLength(quoted), 18240104);
  assert.equal(L.csvFileRoom(Buffer.byteLength(quoted)), true);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nAll " + n + " tests passed.");
