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

const ADDR_A = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7";
const ADDR_B = "qzmzw3Bf2sPHaqSZJnUmNJAYiD5DZosZ4xw1kZduqGGKePTDk";

test("buildBalanceMap reads free plancks", () => {
  const m = W.buildBalanceMap([{ address: ADDR_A, free_plancks: "5000000000000" }]);
  assert.equal(m.get(ADDR_A), 5000000000000n);
  assert.equal(m.has(ADDR_B), false);
});

const ADDR = ADDR_A; // a real SS58-189 address: stored baselines are keyed by validated addresses only (round 3)
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

test("sanitizeBlocks keeps only height+timestamp-valid blocks", () => {
  const out = W.sanitizeBlocks([
    { height: 100, timestamp: "2026-10-01T00:00:00Z", hash: "0x" + "ab".repeat(32), reward: "300000000000" },
    { height: "garbage", timestamp: "2026-10-01T00:00:00Z" },
    { height: 12.5, timestamp: "2026-10-01T00:00:00Z" },
    { height: -4, timestamp: "2026-10-01T00:00:00Z" },
    { height: 99, timestamp: "not-a-date" },
    null,
    { height: "98", timestamp: "2026-10-01T00:00:00Z", hash: "0xzz", reward: "-5" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].height, 100);
  assert.equal(out[0].reward, "300000000000");
  assert.equal(out[1].height, 98); // digit-string height normalized
  assert.equal(out[1].hash, null); // malformed hash coerced, block survives
  assert.equal(out[1].reward, null);
  assert.deepEqual(W.sanitizeBlocks("nope"), []);
  assert.deepEqual(W.sanitizeBlocks(undefined), []);
});

test("sanitizeTransfers drops poisoned rows, keeps valid ones verbatim", () => {
  const out = W.sanitizeTransfers([
    { id: "T1", amount: "2000", from_id: ADDR_A, to_id: ADDR_B, block_height: 10, timestamp: "2026-10-01T00:00:00Z" },
    { id: "T2", amount: "12.5", from_id: ADDR_A, to_id: ADDR_B, block_height: 10 },
    { id: "T3", amount: "-5", from_id: ADDR_A, to_id: ADDR_B, block_height: 10 },
    { amount: "100", from_id: ADDR_A, to_id: ADDR_B, block_height: 10 },
    null,
    { id: "T4", amount: "100", from_id: ADDR_A, to_id: ADDR_B, block_height: "x" },
    { id: "T5", amount: 4000, from_id: ADDR_A, to_id: ADDR_B, block_height: 9, timestamp: "garbage" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "T1");
  assert.equal(out[1].id, "T5");
  assert.equal(out[1].amount, "4000"); // safe-integer number normalized to string
  assert.equal(out[1].timestamp, null); // garbage ts is recoverable, row survives
  assert.deepEqual(W.sanitizeTransfers({}), []);
});

const GOV_EVT = (idx, type) => ({ referendum_index: idx, type: type || "SUBMITTED", timestamp: "2026-09-23T08:14:24.319+00:00" });
const GOV_UPG = (patch) => Object.assign({ id: "0000097141-94b40-000002", block_id: "0000097141-94b40", timestamp: "2026-09-23T14:49:17.407+00:00" }, patch);

test("sanitizeGovernance: malformed counts are unknown (null), never 0", () => {
  const g = W.sanitizeGovernance({ referenda: [GOV_EVT(0), GOV_EVT(1)], upgrades: [GOV_UPG({ spec_version: 42 }), GOV_UPG({ id: "0000097142-94b40-000003", block_id: "0000097142-94b40", spec_version: "x" })] });
  assert.equal(g.referenda, 2);
  assert.equal(g.upgrades, 2);
  assert.equal(g.upgradesList[0].spec_version, 42);
  assert.equal(g.upgradesList[1].spec_version, null); // producer writes no spec_version; a junk one nulls, never paints
  assert.equal(W.sanitizeGovernance({ referenda: "oops", upgrades: [] }), null);
  assert.equal(W.sanitizeGovernance({}), null); // failed load: counts unknown
  assert.equal(W.sanitizeGovernance(null), null);
});

test("sanitizeGovernance counts distinct referenda, not lifecycle events (round 5)", () => {
  // The producer writes one row per lifecycle event: ref 0 alone has 4.
  const events = [GOV_EVT(0, "SUBMITTED"), GOV_EVT(0, "DECISION_STARTED"), GOV_EVT(0, "CONFIRM_STARTED"), GOV_EVT(0, "CONFIRMED")];
  const g = W.sanitizeGovernance({ referenda: events, upgrades: [] });
  assert.equal(g.referenda, 1); // 4 events, ONE referendum (the real snapshot's shape)
  const staged = W.sanitizeGovernance({ referenda: events.concat([GOV_EVT(0, "EXECUTED")]), upgrades: [] });
  assert.equal(staged.referenda, 1); // a stage transition is not a new referendum
  const grown = W.sanitizeGovernance({ referenda: events.concat([GOV_EVT(1, "SUBMITTED")]), upgrades: [] });
  assert.equal(grown.referenda, 2); // a new index is
  const empty = W.sanitizeGovernance({ referenda: [], upgrades: [] });
  assert.equal(empty.referenda, 0); // empty is a known 0, not unknown
});

test("sanitizeGovernance: an index-less event row makes the count unknown (round 5)", () => {
  assert.equal(W.sanitizeGovernance({ referenda: [{}, {}], upgrades: [] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [GOV_EVT(0), { type: "SUBMITTED" }], upgrades: [] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: ["junk"], upgrades: [] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [GOV_EVT(-1)], upgrades: [] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [GOV_EVT(2000000)], upgrades: [] }), null); // past the gov ceiling
});

test("sanitizeGovernance: upgrade rows held to the producer grammar, duplicates deduped (round 5)", () => {
  const dup = W.sanitizeGovernance({ referenda: [], upgrades: [GOV_UPG({}), GOV_UPG({})] });
  assert.equal(dup.upgrades, 1); // the same upgrade restated is one upgrade
  assert.equal(W.sanitizeGovernance({ referenda: [], upgrades: [GOV_UPG({ id: "garbage" })] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [], upgrades: [GOV_UPG({ block_id: "0000099999-abcde" })] }), null); // block_id must be the id's prefix
  assert.equal(W.sanitizeGovernance({ referenda: [], upgrades: [GOV_UPG({ timestamp: "2999-01-01T00:00:00.000Z" })] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [], upgrades: [{}] }), null);
  assert.equal(W.sanitizeGovernance({ referenda: [], upgrades: ["junk"] }), null);
});

test("sanitizeBaselines coerces poison instead of wedging every scan", () => {
  const b = W.sanitizeBaselines({
    addresses: { [ADDR_A]: { balance: "abc", seenIn: "nope", seenOut: [123, "TX1", "TX1"] }, [ADDR_B]: null, GARBAGEKEY: { balance: "500", seenIn: [], seenOut: [] } },
    chain: { referenda: "oops", upgrades: -3, stallFiredHead: "x", seenWhale: 42 },
  });
  assert.equal(b.addresses[ADDR_A].balance, null); // re-baselines next scan, never throws
  assert.deepEqual(b.addresses[ADDR_A].seenIn, []);
  assert.deepEqual(b.addresses[ADDR_A].seenOut, ["TX1"]);
  assert.equal(b.addresses[ADDR_B], undefined);
  assert.equal(b.addresses.GARBAGEKEY, undefined); // round 3: keys must be real Quantus addresses
  assert.deepEqual(b.chain, { referenda: null, upgrades: null, stallFiredHead: null, seenWhale: [] });
  assert.deepEqual(W.sanitizeBaselines("junk").chain, { referenda: null, upgrades: null, stallFiredHead: null, seenWhale: [] });
});

test("sanitizeAlerts drops brick-rows, coerces annotation fields", () => {
  const out = W.sanitizeAlerts([
    { id: "a1", ruleId: "r", address: ADDR_A, severity: "warn", title: "T", detail: "D", ts: "2026-10-01T00:00:00Z", read: false },
    null,
    { id: "a2", title: "T", detail: "D", ts: "garbage" },
    { id: "a3", title: "T", detail: "D", ts: "2026-10-01T00:00:00Z", address: 12345, severity: "catastrophic" },
    { title: "no id", detail: "D", ts: "2026-10-01T00:00:00Z" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "a1");
  assert.equal(out[0].address, ADDR_A);
  assert.equal(out[1].address, null);
  assert.equal(out[1].severity, "info");
  assert.deepEqual(W.sanitizeAlerts("junk"), []);
});

test("round 3: sanitizeWatchlist enforces producer relations", () => {
  const wl = W.sanitizeWatchlist([
    { address: ADDR_A, nick: "Cold", note: "keep", addedAt: "2026-10-01T00:00:00Z", checkphrase: ["a", "b", "c", "d", "e"] },
    { address: ADDR_A, nick: "dup" },
    { address: ADDR_B, nick: "x".repeat(80), note: "y".repeat(300), checkphrase: ["only", "three", "words"] },
    { address: "not-an-address", checkphrase: ["a", "b", "c", "d", "e"] },
    null, "junk",
    { address: ADDR_B, checkphrase: "not-an-array" },
  ]);
  assert.equal(wl.length, 2); // dedupe + invalid dropped (fallback: strict SS58-189 shape)
  assert.deepEqual(wl[0].checkphrase, ["a", "b", "c", "d", "e"]); // exactly-5 kept
  assert.equal(wl[1].nick.length, 40); // form maxlength
  assert.equal(wl[1].note.length, 140);
  assert.equal(wl[1].checkphrase, null); // wrong-length phrase nulls -> re-derived, never painted
  // a supplied full-grade validator gates instead of the shape fallback
  const gated = W.sanitizeWatchlist([{ address: ADDR_A }, { address: ADDR_B }], (a) => a === ADDR_A ? { ok: true, address: a } : { ok: false });
  assert.deepEqual(gated.map((x) => x.address), [ADDR_A]);
  assert.deepEqual(W.sanitizeWatchlist("junk"), []);
});

test("round 4: eraTs + watchlist addedAt hold the producer era window", () => {
  // Producers stamp addedAt with new Date().toISOString() (watch form
  // and backup import alike), so the stamp must be a chain-era time —
  // parseable alone let 2020/2999 stamps ride the backup export as fact.
  assert.equal(W.eraTs("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00Z");
  assert.equal(W.eraTs("2026-09-01T00:00:00.000Z"), "2026-09-01T00:00:00.000Z"); // genesis floor edge
  assert.equal(W.eraTs("2020-01-01T00:00:00Z"), null);
  assert.equal(W.eraTs("2999-01-01T00:00:00Z"), null);
  assert.equal(W.eraTs("2026-08-31T23:59:59Z"), null); // pre-genesis
  assert.equal(W.eraTs("garbage"), null);
  assert.equal(W.eraTs(null), null);
  assert.equal(W.eraTs(1791000000000), null);
  const wl = W.sanitizeWatchlist([
    { address: ADDR_A, addedAt: "2020-01-01T00:00:00Z" },
    { address: ADDR_B, addedAt: "2999-01-01T00:00:00Z" },
  ]);
  assert.equal(wl.length, 2); // rows kept — addedAt is cosmetic
  assert.equal(wl[0].addedAt, null);
  assert.equal(wl[1].addedAt, null);
});

test("round 3: sanitizeAlerts relations — dedupe, era window, caps", () => {
  const TS = "2026-10-12T00:00:00Z";
  const out = W.sanitizeAlerts([
    { id: "a1", title: "first", detail: "D", ts: TS },
    { id: "a1", title: "duplicate id", detail: "D", ts: TS },
    { id: "a2", title: "pre-genesis", detail: "D", ts: "2020-01-01T00:00:00Z" },
    { id: "a3", title: "far future", detail: "D", ts: "2999-01-01T00:00:00Z" },
    { id: "a4", title: "bad addr", detail: "D", ts: TS, address: "not-an-address" },
    { id: "a5", title: "x".repeat(500), detail: "y".repeat(5000), ts: TS },
  ]);
  assert.deepEqual(out.map((a) => a.id), ["a1", "a4", "a5"]); // dup + impossible-era dropped
  assert.equal(out[0].title, "first"); // first wins
  assert.equal(out[1].address, null); // non-Quantus address coerces to null
  assert.equal(out[2].title.length, 200);
  assert.equal(out[2].detail.length, 1000);
  const flood = W.sanitizeAlerts(Array.from({ length: 600 }, (_, i) => ({ id: "m" + i, title: "T", detail: "D", ts: TS })));
  assert.equal(flood.length, 500); // the scan path's own cap
});

test("round 3: sanitizeBaselines relations — supply cap, bounded stall head, gov counts", () => {
  const b = W.sanitizeBaselines({
    addresses: { [ADDR_A]: { balance: "99999999999999999999999999", seenIn: [], seenOut: [] } },
    chain: { referenda: 5, upgrades: 999999999, stallFiredHead: 99999999999, seenWhale: [] },
  });
  assert.equal(b.addresses[ADDR_A].balance, null); // over the 21M supply: re-baseline, never fact
  assert.equal(b.chain.referenda, 5);
  assert.equal(b.chain.upgrades, null); // implausible count reads unknown
  assert.equal(b.chain.stallFiredHead, null); // bounded by the fleet height ceiling
  const ok = W.sanitizeBaselines({ chain: { referenda: 12, upgrades: 3, stallFiredHead: 216000, seenWhale: ["TX"] } });
  assert.deepEqual(ok.chain, { referenda: 12, upgrades: 3, stallFiredHead: 216000, seenWhale: ["TX"] });
});

test("buildBalanceMap rejects negative and non-string-address rows", () => {
  const m = W.buildBalanceMap([
    { address: ADDR_A, free_plancks: "500" },
    { address: ADDR_B, free_plancks: "-5" },
    { address: 42, free_plancks: "500" },
    { address: ADDR_B, free_plancks: "12.5" },
  ]);
  assert.equal(m.get(ADDR_A), 500n);
  assert.equal(m.has(ADDR_B), false);
  assert.equal(m.size, 1);
});

test("sanitizeBlocks round 2: relations, not just shapes", () => {
  const blk = (patch) => Object.assign({
    height: 207816, timestamp: "2026-10-11T20:19:37.660Z",
    hash: "0x" + "ab".repeat(32), reward: "310000000000",
  }, patch);
  // a parseable timestamp outside the chain's lifetime is not a chain time
  assert.equal(W.sanitizeBlocks([blk({ timestamp: "2020-01-01T00:00:00Z" })]).length, 0);
  assert.equal(W.sanitizeBlocks([blk({ timestamp: "2999-01-01T00:00:00Z" })]).length, 0);
  assert.equal(W.sanitizeBlocks([blk({ height: 99999999999 })]).length, 0);
  // shuffled input still puts the highest block first; duplicates count once
  const shuffled = W.sanitizeBlocks([
    blk({ height: 207814, timestamp: "2026-10-11T20:18:30.781Z" }),
    blk({}),
    blk({ height: 207815, timestamp: "2026-10-11T20:19:17.821Z" }),
    blk({}),
  ]);
  assert.deepEqual(shuffled.map((b) => b.height), [207816, 207815, 207814]);
  // a lower block stamped later than a higher block contradicts the order
  const nonmono = W.sanitizeBlocks([blk({}), blk({ height: 207815, timestamp: "2026-10-11T20:25:00.000Z" })]);
  assert.deepEqual(nonmono.map((b) => b.height), [207816]);
  // over-cap reward is an annotation: coerced to null, block survives
  assert.equal(W.sanitizeBlocks([blk({ reward: "999999000000000000000000" })])[0].reward, null);
});

test("resolveHead: status must restate blocks[0]", () => {
  const blocks = W.sanitizeBlocks([
    { height: 100, timestamp: "2026-10-01T00:00:00Z" },
    { height: 99, timestamp: "2026-10-01T00:00:00Z" },
  ]);
  assert.equal(W.resolveHead(blocks, { block_height: 100 }).height, 100);
  assert.equal(W.resolveHead(blocks, { block_height: 101 }), null); // disagreement trusts neither
  assert.equal(W.resolveHead(blocks, { block_height: "garbage" }), null);
  assert.equal(W.resolveHead(blocks, null).height, 100); // absent status: blocks decide
  assert.equal(W.resolveHead([], { block_height: 100 }), null);
});

test("sanitizeTransfers round 2: relations, not just shapes", () => {
  const row = (patch) => Object.assign({
    id: "t1", amount: "1000000000000", from_id: ADDR_A, to_id: ADDR_B,
    block_height: 200000, timestamp: "2026-10-11T00:00:00.000Z",
  }, patch);
  assert.equal(W.sanitizeTransfers([row({})]).length, 1); // control
  assert.equal(W.sanitizeTransfers([row({ amount: "0" })]).length, 0); // zero paints nothing
  assert.equal(W.sanitizeTransfers([row({ amount: "22000000000000000000000" })]).length, 0); // over the 21M cap
  assert.equal(W.sanitizeTransfers([row({ block_height: 99999999999 })]).length, 0);
  assert.equal(W.sanitizeTransfers([row({ from_id: "not-an-address" })]).length, 0);
  assert.equal(W.sanitizeTransfers([row({ timestamp: "2020-01-01T00:00:00.000Z" })]).length, 0); // present but impossible
  assert.equal(W.sanitizeTransfers([row({ timestamp: "2999-01-01T00:00:00.000Z" })]).length, 0);
  assert.equal(W.sanitizeTransfers([row({}), row({})]).length, 1); // duplicated id counts once
  // dedupe after validation: a poisoned first copy cannot suppress a good one
  assert.equal(W.sanitizeTransfers([row({ amount: "22000000000000000000000" }), row({})]).length, 1);
  // the snapshot's own head bounds its rows
  assert.equal(W.sanitizeTransfers([row({ block_height: 207819 })], 207818).length, 0);
  assert.equal(W.sanitizeTransfers([row({ block_height: 207818 })], 207818).length, 1);
});

test("buildBalanceMap round 2: cap, shape, duplicates", () => {
  assert.equal(W.buildBalanceMap([{ address: ADDR_A, free_plancks: "22000000000000000000000" }]).size, 0); // over cap
  assert.equal(W.buildBalanceMap([{ address: "not-an-address", free_plancks: "500" }]).size, 0);
  const dup = W.buildBalanceMap([
    { address: ADDR_A, free_plancks: "500" },
    { address: ADDR_A, free_plancks: "999" },
  ]);
  assert.equal(dup.get(ADDR_A), 500n); // first valid row wins
});

test("unknown governance counts neither fire nor reset the baseline", () => {
  const { now, data } = fixtureData(); // referenda 3, upgrades 2
  const rules = [
    { id: "g1", type: "new_referendum", enabled: true },
    { id: "g2", type: "new_upgrade", enabled: true },
  ];
  let out = W.evaluateRules(rules, {}, data, now);
  assert.equal(out.baselines.chain.referenda, 3);
  // a scan whose governance payload failed: counts unknown (null)
  const unknown = fixtureData({ referenda: null, upgrades: null }).data;
  out = W.evaluateRules(rules, out.baselines, unknown, now);
  assert.equal(out.alerts.length, 0);
  assert.equal(out.baselines.chain.referenda, 3); // NOT reset to null/0
  assert.equal(out.baselines.chain.upgrades, 2);
  // the next good scan still detects the increase exactly once
  const grown = fixtureData({ referenda: 4, upgrades: 2 }).data;
  out = W.evaluateRules(rules, out.baselines, grown, now);
  assert.equal(out.alerts.length, 1);
  assert.ok(out.alerts[0].title.includes("referendum"));
});

test("evaluateRules survives poisoned stored baselines", () => {
  const { now, data } = fixtureData();
  const rule = { id: "r1", type: "balance_below", address: ADDR, threshold: "1000", enabled: true };
  const poison = {
    addresses: { [ADDR]: { balance: "abc", seenIn: 5, seenOut: "x" } },
    chain: { referenda: "oops", upgrades: [], stallFiredHead: {}, seenWhale: 9 },
  };
  const out = W.evaluateRules([rule], poison, data, now);
  assert.ok(Array.isArray(out.alerts)); // no BigInt throw; balance re-baselines
  assert.equal(out.baselines.addresses[ADDR].balance, (100n * P).toString());
});

test("watchRoom holds the watchlist cap at creation, not only at load", () => {
  assert.equal(W.MAX_WATCHLIST, 500);
  assert.equal(W.watchRoom(0), 500);
  assert.equal(W.watchRoom(499), 1);
  assert.equal(W.watchRoom(500), 0);
  assert.equal(W.watchRoom(5000), 0); // never negative
  assert.equal(W.watchRoom("x"), 500); // garbage counts as an empty list
  assert.equal(W.watchRoom(-3), 500);
});

test("ruleRoom holds the rule cap at creation, not only at load", () => {
  assert.equal(W.MAX_RULES, 500);
  assert.equal(W.ruleRoom(0), 500);
  assert.equal(W.ruleRoom(499), 1);
  assert.equal(W.ruleRoom(500), 0);
  assert.equal(W.ruleRoom(5000), 0); // never negative
  assert.equal(W.ruleRoom("x"), 500); // garbage counts as an empty list
  assert.equal(W.ruleRoom(-3), 500);
});

test("backupFileRoom admits every backup the exporter can produce, at the cap", () => {
  assert.equal(W.MAX_BACKUP_FILE_BYTES, 32 * 1024 * 1024);
  assert.equal(W.backupFileRoom(0), true);
  assert.equal(W.backupFileRoom(15285312), true); // largest genuine backup, plain
  assert.equal(W.backupFileRoom(15735312), true); // largest genuine backup, worst JSON escaping
  assert.equal(W.backupFileRoom(W.MAX_BACKUP_FILE_BYTES), true);
});

test("backupFileRoom refuses over-cap and sizeless picks, fail-closed", () => {
  assert.equal(W.backupFileRoom(W.MAX_BACKUP_FILE_BYTES + 1), false);
  assert.equal(W.backupFileRoom(100 * 1024 * 1024), false);
  assert.equal(W.backupFileRoom(NaN), false);
  assert.equal(W.backupFileRoom(-1), false);
  assert.equal(W.backupFileRoom("100"), false); // no string coercion
  assert.equal(W.backupFileRoom(undefined), false);
  assert.equal(W.backupFileRoom(null), false);
  assert.equal(W.backupFileRoom(Infinity), false);
});

test("the producer-bounded maximum backup fits the file gate", () => {
  // Build the largest state the tower can hold with the module's own
  // sanitizers (500-entry watchlist, 500 baselines x 400+400 distinct
  // 23-char seen ids, chain seenWhale 400) and serialize it exactly as
  // the exporter does — it must stay under the cap with ~2x headroom,
  // because baselines (which the importer drops) dominate the size.
  const addr = (i) => {
    const cs = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let tail = "", m = i + 1;
    while (m > 0) { tail = cs[m % 58] + tail; m = Math.floor(m / 58); }
    return "qz" + ("1".repeat(47 - tail.length) + tail).slice(-47);
  };
  const tid = (i) => "0000237275-cd772-" + String(i).padStart(6, "0");
  const watchlist = W.sanitizeWatchlist(
    Array.from({ length: 500 }, (_, i) => ({ address: addr(i), nick: "n".repeat(40), note: "x".repeat(140), addedAt: "2026-10-16T20:23:17.876Z", checkphrase: ["unquestionable", "irreplaceable", "sophisticated", "invulnerable", "unparalleled"] })), null);
  const rawBase = { addresses: {}, chain: { referenda: 1000000, upgrades: 1000000, stallFiredHead: 10000000, seenWhale: Array.from({ length: 400 }, (_, i) => tid(i)) } };
  for (let i = 0; i < 500; i++) rawBase.addresses[addr(1000 + i)] = { balance: "21000000000000000000", seenIn: Array.from({ length: 400 }, (_, j) => tid(j)), seenOut: Array.from({ length: 400 }, (_, j) => tid(100000 + j)) };
  const baselines = W.sanitizeBaselines(rawBase);
  const rules = Array.from({ length: 500 }, (_, i) => ({ id: "rule-" + (1000000 + i) + "-zzzzzzzz", type: "balance_change", severity: "crit", enabled: true, address: addr(i), changeMode: "pct", threshold: "21000000.000000000001" }));
  const bytes = Buffer.byteLength(JSON.stringify({ app: "qtc-watchtower", version: 1, exportedAt: "2026-10-16T20:23:17.876Z", watchlist, rules, baselines }, null, 2));
  assert.equal(bytes, 15285312);
  assert.equal(W.backupFileRoom(bytes), true);
});

test("ruleLabel renders human descriptions", () => {
  assert.equal(W.ruleLabel({ type: "whale_ge", threshold: "50000" }), "Whale transfer ≥ 50000 QTC");
  assert.equal(W.ruleLabel({ type: "balance_change", changeMode: "pct", threshold: "10" }), "Balance moves by 10%");
  assert.equal(W.ruleLabel({ type: "chain_stall", threshold: "30" }), "No new block for 30 min");
  assert.equal(W.ruleLabel({ type: "new_referendum" }), "New governance referendum");
});

/* Batch 194: amount-input length bound — parseQtcToPlancks BigInt-converted
 * an unbounded digit string whole (superlinear freeze). */
test("amount bound: parseQtcToPlancks length gate", () => {
  assert.equal(W.parseQtcToPlancks("1.5"), 1500000000000n);
  assert.throws(() => W.parseQtcToPlancks("9".repeat(600)), /512/);
  assert.throws(() => W.parseQtcToPlancks("0".repeat(600) + "1.5"), /512/);
  assert.throws(() => W.parseQtcToPlancks("9".repeat(2000000)), /512/);
  assert.equal(typeof W.parseQtcToPlancks("9".repeat(512)), "bigint");
});
/* Batch 195: non-amount integer-string length bound — validPlancks
 * BigInt-converted an unbounded digit string whole. */
test("int bound: validPlancks length gate", () => {
  assert.equal(W.validPlancks("7000000000000"), 7000000000000n);
  assert.equal(W.validPlancks("0".repeat(596) + "7"), null);
  assert.equal(W.validPlancks("9".repeat(512)), BigInt("9".repeat(512)));
  assert.equal(W.validPlancks("9".repeat(2000000)), null);
});

/* Batch 199: float-threshold gate — parseFloat("1e999") is Infinity and
 * Infinity > 0 passed every form/sanitize gate, arming stall/pct rules
 * that could never fire. */
test("float gate: floatThreshold refuses non-finite thresholds", () => {
  assert.equal(W.floatThreshold("30"), 30);
  assert.equal(W.floatThreshold("0.5"), 0.5);
  assert.equal(W.floatThreshold("1e2"), 100);
  assert.equal(W.floatThreshold("1e999"), null);
  assert.equal(W.floatThreshold("Infinity"), null);
  assert.equal(W.floatThreshold("-Infinity"), null);
  assert.equal(W.floatThreshold("0"), null);
  assert.equal(W.floatThreshold("-5"), null);
  assert.equal(W.floatThreshold("abc"), null);
  assert.equal(W.floatThreshold(""), null);
  assert.equal(W.floatThreshold(45), 45);
  assert.equal(W.floatThreshold(Infinity), null);
});

test("float gate: poisoned stall rule never fires, finite one does", () => {
  const now = 1_800_000_000_000;
  const mk = (ageMin, head) => ({
    balances: new Map(), byAddr: W.indexTransfers([]), transfers: [],
    referenda: 0, upgrades: 0, upgradesList: [], headHeight: head,
    headTsMs: now - ageMin * 60000, snapshotCapturedAt: null,
  });
  const poison = W.evaluateRules([{ id: "p1", type: "chain_stall", threshold: "1e999", enabled: true }], {}, mk(60, 100), now);
  assert.equal(poison.alerts.length, 0);
  const sane = W.evaluateRules([{ id: "p2", type: "chain_stall", threshold: "30", enabled: true }], {}, mk(60, 100), now);
  assert.equal(sane.alerts.length, 1);
});
