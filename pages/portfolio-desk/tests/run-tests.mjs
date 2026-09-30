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
                 total_plancks: "20000000000000", claimed_plancks: "0",
                 cliff_ms: "0", start_ms: "0", end_ms: String(Date.now() * 2) }]],
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
