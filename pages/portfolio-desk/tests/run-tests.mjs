#!/usr/bin/env node
/* QTC Portfolio Desk — logic tests (node:test). Run: node tests/run-tests.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const P = require(join(here, "..", "js", "desk-core.js"));
const U = 1000000000000n;

test("planck math round-trips", () => {
  assert.equal(P.parseQtcToPlancks("1"), U);
  assert.equal(P.parseQtcToPlancks("2.13"), 2130000000000n);
  assert.throws(() => P.parseQtcToPlancks("abc"));
  assert.throws(() => P.parseQtcToPlancks("1.1234567890123"));
  assert.equal(P.formatQtc(U), "1");
  assert.equal(P.formatQtc(2130000000000n), "2.13");
  assert.equal(P.formatQtc("5498465001000000000"), "5,498,465.001");
  assert.equal(P.formatQtc(0n), "0");
});

test("vestedPlancks: 0 before cliff, total after end, linear mid", () => {
  const s = { total_plancks: "1000000000000000", cliff_ms: "2000", start_ms: "1000", end_ms: "3000" };
  assert.equal(P.vestedPlancks(s, 500), 0n);                       // before cliff
  assert.equal(P.vestedPlancks(s, 2000), 500000000000000n);        // half elapsed (starts counting from start_ms)
  assert.equal(P.vestedPlancks(s, 9999), 1000000000000000n);       // after end
  assert.equal(P.vestedPlancks(s, 1999), 0n);                     // just before cliff
});

test("scheduleSummary splits claimable/locked correctly", () => {
  const s = { total_plancks: "1000000000000000", claimed_plancks: "100000000000000",
              cliff_ms: "2000", start_ms: "1000", end_ms: "3000", cohort: "grant", id: 3 };
  const sm = P.scheduleSummary(s, 2000);
  assert.equal(sm.vested, 500000000000000n);
  assert.equal(sm.claimable, 400000000000000n);   // vested - claimed
  assert.equal(sm.locked, 500000000000000n);      // total - vested
  assert.equal(sm.cohort, "grant");
  const done = P.scheduleSummary(s, 99999);
  assert.equal(done.locked, 0n);
  assert.equal(done.claimable, 900000000000000n);
});

test("rollupPortfolio aggregates balances, vesting, activity", () => {
  const addrA = "qzA", addrB = "qzB";
  const vault = P.blankVault();
  P.addToVault(vault, addrA, "Cold");
  P.addToVault(vault, addrB, "Hot");
  const ctx = {
    balances: new Map([
      [addrA, { free: "10000000000000", reserved: "0", frozen: "0" }],   // 10 QTC
      [addrB, { free: "5000000000000", reserved: "0", frozen: "0" }],    // 5 QTC
    ]),
    schedules: new Map([
      [addrA, [{ id: 0, beneficiary: addrA, cohort: "grant",
                 total_plancks: "200000000000000", claimed_plancks: "0",
                 cliff_ms: "1788912000000", start_ms: "1788912000000", end_ms: "1820448000000" }]],
    ]),
    byAddr: new Map([
      [addrA, { in: [{ id: "t1" }], out: [], count: 1, lastTs: "2026-09-30T00:00:00Z" }],
    ]),
    minedCounts: new Map([[addrB, 7]]),
  };
  const pf = P.rollupPortfolio(vault, ctx, Date.now());
  assert.equal(pf.totalFree, 15000000000000n);
  assert.equal(pf.rows.length, 2);
  assert.equal(pf.knownCount, 2);
  const a = pf.rows[0]; // insertion order preserved
  assert.equal(a.free, 10000000000000n);
  assert.ok(a.locked > 0n);                 // schedule still locking
  assert.equal(a.txCount, 1);
  const b = pf.rows[1];
  assert.equal(b.minedBlocks, 7);
  assert.equal(pf.totalMined, 7);
  assert.equal(pf.totalTx, 1);
  assert.equal(pf.withVesting, 1);
  assert.ok(pf.nextUnlockMs != null);
  // allocation sorted desc
  assert.ok(pf.allocation[0].controlled >= pf.allocation[1].controlled);
  // share of 21M cap: 15 QTC / 21M
  assert.ok(pf.shareOfCap > 0n);
});

test("rollupPortfolio handles unknown balances honestly", () => {
  const vault = P.blankVault();
  P.addToVault(vault, "qzUnknown", "Ghost");
  const pf = P.rollupPortfolio(vault, { balances: new Map(), schedules: new Map(),
                                        byAddr: new Map(), minedCounts: new Map() }, Date.now());
  assert.equal(pf.knownCount, 0);
  assert.equal(pf.totalControlled, 0n);
  assert.equal(pf.rows[0].balanceKnown, false);
});

test("portfolioActivity dedupes transfers seen by both sides", () => {
  const t = { id: "tx-1", amount: "1000000000000", from_id: "qzA", to_id: "qzB",
              block_height: 100, timestamp: "2026-09-30T00:00:00Z" };
  const byAddr = new Map();
  byAddr.set("qzA", { in: [], out: [t], count: 1, lastTs: t.timestamp });
  byAddr.set("qzB", { in: [t], out: [], count: 1, lastTs: t.timestamp });
  const acts = P.portfolioActivity(byAddr, ["qzA", "qzB"], 25);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].t.id, "tx-1");
});

test("vault add/remove/duplicate/import round-trips", () => {
  const vault = P.blankVault();
  P.addToVault(vault, "qzA", "Cold");
  assert.throws(() => P.addToVault(vault, "qzA", "Dup"), /already in the vault/);
  assert.equal(vault.addresses.length, 1);
  P.removeFromVault(vault, "qzA");
  assert.equal(vault.addresses.length, 0);
  const parsed = P.parseVaultJson(JSON.stringify({ version: 1, addresses: [{ address: "qzX", nick: "X", addedAt: 1 }] }));
  assert.equal(parsed.addresses[0].address, "qzX");
  assert.throws(() => P.parseVaultJson("{}"), /not a Portfolio Desk vault/);
});

test("validPlancks/nonNegInt accept only canonical non-negative integers", () => {
  assert.equal(P.validPlancks("0"), "0");
  assert.equal(P.validPlancks("007"), "7");
  assert.equal(P.validPlancks(42), "42");
  assert.equal(P.validPlancks(42n), "42");
  for (const bad of ["12.5", "-5", "abc", "", null, undefined, 1.5, -1, NaN, {}, [], "0x10", "1e3"])
    assert.equal(P.validPlancks(bad), null, "validPlancks(" + String(bad) + ")");
  assert.equal(P.nonNegInt("197034"), 197034);
  assert.equal(P.nonNegInt(0), 0);
  for (const bad of ["1.5", "-1", "abc", null, 2.5, "99999999999999999999"])
    assert.equal(P.nonNegInt(bad), null, "nonNegInt(" + String(bad) + ")");
  assert.equal(P.parseHeight("42"), 42);
  assert.equal(P.parseableTs("2026-09-30T00:00:00Z"), "2026-09-30T00:00:00Z");
  assert.equal(P.parseableTs("not a date"), null);
  assert.equal(P.parseableTs(null), null);
});

test("sanitizeBalance drops poisoned rows, defaults absent reserved/frozen to 0", () => {
  assert.deepEqual(P.sanitizeBalance({ free: "100", reserved: "2", frozen: "0" }), { free: "100", reserved: "2", frozen: "0" });
  assert.deepEqual(P.sanitizeBalance({ free: "100" }), { free: "100", reserved: "0", frozen: "0" });
  for (const bad of [null, "x", [], { free: "12.5" }, { free: "-5" }, { free: "abc" }, { reserved: "0" }, { free: "1", reserved: "x" }, { free: {} }])
    assert.equal(P.sanitizeBalance(bad), null);
});

test("sanitizeSchedule validates totals and the vesting window", () => {
  // Fixture windows use real chain-era millisecond instants (the round-2
  // relations require cliff/start/end inside the 2000..2100 shape).
  const W = { cliff_ms: "1820479917807", start_ms: "1820479917807", end_ms: "1915087917807" };
  const ok = P.sanitizeSchedule(Object.assign({}, W, { id: 3, cohort: "grant", total_plancks: "1000", claimed_plancks: "10" }));
  assert.equal(ok.total_plancks, "1000");
  assert.equal(ok.id, 3);
  const coerced = P.sanitizeSchedule(Object.assign({}, W, { id: "<b>9</b>", cohort: { x: 1 }, total_plancks: "5" }));
  assert.equal(coerced.id, null);            // markup-bearing id coerced away, never rendered raw
  assert.equal(coerced.cohort, "—");
  assert.equal(coerced.claimed_plancks, "0"); // absent claimed reads as 0
  for (const bad of [null, [], Object.assign({}, W, { total_plancks: "1.5" }),
                     Object.assign({}, W, { total_plancks: "5", cliff_ms: "x" }),
                     { total_plancks: "5", cliff_ms: "1820479917807", start_ms: "1915087917807", end_ms: "1820479917807" },
                     Object.assign({}, W, { total_plancks: "5", claimed_plancks: "-1" })])
    assert.equal(P.sanitizeSchedule(bad), null);
  const BEN = "qzo9ddk2km1qqAmXNiwo55vs5LNTU851mSQc8ufBwkQygHRBv";
  const byBen = P.sanitizeSchedules([
    Object.assign({}, W, { beneficiary: BEN, total_plancks: "5" }),
    Object.assign({}, W, { beneficiary: BEN, total_plancks: "bad" }),
    null,
    Object.assign({}, W, { total_plancks: "5" }),
    Object.assign({}, W, { beneficiary: 42, total_plancks: "5" }),
  ]);
  assert.equal(byBen.get(BEN).length, 1);
  assert.equal(byBen.size, 1);
});

test("sanitizeTransfers drops unrenderable rows and coerces garbage timestamps to null", () => {
  const FA = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7", FB = "qzo9ddk2km1qqAmXNiwo55vs5LNTU851mSQc8ufBwkQygHRBv";
  const rows = P.sanitizeTransfers([
    { id: "t1", amount: "100", from_id: FA, to_id: FB, block_height: 5, timestamp: "2026-09-30T00:00:00Z" },
    { id: "t2", amount: "12.5", from_id: FA, to_id: FB, block_height: 6, timestamp: null },
    { id: "t3", amount: "1", from_id: FA, to_id: FB, block_height: "NaN", timestamp: null },
    null,
    { amount: "7", from_id: FA, to_id: FB, block_height: "9", timestamp: "garbage" },
    { id: "t6", amount: "1", from_id: FA, block_height: 1, timestamp: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, "100");
  assert.equal(rows[1].id, null);              // id-less row survives with its own facts
  assert.equal(rows[1].timestamp, null);       // garbage ts is unknown, not a fake "just now"
  assert.equal(rows[1].block_height, 9);
});

test("sanitizeTopBalances and sanitizeMinedCounts reject garbage without NaN", () => {
  const MA = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7",
        MB = "qzo9ddk2km1qqAmXNiwo55vs5LNTU851mSQc8ufBwkQygHRBv",
        MC = "qzmzw3Bf2sPHaqSZJnUmNJAYiD5DZosZ4xw1kZduqGGKePTDk",
        MD = "qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv";
  const top = P.sanitizeTopBalances([
    { address: MA, free_plancks: "100", reserved_plancks: "0", frozen_plancks: "0" },
    { address: MB, free_plancks: "-5" },
    null,
    { free_plancks: "1" },
  ]);
  assert.equal(top.size, 1);
  assert.equal(top.get(MA).free, "100");
  const mined = P.sanitizeMinedCounts({ [MA]: 3, [MB]: "abc", [MC]: "4" }, [
    { address: MA, blocks: 10 }, { address: MD, blocks: "x" }, null, { blocks: 1 },
  ]);
  // Round 2: all_time already includes the window — MA is 10, never 3+10.
  assert.equal(mined.get(MA), 10);
  assert.equal(mined.has(MB), false);
  assert.equal(mined.get(MC), 4);
  assert.equal(mined.has(MD), false);
});

test("parseVaultJson drops poison entries and duplicates instead of throwing or double-counting", () => {
  const parsed = P.parseVaultJson(JSON.stringify({ version: 1, addresses: [
    { address: "qzA", nick: "Cold", addedAt: 5 },
    null,
    { nick: "no address" },
    { address: 42 },
    { address: " qzA ", nick: "duplicate with spaces" },
    { address: "qzB", nick: { evil: 1 }, addedAt: "garbage" },
  ] }));
  assert.equal(parsed.addresses.length, 2);
  assert.equal(parsed.addresses[0].address, "qzA");
  assert.equal(parsed.addresses[0].addedAt, 5);
  assert.equal(parsed.addresses[1].nick, "");
  assert.ok(parsed.addresses[1].addedAt > 0);
  assert.throws(() => P.parseVaultJson("{}"), /not a Portfolio Desk vault/);
  assert.throws(() => P.parseVaultJson('{"addresses":{}}'), /not a Portfolio Desk vault/);
});

test("rollupPortfolio survives poisoned ctx values (unknown, never a throw)", () => {
  const vault = P.blankVault();
  P.addToVault(vault, "qzA", "Cold");
  const ctx = {
    balances: new Map([["qzA", { free: "12.5", reserved: "0", frozen: "0" }]]),
    schedules: new Map([["qzA", [{ id: 0, total_plancks: "bad", cliff_ms: "1820479917807", start_ms: "1820479917807", end_ms: "1915087917807" },
                                  { id: 1, total_plancks: "2000000000000", claimed_plancks: "0", cliff_ms: "1820479917807", start_ms: "1820479917807", end_ms: "4102444799999" }]]]),
    byAddr: new Map([["qzA", { in: "not-an-array", out: [], count: 0, lastTs: null }]]),
    minedCounts: new Map([["qzA", "abc"]]),
  };
  const pf = P.rollupPortfolio(vault, ctx, Date.now());
  assert.equal(pf.rows[0].balanceKnown, false);   // fractional balance is unknown, not fabricated
  assert.equal(pf.rows[0].schedules.length, 1);  // only the valid schedule survives
  assert.equal(pf.rows[0].minedBlocks, 0);        // garbage count is 0, never NaN
  assert.equal(pf.totalMined, 0);
});

test("portfolioActivity keeps id-less rows and drops unrenderable ones", () => {
  const byAddr = new Map();
  const good = { amount: "100", from_id: "qzA", to_id: "qzB", block_height: 5, timestamp: null };
  const good2 = { amount: "200", from_id: "qzA", to_id: "qzC", block_height: 6, timestamp: null };
  const bad = { amount: "1.5", from_id: "qzA", to_id: "qzB", block_height: 7, timestamp: null };
  byAddr.set("qzA", { in: [], out: [good, good2, bad, null], count: 4, lastTs: null });
  const acts = P.portfolioActivity(byAddr, ["qzA"], 25);
  assert.equal(acts.length, 2);   // pre-fix: all id-less rows collapsed to one, and the bad row reached BigInt()
  assert.equal(acts[0].t.amount, "200");
});

test("round 2 relations: mined counts never double-count the window", () => {
  const MA = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7",
        MB = "qzo9ddk2km1qqAmXNiwo55vs5LNTU851mSQc8ufBwkQygHRBv";
  // Live-verified at head 207,818: the top miner's window count (10,532)
  // is already inside its all_time count (83,778); the desk painted 94,310.
  const m = P.sanitizeMinedCounts({ [MA]: 10532, [MB]: 7 }, [{ address: MA, blocks: 83778 }]);
  assert.equal(m.get(MA), 83778);
  assert.equal(m.get(MB), 7); // absent from all_time: window floor stands
  const dup = P.sanitizeMinedCounts({}, [{ address: MA, blocks: 100 }, { address: MA, blocks: 100 }]);
  assert.equal(dup.get(MA), 100); // a restated cumulative fact counts once
});

test("round 2 relations: caps, shapes, heights, timestamps, duplicate ids", () => {
  const FA = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7", FB = "qzo9ddk2km1qqAmXNiwo55vs5LNTU851mSQc8ufBwkQygHRBv";
  const CAP = "21000000000000000000";
  const row = (patch) => Object.assign({ id: "t1", amount: "1000000000000", from_id: FA, to_id: FB,
                                         block_height: 200000, timestamp: "2026-10-11T00:00:00.000Z" }, patch);
  assert.equal(P.sanitizeTransfers([row({})]).length, 1);
  assert.equal(P.sanitizeTransfers([row({ amount: "0" })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ amount: "22000000000000000000" })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ block_height: 0 })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ block_height: 99999999999 })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ from_id: "not-an-address" })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ timestamp: "2020-01-01T00:00:00.000Z" })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({ timestamp: "2999-01-01T00:00:00.000Z" })]).length, 0);
  assert.equal(P.sanitizeTransfers([row({}), row({})]).length, 1);
  assert.equal(P.sanitizeBalance({ free: "22000000000000000000" }), null);
  assert.equal(P.sanitizeBalance({ free: "20000000000000000000", reserved: "2000000000000000000" }), null);
  assert.ok(P.sanitizeBalance({ free: CAP }) !== null);
  const W = { cliff_ms: "1820479917807", start_ms: "1820479917807", end_ms: "1915087917807" };
  assert.equal(P.sanitizeSchedule(Object.assign({}, W, { total_plancks: "22000000000000000000", claimed_plancks: "0" })), null);
  assert.equal(P.sanitizeSchedule(Object.assign({}, W, { total_plancks: "1000", claimed_plancks: "1001" })), null);
  assert.equal(P.sanitizeSchedule(Object.assign({}, W, { total_plancks: "1000", claimed_plancks: "0", cliff_ms: "1915087917808" })), null);
  assert.equal(P.sanitizeSchedule(Object.assign({}, W, { total_plancks: "1000", claimed_plancks: "0", end_ms: "1" })), null);
});

test("csvExport produces a parseable holdings CSV", () => {
  const vault = P.blankVault();
  P.addToVault(vault, "qzA", "Cold");
  const ctx = { balances: new Map([["qzA", { free: "1000000000000", reserved: "0", frozen: "0" }]]),
                schedules: new Map(), byAddr: new Map(), minedCounts: new Map() };
  const pf = P.rollupPortfolio(vault, ctx, Date.now());
  const csv = P.csvExport(pf);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("nickname,address,free_qtc"));
  assert.ok(lines[1].includes("qzA"));
  assert.ok(lines[1].includes("1.000000"));
});
