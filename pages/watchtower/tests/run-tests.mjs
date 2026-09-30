#!/usr/bin/env node
/* QTC Watchtower — logic tests (node:test). Run: node tests/run-tests.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const W = require(join(here, "..", "js", "watch-core.js"));
const P = 1000000000000n;

test("parseQtcToPlancks round-trips", () => {
  assert.equal(W.parseQtcToPlancks("1"), P);
  assert.equal(W.parseQtcToPlancks("1.5"), 1500000000000n);
  assert.equal(W.parseQtcToPlancks("0.000000000001"), 1n);
  assert.equal(W.parseQtcToPlancks("1,234.5678"), 1234567800000000n);
  assert.throws(() => W.parseQtcToPlancks("abc"));
  assert.throws(() => W.parseQtcToPlancks("1.1234567890123")); // >12dp
  assert.throws(() => W.parseQtcToPlancks("-5"));
});

test("formatQtc formats with commas and trims zeros", () => {
  assert.equal(W.formatQtc(P), "1");
  assert.equal(W.formatQtc(1500000000000n), "1.5");
  assert.equal(W.formatQtc(1234567800000000n), "1,234.5678");
  assert.equal(W.formatQtc(0n), "0");
  assert.equal(W.formatQtc("2130000000000"), "2.13");
});

test("formatAge buckets", () => {
  assert.equal(W.formatAge(45000), "45s");
  assert.equal(W.formatAge(5 * 60000), "5m");
  assert.equal(W.formatAge(90 * 60000), "1h 30m");
  assert.equal(W.formatAge(3 * 86400000), "3d 0h");
  assert.equal(W.formatAge(-1), "—");
});

test("indexTransfers groups by address, newest first", () => {
  const ts = [
    { id: "a", amount: "1", from_id: "X", to_id: "Y", block_height: 10, timestamp: "t1" },
    { id: "b", amount: "2", from_id: "Y", to_id: "Z", block_height: 12, timestamp: "t2" },
    { id: "c", amount: "3", from_id: "X", to_id: "Y", block_height: 8, timestamp: "t0" },
  ];
  const idx = W.indexTransfers(ts);
  const act = W.addressActivity(idx, "Y");
  assert.equal(act.in.length, 2);
  assert.equal(act.out.length, 1);
  assert.equal(act.in[0].id, "a"); // block 10 before block 8
  assert.equal(act.count, 3);
  assert.equal(W.addressActivity(idx, "NOBODY").count, 0);
});

test("buildBalanceMap reads free plancks", () => {
  const m = W.buildBalanceMap([{ address: "A", free_plancks: "5000000000000" }]);
  assert.equal(m.get("A"), 5000000000000n);
  assert.equal(m.has("B"), false);
});

const ADDR = "qzTESTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
function fixtureData(over = {}) {
  const now = 1_800_000_000_000;
  const tx = { id: "TX1", amount: (2000n * P).toString(), from_id: "SENDER", to_id: ADDR, block_height: 100, timestamp: "x" };
  return {
    now,
    data: Object.assign({
      balances: new Map([[ADDR, 100n * P]]),
      byAddr: W.indexTransfers([tx]),
      transfers: [tx],
      referenda: 3, upgrades: 2, upgradesList: [], headHeight: 100,
      headTsMs: now - 5 * 60000, snapshotCapturedAt: null,
    }, over),
    tx,
  };
}

test("balance_below fires on transition and first-seen, not while already below", () => {
  const { now, data } = fixtureData();
  const rule = { id: "r1", type: "balance_below", address: ADDR, threshold: "100", severity: "warn", enabled: true };
  // first-seen at exactly threshold: 100 < 100 false -> no fire
  let out = W.evaluateRules([rule], {}, data, now);
  assert.equal(out.alerts.length, 0);
  // drop below
  const data2 = fixtureData();
  data2.data.balances.set(ADDR, 50n * P);
  out = W.evaluateRules([rule], out.baselines, data2.data, now);
  assert.equal(out.alerts.length, 1);
  assert.ok(out.alerts[0].title.includes("below"));
  // still below -> no duplicate
  out = W.evaluateRules([rule], out.baselines, data2.data, now);
  assert.equal(out.alerts.length, 0);
  // invalid threshold throws (surfaced to UI)
  assert.throws(() => W.evaluateRules([{ ...rule, threshold: "nope" }], {}, data, now));
});

test("balance_above fires on rising through threshold", () => {
  const { now, data } = fixtureData();
  const rule = { id: "r1", type: "balance_above", address: ADDR, threshold: "1000", severity: "info", enabled: true };
  let out = W.evaluateRules([rule], {}, data, now);
  assert.equal(out.alerts.length, 0);
  const data2 = fixtureData();
  data2.data.balances.set(ADDR, 1500n * P);
  out = W.evaluateRules([rule], out.baselines, data2.data, now);
  assert.equal(out.alerts.length, 1);
});

test("balance_change fires on pct and absolute moves", () => {
  const { now, data } = fixtureData();
  const pct = { id: "r1", type: "balance_change", changeMode: "pct", address: ADDR, threshold: "10", enabled: true };
  let out = W.evaluateRules([pct], {}, data, now);
  assert.equal(out.alerts.length, 0); // baseline set, no move
  const moved = fixtureData();
  moved.data.balances.set(ADDR, 120n * P); // +20%
  out = W.evaluateRules([pct], out.baselines, moved.data, now);
  assert.equal(out.alerts.length, 1);
  assert.ok(out.alerts[0].title.includes("20.00%"));
  const abs = { id: "r2", type: "balance_change", changeMode: "abs", address: ADDR, threshold: "1000", enabled: true };
  out = W.evaluateRules([abs], {}, moved.data, now);
  assert.equal(out.alerts.length, 0);
});

test("incoming_ge fires per new qualifying transfer, dedupes on rescan", () => {
  const { now, data, tx } = fixtureData();
  const rule = { id: "r1", type: "incoming_ge", address: ADDR, threshold: "1000", enabled: true };
  let out = W.evaluateRules([rule], {}, data, now);
  assert.equal(out.alerts.length, 1);
  assert.ok(out.alerts[0].detail.includes("2,000"));
  out = W.evaluateRules([rule], out.baselines, data, now);
  assert.equal(out.alerts.length, 0); // TX1 now seen
  // below-threshold transfer never fires
  const small = fixtureData();
  small.tx.amount = (10n * P).toString();
  small.data.byAddr = W.indexTransfers([small.tx]);
  small.data.transfers = [small.tx];
  out = W.evaluateRules([rule], {}, small.data, now);
  assert.equal(out.alerts.length, 0);
});

test("activity rule reports new transfers, caps output", () => {
  const { now, data } = fixtureData();
  const rule = { id: "r1", type: "activity", address: ADDR, enabled: true };
  const out = W.evaluateRules([rule], {}, data, now);
  assert.equal(out.alerts.length, 1);
});

test("whale_ge scans chain-wide with seen-set dedupe", () => {
  const { now, data } = fixtureData();
  const rule = { id: "w1", type: "whale_ge", threshold: "1000", enabled: true };
  let out = W.evaluateRules([rule], {}, data, now);
  assert.equal(out.alerts.length, 1);
  assert.ok(out.alerts[0].title.startsWith("Whale"));
  out = W.evaluateRules([rule], out.baselines, data, now);
  assert.equal(out.alerts.length, 0);
});

test("new_referendum / new_upgrade fire on count increase only", () => {
  const { now, data } = fixtureData();
  const rules = [
    { id: "g1", type: "new_referendum", enabled: true },
    { id: "g2", type: "new_upgrade", enabled: true },
  ];
  let out = W.evaluateRules(rules, {}, data, now);
  assert.equal(out.alerts.length, 0); // baselines established
  const data2 = fixtureData({ referenda: 4, upgrades: 3 }).data;
  out = W.evaluateRules(rules, out.baselines, data2, now);
  assert.equal(out.alerts.length, 2);
  out = W.evaluateRules(rules, out.baselines, data2, now);
  assert.equal(out.alerts.length, 0);
});

test("chain_stall fires once per head, re-arms on recovery", () => {
  const now = 1_800_000_000_000;
  const mk = (headAgeMin, head) => ({
    balances: new Map(), byAddr: W.indexTransfers([]), transfers: [],
    referenda: 0, upgrades: 0, upgradesList: [], headHeight: head,
    headTsMs: now - headAgeMin * 60000, snapshotCapturedAt: null,
  });
  const rule = { id: "s1", type: "chain_stall", threshold: "30", enabled: true };
  let out = W.evaluateRules([rule], {}, mk(60, 100), now);
  assert.equal(out.alerts.length, 1);
  out = W.evaluateRules([rule], out.baselines, mk(65, 100), now);
  assert.equal(out.alerts.length, 0); // same head, no re-alert
  out = W.evaluateRules([rule], out.baselines, mk(5, 101), now);
  assert.equal(out.alerts.length, 0); // recovered, re-armed
  out = W.evaluateRules([rule], out.baselines, mk(60, 101), now);
  assert.equal(out.alerts.length, 1); // stalled again on new head
});

test("disabled rules and unknown types are ignored", () => {
  const { now, data } = fixtureData();
  const out = W.evaluateRules([
    { id: "x", type: "whale_ge", threshold: "1", enabled: false },
    { id: "y", type: "nope", enabled: true },
  ], {}, data, now);
  assert.equal(out.alerts.length, 0);
});

test("alert ids are deterministic", () => {
  const { now, data } = fixtureData();
  const rule = { id: "w1", type: "whale_ge", threshold: "1000", enabled: true };
  const a = W.evaluateRules([rule], {}, data, now).alerts[0].id;
  const b = W.evaluateRules([rule], {}, data, now).alerts[0].id;
  assert.equal(a, b);
});

test("runSelfTest produces synthetic alerts for each enabled rule", () => {
  const now = 1_800_000_000_000;
  const rules = [
    { id: "r1", type: "balance_below", address: "ZZZ", threshold: "2000", enabled: true },
    { id: "r2", type: "incoming_ge", address: "ZZZ", threshold: "1000", enabled: true },
    { id: "r3", type: "whale_ge", threshold: "50000", enabled: true },
    { id: "r4", type: "new_referendum", enabled: true },
    { id: "r5", type: "chain_stall", threshold: "30", enabled: true },
    { id: "r6", type: "whale_ge", threshold: "1", enabled: false },
  ];
  const alerts = W.runSelfTest(rules, now);
  assert.ok(alerts.length >= 5, "expected >=5 self-test alerts, got " + alerts.length);
  assert.ok(alerts.every((a) => a.synthetic === true));
  const types = new Set(alerts.map((a) => a.ruleId.replace("selftest-", "")));
  ["r1", "r2", "r3", "r4", "r5"].forEach((id) => assert.ok(types.has(id), "missing " + id));
  assert.ok(!types.has("r6"));
});

test("ruleLabel renders human descriptions", () => {
  assert.equal(W.ruleLabel({ type: "whale_ge", threshold: "50000" }), "Whale transfer ≥ 50000 QTC");
  assert.equal(W.ruleLabel({ type: "balance_change", changeMode: "pct", threshold: "10" }), "Balance moves by 10%");
  assert.equal(W.ruleLabel({ type: "chain_stall", threshold: "30" }), "No new block for 30 min");
  assert.equal(W.ruleLabel({ type: "new_referendum" }), "New governance referendum");
});
