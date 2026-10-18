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

test("endpoint length bound before regex/storage/socket (white-hat)", () => {
  // isWsUrl regex-tested the WHOLE paste unbounded, and the accepted
  // value is persisted to localStorage and handed to new WebSocket.
  // Cap 2,048 is >4x the largest genuine endpoint (hostname ≤253 per
  // RFC 1035 + scheme/port/path/key material well under 500 total).
  assert.equal(C.MAX_ENDPOINT_URL_CHARS, 2048);
  const atCap = "ws://127.0.0.1:9944/" + "p".repeat(2048 - "ws://127.0.0.1:9944/".length);
  assert.equal(atCap.length, 2048);
  assert.ok(C.isWsUrl(atCap), "exactly-cap endpoint still validates");
  assert.ok(!C.isWsUrl(atCap + "p"));
  assert.ok(!C.isWsUrl("wss://" + "a".repeat(20000000)));
  let err = null;
  try { C.normalizeEndpoint("wss://" + "a".repeat(20000000)); } catch (e) { err = e; }
  assert.ok(err && /too long/.test(err.message) && /20000006/.test(err.message) && /2048/.test(err.message), err && err.message);
});

test("checkAddress uses prefix 189", () => {
  const good = "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa";
  assert.deepEqual(C.checkAddress(good, (a) => S.ss58Decode(a)), { ok: true });
  const bad = C.checkAddress("qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYb", (a) => S.ss58Decode(a));
  assert.equal(bad.ok, false);
  assert.equal(C.checkAddress("", (a) => S.ss58Decode(a)).ok, false);
  // reserved SS58 prefix forms are rejected by the codec itself
  assert.equal(S.ss58Decode("KrwtH2a2bBuev66iHckW65v3DvQBeC9CZcWeFfFWLRv8UHKC").ok, false);
  assert.equal(S.ss58Decode("LAJs41CEk4XqPGK71DPaDniKANq4ok2m8SB36iBQizhbKEDJ").ok, false);
  // A valid non-189 address is rejected by prefix
  const polkadotish = C.checkAddress(good, () => ({ prefix: 0 }));
  assert.equal(polkadotish.ok, false);
  assert.match(polkadotish.reason, /prefix 0/);
});

test("sanitizeWatchers enforces the add form's rules at load", () => {
  const good = "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa";
  const dec = (a) => S.ss58Decode(a);
  const out = C.sanitizeWatchers([
    { address: good, label: "treasury" },
    { address: good, label: "duplicate dropped" },
    { address: "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYb", label: "bad checksum" },
    { address: "not-an-address", label: "garbage" },
    { address: 42, label: "numeric" },
    null, "string entry", { label: "no address" },
    { address: " " + good + " ", label: 7 },
  ], dec);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { address: good, label: "treasury" });
});

test("sanitizeWatchers caps label and list, tolerates non-arrays", () => {
  const good = "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa";
  const dec = (a) => S.ss58Decode(a);
  const one = C.sanitizeWatchers([{ address: good, label: "y".repeat(200) }], dec);
  assert.equal(one[0].label.length, 40);
  assert.deepEqual(C.sanitizeWatchers("nope", dec), []);
  assert.deepEqual(C.sanitizeWatchers(null, dec), []);
  assert.deepEqual(C.sanitizeWatchers(undefined, dec), []);
  // No decoder -> nothing can be checksum-verified, so nothing survives.
  assert.deepEqual(C.sanitizeWatchers([{ address: good, label: "x" }], null), []);
});

test("watcherRoom gates watcher creation at the load cap", () => {
  // sanitizeWatchers caps at load; addWatcher (the creation path, each
  // watcher a live subscription) must stop at the same cap in-session.
  assert.equal(C.watcherRoom(0), C.MAX_WATCHERS);
  assert.equal(C.watcherRoom(49), 1);
  assert.equal(C.watcherRoom(50), 0);
  assert.equal(C.watcherRoom(5000), 0);
  assert.equal(C.watcherRoom(NaN), 0);
  assert.equal(C.watcherRoom("x"), 0);
  assert.equal(C.watcherRoom(-3), 0);
});

test("parseTxWatchNotification validates upstream shape", () => {
  const raw = {
    tx_hash: "0x9a3cb7f1" + "ab".repeat(28),
    // Fixture corrected (round 2): the old "qzfromaddress000…" string is
    // 49 chars but padded with '0', which is not in the base58 alphabet —
    // no chain payload can contain it as an SS58-189 sender.
    from: "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa",
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

test("extrinsic hex length bound refuses over-cap input before parsing", () => {
  assert.equal(C.MAX_EXTRINSIC_HEX_CHARS, 1048576);
  // fail-closed room gate
  assert.equal(C.extrinsicHexRoom(0), 1048576);
  assert.equal(C.extrinsicHexRoom(1048576), 0);
  assert.equal(C.extrinsicHexRoom(1048577), 0);
  assert.equal(C.extrinsicHexRoom(-1), 0);
  assert.equal(C.extrinsicHexRoom(1.5), 0);
  assert.equal(C.extrinsicHexRoom("10"), 0);
  assert.equal(C.extrinsicHexRoom(NaN), 0);
  // exactly-cap inputs still work on both gated paths
  assert.equal(C.hexByteLen("0x" + "ff".repeat((1048576 - 2) / 2)), (1048576 - 2) / 2);
  assert.equal(C.validExtrinsicHex("0x" + "ab".repeat((1048576 - 2) / 2)), true);
  // cap+2 refused with size + cap named, before the regex
  assert.throws(() => C.hexByteLen("0x" + "ff".repeat(1048576 / 2)), /too long \(1048578 characters\) — the cap is 1048576 characters/);
  assert.throws(() => C.hexByteLen("0x" + "ff".repeat(10000000)), /too long \(20000002 characters\)/);
  assert.equal(C.validExtrinsicHex("0x" + "ab".repeat(1048576 / 2)), false);
  // an over-cap pool entry is skipped by the summarizer, genuine kept
  const s = C.summarizePool(["0x" + "ff".repeat(1048576 / 2), "0x" + "ee".repeat(50)]);
  assert.equal(s.valid, 1);
  assert.equal(s.totalBytes, 50);
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
test("int bound (Batch 195): decodePartialFee length gate before BigInt", () => {
  assert.throws(() => C.decodePartialFee({ partialFee: "0".repeat(596) + "7" }));
  assert.throws(() => C.decodePartialFee({ partialFee: "0x" + "0".repeat(596) + "7" }));
  assert.equal(C.decodePartialFee({ partialFee: "9".repeat(512) }), BigInt("9".repeat(512)));
  assert.throws(() => C.decodePartialFee({ partialFee: "9".repeat(2000000) }));
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

test("RPC answer validators: heights, hashes, subscription ids, extrinsics", () => {
  assert.equal(C.parseBlockNumber(256), 256);
  assert.equal(C.parseBlockNumber("256"), 256);
  assert.equal(C.parseBlockNumber("0x100"), 256);
  assert.equal(C.parseBlockNumber("garbage!!"), null);
  assert.equal(C.parseBlockNumber("0xZZ"), null);
  assert.equal(C.parseBlockNumber(1.5), null);
  assert.equal(C.parseBlockNumber(-3), null);
  assert.equal(C.parseBlockNumber({ number: 5 }), null);
  assert.equal(C.parseBlockNumber(null), null);
  assert.ok(C.isHash32("0x" + "ab".repeat(32)));
  assert.ok(!C.isHash32("0x1234"));
  assert.ok(!C.isHash32({ hash: 1 }));
  assert.ok(!C.isHash32("ab".repeat(32))); // missing 0x
  assert.equal(C.validSubscriptionId("sub-1"), "sub-1");
  assert.equal(C.validSubscriptionId(7), "7");
  assert.equal(C.validSubscriptionId({ id: "evil" }), null);
  assert.equal(C.validSubscriptionId(""), null);
  assert.equal(C.validSubscriptionId(null), null);
  assert.equal(C.validSubscriptionId(1.5), null);
  assert.ok(C.validExtrinsicHex("0x" + "aa".repeat(100)));
  assert.ok(!C.validExtrinsicHex("garbage!!"));
  assert.ok(!C.validExtrinsicHex("0x123")); // odd length
  assert.ok(!C.validExtrinsicHex({ x: 1 }));
  assert.ok(!C.validExtrinsicHex("0x")); // no bytes
});

test("decodePartialFee rejects non-integer and negative fees", () => {
  assert.equal(C.decodePartialFee({ partialFee: "0" }), 0n);
  assert.equal(C.decodePartialFee({ partialFee: "0x10" }), 16n);
  assert.throws(() => C.decodePartialFee({ partialFee: "-5" }));
  assert.throws(() => C.decodePartialFee({ partialFee: -5 }));
  assert.throws(() => C.decodePartialFee({ partialFee: "1.5" }));
  assert.throws(() => C.decodePartialFee({ partialFee: 1.5 }));
  assert.throws(() => C.decodePartialFee({ partialFee: { fee: 1 } }));
  assert.throws(() => C.decodePartialFee({ partialFee: "1e3" }));
  assert.throws(() => C.decodePartialFee({ partialFee: "" }));
});

test("round 2 relations: bounded heights, positive in-cap amounts, strict SS58-189 from", () => {
  // Heights: fleet relation 1..10,000,000 in every encoding.
  assert.equal(C.parseBlockNumber(10000000), 10000000);
  assert.equal(C.parseBlockNumber(10000001), null);
  assert.equal(C.parseBlockNumber(99999999999), null);
  assert.equal(C.parseBlockNumber("99999999999"), null);
  assert.equal(C.parseBlockNumber("0x174876e7ff"), null); // 99,999,999,999 in hex
  assert.equal(C.parseBlockNumber(0), null);
  assert.equal(C.parseBlockNumber("0"), null);
  assert.equal(C.MAX_CHAIN_HEIGHT, 10000000);
  assert.equal(C.MAX_SUPPLY_PLANCKS, 21000000n * P);
  // Amounts: positive always; native capped at the 21M supply.
  const raw = {
    tx_hash: "0x9a3cb7f1" + "ab".repeat(28),
    from: "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa",
    amount: "5000000000000",
    asset_id: null,
  };
  const cap = (21000000n * P).toString();
  const over = (21000000n * P + 1n).toString();
  assert.equal(C.parseTxWatchNotification({ ...raw, amount: cap }).amountPlanck, 21000000n * P);
  assert.throws(() => C.parseTxWatchNotification({ ...raw, amount: "0" }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, amount: over }));
  assert.throws(() => C.parseTxWatchNotification({ ...raw, amount: "0", asset_id: 7 }));
  // An asset's supply is not QTC's: over-cap asset amounts still parse.
  assert.equal(C.parseTxWatchNotification({ ...raw, amount: over, asset_id: 7 }).amountPlanck, 21000000n * P + 1n);
  // From: strict SS58-189 shape only ('0' is not base58; other chains are not senders here).
  assert.equal(C.parseTxWatchNotification({ ...raw, from: "qzfromaddress000000000000000000000000000000000000" }).from, "");
  assert.equal(C.parseTxWatchNotification({ ...raw, from: "aaaaaaaaaaaaaaaaaaaa" }).from, "");
  assert.equal(C.parseTxWatchNotification({ ...raw, from: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }).from, "");
});

test("parseTxWatchNotification sanitizes a garbage from", () => {
  const raw = {
    tx_hash: "0x9a3cb7f1" + "ab".repeat(28),
    from: "qzof7g8enozx1zxZupPoKdssf88hjDPDZGGNfxn4eDrFGxGYa",
    amount: "5000000000000",
    asset_id: null,
  };
  assert.equal(C.parseTxWatchNotification(raw).from, raw.from);
  assert.equal(C.parseTxWatchNotification({ ...raw, from: "!!!not-an-address!!!" }).from, "");
  assert.equal(C.parseTxWatchNotification({ ...raw, from: { addr: 1 } }).from, "");
  assert.equal(C.parseTxWatchNotification({ ...raw, from: "<script>alert(1)</script>" }).from, "");
  assert.equal(C.formatCompact(-5n), "—");
});

/* Batch 194: amount-input length bound — parseQtcToPlancks BigInt-converted
 * an unbounded digit string whole (superlinear freeze). */
test("amount bound: parseQtcToPlancks length gate", () => {
  assert.equal(C.parseQtcToPlancks("1.5"), 1500000000000n);
  assert.throws(() => C.parseQtcToPlancks("9".repeat(600)), /512/);
  assert.throws(() => C.parseQtcToPlancks("0".repeat(600) + "1.5"), /512/);
  assert.throws(() => C.parseQtcToPlancks("9".repeat(2000000)), /512/);
  assert.equal(typeof C.parseQtcToPlancks("9".repeat(512)), "bigint");
});
