#!/usr/bin/env node
/* QTC Mempool Desk — logic tests (node:test). Run: node tests/run-tests.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const C = require(join(here, "..", "js", "rpc-core.js"));
const S = require(join(here, "..", "js", "ss58.js"));
const P = 1000000000000n;

test("planck math round-trips", () => {
  assert.equal(C.parseQtcToPlancks("1"), P);
  assert.equal(C.parseQtcToPlancks("1.5"), 1500000000000n);
  assert.equal(C.parseQtcToPlancks("0.000000000001"), 1n);
  assert.equal(C.parseQtcToPlancks("1,234.5678"), 1234567800000000n);
  assert.throws(() => C.parseQtcToPlancks("abc"));
  assert.throws(() => C.parseQtcToPlancks("1.1234567890123"));
  assert.throws(() => C.parseQtcToPlancks("-5"));
  assert.equal(C.formatQtc(P), "1");
  assert.equal(C.formatQtc(1500000000000n), "1.5");
  assert.equal(C.formatQtc(1234567800000000n), "1,234.5678");
  assert.equal(C.formatQtc(0n), "0");
  assert.equal(C.formatQtc("2130000000000"), "2.13");
});

test("formatCompact buckets", () => {
  assert.equal(C.formatCompact(450n * P), "450 QTC");
  assert.equal(C.formatCompact(1500n * P), "1.50K QTC");
  assert.equal(C.formatCompact(2300000n * P), "2.30M QTC");
});

test("buildRpc shapes", () => {
  C.resetId();
  const a = C.buildRpc("system_chain");
  assert.equal(a.jsonrpc, "2.0");
  assert.equal(a.method, "system_chain");
  assert.deepEqual(a.params, []);
  assert.equal(a.id, 1);
  const b = C.buildTxWatchSubscribe("qzabc");
  assert.equal(b.method, "txWatch_watchAddress");
  assert.deepEqual(b.params, ["qzabc"]);
  assert.equal(b.id, 2);
  const c = C.buildTxWatchUnsubscribe("sub-1");
  assert.equal(c.method, "txWatch_unwatchAddress");
  const d = C.buildPendingExtrinsics();
  assert.equal(d.method, "author_pendingExtrinsics");
  const e = C.buildPaymentQueryInfo("0xdeadbeef");
  assert.equal(e.method, "payment_queryInfo");
  assert.deepEqual(e.params, ["0xdeadbeef"]);
  const h = C.buildHandshake();
  assert.equal(h.length, 3);
  assert.equal(h[0].method, "system_chain");
  assert.throws(() => C.buildRpc(""));
});

test("endpoint validation", () => {
  assert.ok(C.isWsUrl("wss://rpc.quantus.network"));
  assert.ok(C.isWsUrl("ws://127.0.0.1:9944"));
  assert.ok(C.isWsUrl("  wss://example.com/rpc  "));
  assert.ok(!C.isWsUrl("https://rpc.quantus.network"));
  assert.ok(!C.isWsUrl("wss://"));
  assert.ok(!C.isWsUrl("not a url"));
  assert.ok(!C.isWsUrl(null));
  assert.equal(C.normalizeEndpoint("  wss://rpc.quantus.network "), "wss://rpc.quantus.network");
  assert.throws(() => C.normalizeEndpoint("http://x"));
});

test("checkAddress uses prefix 189", () => {
  const good = "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa";
  assert.deepEqual(C.checkAddress(good, (a) => S.ss58Decode(a)), { ok: true });
  const bad = C.checkAddress("qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYb", (a) => S.ss58Decode(a));
  assert.equal(bad.ok, false);
  assert.equal(C.checkAddress("", (a) => S.ss58Decode(a)).ok, false);
  // A valid non-189 address is rejected by prefix
  const polkadotish = C.checkAddress(good, () => ({ prefix: 0 }));
  assert.equal(polkadotish.ok, false);
  assert.match(polkadotish.reason, /prefix 0/);
});

test("parseTxWatchNotification validates upstream shape", () => {
  const raw = {
    tx_hash: "0x9a3cb7f1" + "ab".repeat(28),
    from: "qzfromaddress000000000000000000000000000000000000",
    amount: "5000000000000",
    asset_id: null,
  };
  const n = C.parseTxWatchNotification(raw);
  assert.equal(n.txHash, raw.tx_hash);
  assert.equal(n.amountPlanck, 5000000000000n);
  assert.equal(n.assetId, null);
  assert.equal(typeof n.receivedAt, "number");
  const asset = C.parseTxWatchNotification({ ...raw, asset_id: 7 });
  assert.equal(asset.assetId, 7);
  assert.throws(() => C.parseTxWatchNotification({ ...raw, tx_hash: "nope" }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, tx_hash: "0x1234" }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, amount: "1.5" }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, amount: "-3" }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, asset_id: -1 }));
  assert.throws(() => C.parseTxWatchNotification(null));
  assert.equal(C.assetLabel(null), "native QTC");
  assert.equal(C.assetLabel(3), "asset #3");
});

test("hexByteLen and summarizePool", () => {
  assert.equal(C.hexByteLen("0x" + "ff".repeat(7000)), 7000);
  assert.throws(() => C.hexByteLen("0x123"));
  assert.throws(() => C.hexByteLen("zz"));
  const pool = ["0x" + "aa".repeat(100), "0x" + "bb".repeat(300), "garbage"];
  const s = C.summarizePool(pool);
  assert.equal(s.count, 3);
  assert.equal(s.valid, 2);
  assert.equal(s.totalBytes, 400);
  assert.equal(s.avgBytes, 200);
  assert.equal(s.maxBytes, 300);
  const empty = C.summarizePool([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.avgBytes, 0);
});

test("sortPoolByFee and decodePartialFee", () => {
  const rows = [
    { hex: "0xaa", bytes: 10, fee: null },
    { hex: "0xbb", bytes: 20, fee: 500n },
    { hex: "0xcc", bytes: 30, fee: 900n },
    { hex: "0xdd", bytes: 40, fee: null },
  ];
  const sorted = C.sortPoolByFee(rows);
  assert.deepEqual(sorted.map((r) => r.hex), ["0xcc", "0xbb", "0xdd", "0xaa"]); // fee-known first, then null-fee by size
  assert.equal(C.decodePartialFee({ partialFee: "12345" }), 12345n);
  assert.equal(C.decodePartialFee({ partialFee: 999 }), 999n);
  assert.throws(() => C.decodePartialFee({}));
  assert.throws(() => C.decodePartialFee(null));
});

test("timing helpers", () => {
  assert.equal(C.formatAge(45000), "45s");
  assert.equal(C.formatAge(5 * 60000), "5m");
  assert.equal(C.formatAge(90 * 60000), "1h 30m");
  assert.equal(C.formatAge(3 * 86400000), "3d 0h");
  assert.equal(C.formatAge(-1), "—");
  const now = Date.now();
  assert.equal(C.poolHealth(now - 5000, now), "live");
  assert.equal(C.poolHealth(now - 30000, now), "stale");
  assert.equal(C.poolHealth(now - 90000, now), "dead");
  assert.equal(C.poolHealth(0, now), "dead");
  assert.equal(C.backoffMs(0), 1000);
  assert.equal(C.backoffMs(1), 2000);
  assert.equal(C.backoffMs(4), 16000);
  assert.equal(C.backoffMs(10), 30000);
  assert.equal(C.backoffMs(99), 30000);
});

test("shorten and txWatchSupported", () => {
  assert.equal(C.shorten("0x" + "a".repeat(60), 10, 8), "0xaaaaaaaa…aaaaaaaa");
  assert.equal(C.shorten("short"), "short");
  const sup = C.txWatchSupported();
  assert.ok(sup.length >= 3);
  assert.ok(sup.some((s) => s.includes("batch_all")));
});

test("EXPECTED_SS58_PREFIX is 189", () => {
  assert.equal(C.EXPECTED_SS58_PREFIX, 189);
});
