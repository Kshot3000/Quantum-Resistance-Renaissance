#!/usr/bin/env node
/* QTC Flow Tracer — node unit tests for js/flow-core.js.
 * All money math is BigInt plancks; every vector asserts exact equality.
 */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const F = require(join(__dirname, "..", "js", "flow-core.js"));

const Q = 1000000000000n;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error("FAIL", name, "->", e.message); }
}

// Synthetic chain: G -100-> A -60-> B -60-> C ; A -40-> D ; X -10-> B ; B -5-> Y
// (B is a merge point, not peelable; A->B->C is not one-in-one-out at B.)
function synthRows() {
  let n = 0;
  const mk = (from, to, amt, h) => ({ id: "t" + (n++), amount: amt, from_id: from, to_id: to, block_height: h, timestamp: null, fee: "0", extrinsic_id: null });
  return [
    mk("G", "A", 100n * Q, 1),
    mk("A", "B", 60n * Q, 2),
    mk("B", "C", 60n * Q, 3),
    mk("A", "D", 40n * Q, 4),
    mk("X", "B", 10n * Q, 5),
    mk("B", "Y", 5n * Q, 6),
  ];
}
// Clean peel chain: P0 -50-> P1 -49-> P2 -48-> P3 -47-> P4 (one-in-one-out middles)
function peelRows() {
  let n = 100;
  const mk = (from, to, amt, h) => ({ id: "p" + (n++), amount: amt, from_id: from, to_id: to, block_height: h, timestamp: null, fee: "0", extrinsic_id: null });
  return [
    mk("P0", "P1", 50n * Q, 10),
    mk("P1", "P2", 49n * Q, 11),
    mk("P2", "P3", 48n * Q, 12),
    mk("P3", "P4", 47n * Q, 13),
  ];
}

/* --- buildGraph --- */
t("buildGraph normalizes string amounts to BigInt", () => {
  const g = F.buildGraph([{ id: "a", amount: "1500000000000", from_id: "x", to_id: "y", block_height: 9, timestamp: null, fee: "0", extrinsic_id: null }]);
  assert.equal(g.rows[0].amount, 1500000000000n);
  assert.equal(g.out.get("x").length, 1);
  assert.equal(g.inn.get("y").length, 1);
});

/* --- trace --- */
t("trace out 1 hop from A reaches B and D only", () => {
  const g = F.buildGraph(synthRows());
  const tr = F.trace(g, "A", { direction: "out", maxHops: 1, maxNodes: 100 });
  assert.deepEqual([...tr.nodes.keys()].sort(), ["A", "B", "D"]);
  assert.equal(tr.edges.length, 2);
  assert.equal(tr.truncated, false);
});
t("trace both 2 hops from B covers the neighborhood", () => {
  const g = F.buildGraph(synthRows());
  const tr = F.trace(g, "B", { direction: "both", maxHops: 2, maxNodes: 100 });
  for (const a of ["A", "B", "C", "X", "Y", "G", "D"]) assert.ok(tr.nodes.has(a), "missing " + a);
  assert.equal(tr.nodes.get("A").depth, -1);
  assert.equal(tr.nodes.get("C").depth, 1);
  assert.equal(tr.nodes.get("G").depth, -2);
});
t("trace respects maxNodes and flags truncation", () => {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ id: "s" + i, amount: 2n * Q, from_id: "STAR", to_id: "LEAF" + i, block_height: 50 + i, timestamp: null, fee: "0", extrinsic_id: null });
  const g = F.buildGraph(rows);
  const tr = F.trace(g, "STAR", { direction: "out", maxHops: 1, maxNodes: 10 });
  assert.ok(tr.nodes.size <= 10, "nodes=" + tr.nodes.size);
  assert.equal(tr.truncated, true);
  assert.equal(tr.edges.length, 14); // edges are all recorded; only nodes are capped
});
t("trace of unknown address yields only the seed", () => {
  const g = F.buildGraph(synthRows());
  const tr = F.trace(g, "ZZZ", { direction: "both", maxHops: 2, maxNodes: 100 });
  assert.equal(tr.nodes.size, 1);
  assert.equal(tr.edges.length, 0);
});
t("trace caps edges at maxEdges and flags edgeTruncated", () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ id: "e" + i, amount: 1n * Q, from_id: "HUB", to_id: "LEAF" + (i % 20), block_height: 60 + i, timestamp: null, fee: "0", extrinsic_id: null });
  const g = F.buildGraph(rows);
  const tr = F.trace(g, "HUB", { direction: "out", maxHops: 1, maxNodes: 400, maxEdges: 120 });
  assert.equal(tr.edges.length, 120);
  assert.equal(tr.edgeTruncated, true);
  assert.equal(tr.truncated, true);
});
t("trace default edge cap is 1200 (hub seed cannot flood the graph)", () => {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push({ id: "d" + i, amount: 1n * Q, from_id: "HUB", to_id: "L" + (i % 30), block_height: 70 + i, timestamp: null, fee: "0", extrinsic_id: null });
  const g = F.buildGraph(rows);
  const tr = F.trace(g, "HUB", { direction: "out", maxHops: 1, maxNodes: 400 });
  assert.equal(tr.edges.length, 1200);
  assert.equal(tr.edgeTruncated, true);
});

/* --- aggregateEdges --- */
t("aggregateEdges sums parallel transfers per ordered pair", () => {
  const g = F.buildGraph([
    { id: "a1", amount: 10n * Q, from_id: "A", to_id: "B", block_height: 5, timestamp: "2026-01-01T00:00:00Z", fee: "0", extrinsic_id: null },
    { id: "a2", amount: 25n * Q, from_id: "A", to_id: "B", block_height: 9, timestamp: "2026-01-02T00:00:00Z", fee: "0", extrinsic_id: null },
    { id: "a3", amount: 7n * Q, from_id: "B", to_id: "A", block_height: 1, timestamp: null, fee: "0", extrinsic_id: null },
  ]);
  const agg = F.aggregateEdges(g.rows);
  assert.equal(agg.length, 2); // A->B and B->A are distinct ordered pairs
  assert.equal(agg[0].from_id, "A"); // first-seen order preserved
  assert.equal(agg[0].amount, 35n * Q);
  assert.equal(agg[0].count, 2);
  assert.equal(agg[0].maxAmount, 25n * Q);
  assert.equal(agg[0].lastBlock, 9);
  assert.equal(agg[0].timestamp, "2026-01-02T00:00:00Z");
  assert.equal(agg[0].genesis, false);
  assert.equal(agg[1].genesis, true);
  assert.equal(agg[1].amount, 7n * Q);
});

/* --- layoutTrace --- */
t("layoutTrace is deterministic and sizes to layers", () => {
  const g = F.buildGraph(synthRows());
  const t1 = F.trace(g, "A", { direction: "out", maxHops: 2, maxNodes: 100 });
  const l1 = F.layoutTrace(t1), l2 = F.layoutTrace(t1);
  assert.deepEqual([...l1.pos.keys()].sort(), [...l2.pos.keys()].sort());
  assert.deepEqual(l1.pos.get("A"), l2.pos.get("A"));
  assert.ok(l1.width >= F.XSTEP * 2);
  assert.ok(l1.height >= 220);
  assert.equal(l1.layers.get(0).length, 1); // seed alone on its layer
});

/* --- detectPeelChains --- */
t("detectPeelChains finds the clean 4-hop chain", () => {
  const g = F.buildGraph(peelRows());
  const chains = F.detectPeelChains(g, 3);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].path, ["P0", "P1", "P2", "P3", "P4"]);
  assert.equal(chains[0].hops.length, 4);
  assert.equal(chains[0].moved, (50n + 49n + 48n + 47n) * Q);
});
t("detectPeelChains ignores merge points", () => {
  const g = F.buildGraph(synthRows());
  const chains = F.detectPeelChains(g, 2);
  // B has 2 in / 2 out: no chain may pass through B
  for (const c of chains) assert.ok(!c.path.includes("B"), "chain passes through merge " + c.path);
});
t("detectPeelChains respects minLen", () => {
  const g = F.buildGraph(peelRows());
  assert.equal(F.detectPeelChains(g, 5).length, 0);
  assert.equal(F.detectPeelChains(g, 4).length, 1);
});

/* --- fan-out / fan-in --- */
t("detectFanOut flags a distributor", () => {
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push({ id: "f" + i, amount: 10n * Q, from_id: "DIST", to_id: "R" + i, block_height: 20 + i, timestamp: null, fee: "0", extrinsic_id: null });
  const g = F.buildGraph(rows);
  const r = F.detectFanOut(g, 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].addr, "DIST");
  assert.equal(r[0].distinct, 7);
  assert.equal(r[0].total, 70n * Q);
});
t("detectFanIn flags a consolidator", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ id: "c" + i, amount: 3n * Q, from_id: "S" + i, to_id: "CONS", block_height: 30 + i, timestamp: null, fee: "0", extrinsic_id: null });
  const g = F.buildGraph(rows);
  const r = F.detectFanIn(g, 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].addr, "CONS");
  assert.equal(r[0].distinct, 6);
  assert.equal(r[0].total, 18n * Q);
});

/* --- round amounts --- */
t("roundAmountTransfers keeps only whole-QTC rows, biggest first", () => {
  const g = F.buildGraph(synthRows());
  const r = F.roundAmountTransfers(g.rows);
  assert.ok(r.every((x) => x.amount % Q === 0n));
  assert.equal(r[0].amount, 100n * Q);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].amount >= r[i].amount);
});

/* --- miner forwarding --- */
t("minerForwarding maps coinbase recipients to their onward flow", () => {
  const rows = [
    { id: "m1", amount: 310000000000n, from_id: "SENT", to_id: "MIN1", block_height: 1, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "m2", amount: 310000000000n, from_id: "SENT", to_id: "MIN1", block_height: 2, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "m3", amount: 500000000000n, from_id: "MIN1", to_id: "POOL", block_height: 3, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "m4", amount: 310000000000n, from_id: "SENT", to_id: "MIN2", block_height: 4, timestamp: null, fee: "0", extrinsic_id: null },
  ];
  const g = F.buildGraph(rows);
  const r = F.minerForwarding(g, "SENT");
  assert.equal(r.length, 1); // MIN2 never forwarded
  assert.equal(r[0].miner, "MIN1");
  assert.equal(r[0].rewards, 620000000000n);
  assert.equal(r[0].onwardTotal, 500000000000n);
});

/* --- summarizeAddress --- */
t("summarizeAddress totals, net and counterparties", () => {
  const g = F.buildGraph(synthRows());
  const s = F.summarizeAddress(g, "B");
  assert.equal(s.inCount, 2);
  assert.equal(s.outCount, 2);
  assert.equal(s.inTotal, 70n * Q);
  assert.equal(s.outTotal, 65n * Q);
  assert.equal(s.net, 5n * Q);
  assert.equal(s.firstBlock, 2);
  assert.equal(s.lastBlock, 6);
  assert.equal(s.topSenders[0].addr, "A");
  assert.equal(s.topRecipients[0].addr, "C");
});
t("summarizeAddress of unknown address is empty", () => {
  const g = F.buildGraph(synthRows());
  const s = F.summarizeAddress(g, "NOPE");
  assert.equal(s.inCount, 0);
  assert.equal(s.net, 0n);
  assert.equal(s.firstBlock, null);
});

/* --- formatting --- */
t("fmtQTC formats with commas and trims zeros", () => {
  assert.equal(F.fmtQTC(1234567890123456n), "1,234.5678");
  assert.equal(F.fmtQTC(1000000000000n), "1");
  assert.equal(F.fmtQTC(0n), "0");
  assert.equal(F.fmtQTC(-2500000000000n), "-2.5");
  assert.equal(F.fmtQTC(5669940001000000000n), "5,669,940.001");
  assert.equal(F.fmtQTC(1n), "0");
  assert.equal(F.fmtQTC(1n, 12), "0.000000000001");
});
t("shortAddr abbreviates long addresses", () => {
  assert.equal(F.shortAddr("qz1234567890abcdefghij"), "qz123456\u2026efghij");
  assert.equal(F.shortAddr("short"), "short");
});
t("fmtTime handles null timestamp", () => {
  assert.equal(F.fmtTime(null), "genesis (block 1)");
  assert.ok(F.fmtTime("2026-09-30T15:01:24.781+00:00").startsWith("2026-09-30 15:01"));
});

/* --- load/RPC boundary (2026-10-09) --- */
t("validPlancks accepts only non-negative integer plancks", () => {
  assert.equal(F.validPlancks("1500000000000"), "1500000000000");
  assert.equal(F.validPlancks(42), "42");
  assert.equal(F.validPlancks(42n), "42");
  assert.equal(F.validPlancks("007"), "7");
  assert.equal(F.validPlancks("12.5"), null);
  assert.equal(F.validPlancks("-5"), null);
  assert.equal(F.validPlancks(-5n), null);
  assert.equal(F.validPlancks("abc"), null);
  assert.equal(F.validPlancks(null), null);
  assert.equal(F.validPlancks(1.5), null);
});
t("sanitizeTransfers drops core poison, coerces recoverable fields", () => {
  const clean = F.sanitizeTransfers([
    { id: "ok", amount: "2000000000000", from_id: "A", to_id: "B", block_height: 10, timestamp: "2026-01-01T00:00:00Z", fee: "5", extrinsic_id: "0x1" },
    { id: "frac", amount: "12.5", from_id: "A", to_id: "B", block_height: 11, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "neg", amount: "-5", from_id: "A", to_id: "B", block_height: 12, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "badh", amount: "1", from_id: "A", to_id: "B", block_height: "x", timestamp: null, fee: "0", extrinsic_id: null },
    { id: "nofrom", amount: "1", to_id: "B", block_height: 13, timestamp: null, fee: "0", extrinsic_id: null },
    null,
    "not-a-row",
    { id: "coerce", amount: "1", from_id: "A", to_id: "B", block_height: 14, timestamp: "garbage", fee: "junk", extrinsic_id: 7 },
  ]);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].id, "ok");
  assert.equal(clean[0].fee, "5");
  assert.equal(clean[1].id, "coerce");
  assert.equal(clean[1].timestamp, null); // garbage timestamp coerces, never renders as fact
  assert.equal(clean[1].fee, "0"); // garbage fee coerces: it anchors no total in this app
  assert.equal(clean[1].extrinsic_id, null);
});
t("sanitizeTransfers gives id-less rows fact-derived ids and dedupes duplicate ids", () => {
  const clean = F.sanitizeTransfers([
    { amount: "1", from_id: "A", to_id: "B", block_height: 10, timestamp: null, fee: "0", extrinsic_id: null },
    { amount: "2", from_id: "A", to_id: "C", block_height: 11, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "dup", amount: "3", from_id: "A", to_id: "D", block_height: 12, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "dup", amount: "3", from_id: "A", to_id: "D", block_height: 12, timestamp: null, fee: "0", extrinsic_id: null },
  ]);
  assert.equal(clean.length, 3);
  assert.ok(clean[0].id && clean[1].id && clean[0].id !== clean[1].id);
});
t("sanitizeTransfers of a non-array is empty, never a throw", () => {
  assert.deepEqual(F.sanitizeTransfers("garbage"), []);
  assert.deepEqual(F.sanitizeTransfers(null), []);
  assert.deepEqual(F.sanitizeTransfers(undefined), []);
});
t("buildGraph survives a poisoned payload instead of throwing", () => {
  const g = F.buildGraph([
    { id: "a", amount: "12.5", from_id: "x", to_id: "y", block_height: 9, timestamp: null, fee: "0", extrinsic_id: null },
    { id: "b", amount: "1000", from_id: "x", to_id: "y", block_height: 9, timestamp: null, fee: "garbage", extrinsic_id: null },
    null,
  ]);
  assert.equal(g.rows.length, 1);
  assert.equal(g.rows[0].amount, 1000n);
  assert.equal(g.rows[0].fee, 0n);
});
t("trace keeps every id-less transfer (no shared undefined seenEdge key)", () => {
  const g = F.buildGraph([
    { amount: "1000000000000", from_id: "A", to_id: "B", block_height: 10, timestamp: null, fee: "0", extrinsic_id: null },
    { amount: "2000000000000", from_id: "A", to_id: "C", block_height: 11, timestamp: null, fee: "0", extrinsic_id: null },
  ]);
  const tr = F.trace(g, "A", { direction: "out", maxHops: 1, maxNodes: 100 });
  assert.equal(tr.edges.length, 2);
  assert.ok(tr.nodes.has("B") && tr.nodes.has("C"));
});
t("sanitizeSnapshotMeta validates heights and capture time", () => {
  const okMeta = F.sanitizeSnapshotMeta({ window_from: 182261, chain_height: 197261, captured_at: "2026-10-10T02:21:57.562Z" });
  assert.equal(okMeta.window_from, 182261);
  assert.equal(okMeta.chain_height, 197261);
  assert.equal(F.sanitizeSnapshotMeta({ window_from: { evil: 1 }, chain_height: 10, captured_at: "2026-10-10T00:00:00Z" }), null);
  assert.equal(F.sanitizeSnapshotMeta({ window_from: 50, chain_height: 10, captured_at: "2026-10-10T00:00:00Z" }), null);
  assert.equal(F.sanitizeSnapshotMeta({ window_from: 1, chain_height: 10, captured_at: "not-a-date" }), null);
  assert.equal(F.sanitizeSnapshotMeta(null), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
