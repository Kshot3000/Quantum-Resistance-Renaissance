/* Unit tests for the QTC Block Explorer pure helpers. Run: node tests/explorer.test.js */
var assert = require("assert");
var A = require("../app.js");

var pass = 0, fail = 0;
function t(name, fn){
  try { fn(); pass++; }
  catch (e){ fail++; console.error("FAIL " + name + ": " + e.message); }
}

/* --- esc --- */
t("esc escapes html", function(){
  assert.strictEqual(A.esc('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.strictEqual(A.esc(null), "");
  assert.strictEqual(A.esc(123), "123");
});

/* --- fmtInt --- */
t("fmtInt commas", function(){
  assert.strictEqual(A.fmtInt(135565), "135,565");
  assert.strictEqual(A.fmtInt(null), "—");
  assert.strictEqual(A.fmtInt(0), "0");
});

/* --- fmtQTC (10^12 planck) --- */
t("fmtQTC exact values", function(){
  assert.strictEqual(A.fmtQTC("310000000000"), "0.31");
  assert.strictEqual(A.fmtQTC("1000000000000"), "1");
  assert.strictEqual(A.fmtQTC("3552989979"), "0.0035");
  assert.strictEqual(A.fmtQTC("154164656048"), "0.1541");
  assert.strictEqual(A.fmtQTC("0"), "0");
  assert.strictEqual(A.fmtQTC(null), "—");
  assert.strictEqual(A.fmtQTC("21000000000000000000"), "21,000,000");
});

/* --- ageFmt --- */
t("ageFmt buckets", function(){
  assert.strictEqual(A.ageFmt(0, 45000), "45s ago");
  assert.strictEqual(A.ageFmt(0, 5 * 60000), "5m ago");
  assert.strictEqual(A.ageFmt(0, 3 * 3600000), "3h ago");
  assert.strictEqual(A.ageFmt(0, 2 * 86400000), "2d ago");
  assert.strictEqual(A.ageFmt(99999, 10000), "0s ago");
});

/* --- shortHash --- */
t("shortHash truncates", function(){
  var h = "0x" + "ab".repeat(32);
  assert.strictEqual(A.shortHash(h), "0xabababab…" + "ab".repeat(4));
  assert.strictEqual(A.shortHash("short"), "short");
  assert.strictEqual(A.shortHash(null), "—");
});

/* --- input classification --- */
t("isHeight", function(){
  assert.ok(A.isHeight("135564"));
  assert.ok(!A.isHeight("0x1234"));
  assert.ok(!A.isHeight("qzabc"));
  assert.ok(!A.isHeight(""));
});
t("isHex64", function(){
  assert.ok(A.isHex64("0x" + "ab".repeat(32)));
  assert.ok(!A.isHex64("0x1234"));
  assert.ok(!A.isHex64("135564"));
});
t("isQz", function(){
  assert.ok(A.isQz("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv"));
  assert.ok(!A.isQz("qzshort"));
  assert.ok(!A.isQz("prl1abc"));
});

/* --- detectQuery --- */
t("detectQuery kinds", function(){
  assert.deepStrictEqual(A.detectQuery("135564"), { kind: "block", key: "135564" });
  var r = A.detectQuery("0x" + "AB".repeat(32));
  assert.strictEqual(r.kind, "hash");
  assert.strictEqual(r.key, "0x" + "ab".repeat(32));
  r = A.detectQuery("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv");
  assert.strictEqual(r.kind, "account");
  assert.strictEqual(A.detectQuery("   ").kind, "empty");
  assert.strictEqual(A.detectQuery("garbage!").kind, "unknown");
});

/* --- routeFor --- */
t("routeFor maps to hash paths", function(){
  assert.strictEqual(A.routeFor("135564"), "#/block/135564");
  assert.strictEqual(A.routeFor("0x" + "ab".repeat(32)), "#/hash/" + "0x" + "ab".repeat(32));
  assert.strictEqual(A.routeFor("qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv"), "#/account/qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv");
  assert.strictEqual(A.routeFor("junk!"), null);
  assert.strictEqual(A.routeFor(""), null);
});

/* --- parseRoute --- */
t("parseRoute views", function(){
  assert.deepStrictEqual(A.parseRoute("#/block/135564"), { view: "block", key: "135564" });
  assert.deepStrictEqual(A.parseRoute("#/extrinsic/0xabc"), { view: "extrinsic", key: "0xabc" });
  assert.deepStrictEqual(A.parseRoute("#/account/qzxyz"), { view: "account", key: "qzxyz" });
  assert.deepStrictEqual(A.parseRoute("#/hash/0xabc"), { view: "hash", key: "0xabc" });
  assert.deepStrictEqual(A.parseRoute(""), { view: "home", key: "" });
  assert.deepStrictEqual(A.parseRoute("#/"), { view: "home", key: "" });
  assert.deepStrictEqual(A.parseRoute("#/nope/1"), { view: "home", key: "" });
});

/* --- prettyArgs --- */
t("prettyArgs formats json", function(){
  var out = A.prettyArgs('{"dest":{"__kind":"Id","value":"qzabc"},"value":"110946499011"}');
  assert.ok(out.indexOf('"value": "110946499011"') !== -1);
  assert.strictEqual(A.prettyArgs(null), "(no arguments)");
  assert.strictEqual(A.prettyArgs("{not json"), "{not json");
});

/* --- load-boundary validation (indexer responses are untrusted) --- */
t("fmt hardening: garbage never becomes a figure", function(){
  assert.strictEqual(A.fmtQTC("abc"), "—");
  assert.strictEqual(A.fmtQTC("1.5"), "—");
  assert.strictEqual(A.fmtQTC("6.5e18"), "—");
  assert.strictEqual(A.fmtQTC(""), "—");
  assert.strictEqual(A.fmtInt(-5), "—");
  assert.strictEqual(A.fmtInt(194626.9), "—");
  assert.strictEqual(A.fmtInt("garbage"), "—");
  assert.strictEqual(A.fmtInt("135564"), "135,564");
});
t("validators: shapes", function(){
  assert.strictEqual(A.validHeight(135564), 135564);
  assert.strictEqual(A.validHeight(0), null);
  assert.strictEqual(A.validHeight(-5), null);
  assert.strictEqual(A.validHeight(1.5), null);
  assert.strictEqual(A.validHeight("oops"), null);
  assert.strictEqual(A.validCount(0), 0);
  assert.strictEqual(A.validPlanck("310000000000"), "310000000000");
  assert.strictEqual(A.validPlanck("1.5"), null);  assert.strictEqual(A.validPlanck("1.5"), null);
  // Batch 195: integer-string length bound before BigInt.
  assert.strictEqual(A.validPlanck("0".repeat(596) + "7"), null);
  assert.strictEqual(A.validPlanck("9".repeat(512)), "9".repeat(512));
  assert.strictEqual(A.validPlanck("9".repeat(2000000)), null);
  assert.strictEqual(A.validPlanck(-1), null);
  assert.ok(A.validTimestamp("2026-09-29T19:00:00.792+00:00"));
  assert.strictEqual(A.validTimestamp("garbage!!"), null);
  assert.strictEqual(A.validTimestamp(12345), null);
});
var GOOD_MINER = "qzmsbecAqfvgBYAtxKwSkbLTvsUrwPGykaVFvZpAf9Zj3SErv";
var GOOD_SENDER = "qzo4QjZzBFC4gL72EjtG7kQkemGmP67wWmruLLN9sgMNAQSzb";
t("cleanBlockRow drops poison, keeps good rows", function(){
  var good = { height: 135568, hash: "0x" + "ab".repeat(32), timestamp: "2026-09-29T19:00:20.000+00:00", reward: "310000000000", mined_by_id: GOOD_MINER, extrinsics_aggregate: { aggregate: { count: '<b id="pwn">X</b>' } } };
  var c = A.cleanBlockRow(good);
  assert.ok(c && c.height === 135568 && c.extrinsicsCount === null); // markup count -> dash, not injection
  assert.strictEqual(A.cleanBlockRow({ ...good, reward: "abc" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, timestamp: "garbage" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, height: 135568.9 }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, mined_by_id: "not-an-address" }), null);
  assert.strictEqual(A.cleanBlockRow(null), null);
});
t("cleanTransferRow drops poison", function(){
  var good = { id: "0000135565-6452c-000004", amount: "310000000000", from_id: GOOD_SENDER, to_id: GOOD_MINER, block_height: 135565, timestamp: "2026-09-29T19:00:08.755+00:00" };
  assert.ok(A.cleanTransferRow(good));
  assert.strictEqual(A.cleanTransferRow({ ...good, amount: "oops" }), null);
  assert.strictEqual(A.cleanTransferRow({ ...good, block_height: '"><svg onload=1>' }), null);
  assert.strictEqual(A.cleanTransferRow({ ...good, from_id: "garbage" }), null);
});
t("cleanHome: malformed stats fail, poisoned rows drop", function(){
  var home = { stats: { block_height: 135568, total_accounts: 6595, total_immediate_transfers: 154203, total_scheduled_transfers: 12 },
    blocks: [], transfers: [] };
  assert.ok(A.cleanHome(home));
  assert.strictEqual(A.cleanHome({ ...home, stats: { ...home.stats, block_height: "oops" } }), null);
  assert.strictEqual(A.cleanHome(null), null);
  assert.strictEqual(A.cleanHome({ ...home, blocks: {} }), null);
});
t("cleanAccount / cleanExtrinsicRow boundaries", function(){
  assert.ok(A.cleanAccount({ free: "1000", frozen: "0", reserved: "0" }));
  assert.strictEqual(A.cleanAccount({ free: "1.5", frozen: "0", reserved: "0" }), null);
  var x = { id: "0x" + "ab".repeat(32), index_in_block: 1, pallet: "Balances", call: "transfer_allow_death", signer_id: GOOD_SENDER, success: true, fee: "3552989979", args: "{}" };
  assert.ok(A.cleanExtrinsicRow(x));
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, index_in_block: "<b>pwn</b>" }), null);
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, fee: "abc" }), null);
  assert.strictEqual(A.cleanExtrinsicRow({ ...x, success: "yes" }), null);
});

/* --- round 2: relations, not just shapes --- */
var TS_OLD = "2026-09-29T19:00:20.000+00:00";
t("round2 validators: fleet height / chain-time / strict address", function(){
  assert.strictEqual(A.validHeight(9007199254740991), null); // 2^53-1 painted as fact pre-fix
  assert.strictEqual(A.validHeight(10000001), null);
  assert.strictEqual(A.validHeight("007"), null);
  assert.strictEqual(A.validHeight("204204"), 204204);
  assert.strictEqual(A.validTimestamp("2025-12-31T00:00:00.000+00:00"), null); // pre-genesis
  assert.strictEqual(A.validTimestamp(new Date(Date.now() + 2 * 86400000).toISOString()), null); // future
  assert.ok(A.validTimestamp(TS_OLD));
  assert.strictEqual(A.validAddress(GOOD_MINER), GOOD_MINER);
  assert.strictEqual(A.validAddress("qz0OIl" + "a".repeat(43)), null); // non-base58 chars passed the loose isQz
  assert.strictEqual(A.validAddress("qzshort"), null);
});
t("round2 rewardPlausible: emission schedule bounds", function(){
  assert.ok(A.rewardPlausible(135568, "310000000000"));
  assert.ok(A.rewardPlausible(135568, "300000000000"));
  assert.strictEqual(A.rewardPlausible(135568, "999000000000000"), false); // 999 QTC
  assert.strictEqual(A.rewardPlausible(135568, "0"), false);
  assert.strictEqual(A.rewardPlausible(135568, "200000000000"), false); // below schedule - 0.01
});
t("round2 cleanBlockRow: reward/timestamp/address relations", function(){
  var good = { height: 135568, hash: "0x" + "ab".repeat(32), timestamp: TS_OLD, reward: "310000000000", mined_by_id: GOOD_MINER, extrinsics_aggregate: { aggregate: { count: 0 } } };
  assert.ok(A.cleanBlockRow(good));
  assert.strictEqual(A.cleanBlockRow({ ...good, reward: "999000000000000" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, timestamp: "2027-06-01T00:00:00.000+00:00" }), null);
  assert.strictEqual(A.cleanBlockRow({ ...good, mined_by_id: "qz0OIl" + "a".repeat(43) }), null);
});
t("round2 cleanTransferRow: supply cap", function(){
  var good = { id: "0000135565-6452c-000004", amount: "310000000000", from_id: GOOD_SENDER, to_id: GOOD_MINER, block_height: 135565, timestamp: TS_OLD };
  assert.ok(A.cleanTransferRow(good));
  assert.strictEqual(A.cleanTransferRow({ ...good, amount: "100000000000000000000" }), null); // 100M QTC
  assert.strictEqual(A.cleanTransferRow({ ...good, fee: "100000000000000000000" }), null);
});
t("round2 cleanHome: head/order/limit relations", function(){
  var stats = { block_height: 135568, total_accounts: 6595, total_immediate_transfers: 154203, total_scheduled_transfers: 12 };
  var b1 = { height: 135568, hash: "0x" + "ab".repeat(32), timestamp: "2026-09-29T19:00:20.000+00:00", reward: "310000000000", mined_by_id: GOOD_MINER, extrinsics_aggregate: { aggregate: { count: 0 } } };
  var b2 = { ...b1, height: 135567, hash: "0x" + "cd".repeat(32), timestamp: "2026-09-29T19:00:08.000+00:00" };
  var b3 = { ...b1, height: 135569, hash: "0x" + "ef".repeat(32), timestamp: "2026-09-29T19:00:32.000+00:00" };
  assert.ok(A.cleanHome({ stats, blocks: [b1, b2], transfers: [] }));
  assert.strictEqual(A.cleanHome({ stats, blocks: [b2], transfers: [] }), null); // head != stats
  assert.strictEqual(A.cleanHome({ stats, blocks: [b1, { ...b2, height: 135566, timestamp: "2026-09-29T19:00:08.000+00:00" }, { ...b2, height: 135567, hash: "0x" + "34".repeat(32), timestamp: "2026-09-29T19:00:12.000+00:00" }], transfers: [] }), null); // height ascends mid-list
  assert.strictEqual(A.cleanHome({ stats, blocks: [b1, { ...b2, height: 135566, timestamp: "2026-09-29T19:00:25.000+00:00" }], transfers: [] }), null); // time ascends while height descends
  var dup = A.cleanHome({ stats, blocks: [b1, b1], transfers: [] });
  assert.ok(dup && dup.blocks.length === 1); // same block twice is one block
  var many = Array.from({ length: 11 }, (_, i) => ({ ...b1, height: 135568 - i, hash: "0x" + String(i).padStart(2, "0").repeat(32), timestamp: "2026-09-29T19:00:" + String(59 - i).padStart(2, "0") + ".000+00:00" }));
  assert.strictEqual(A.cleanHome({ stats, blocks: many, transfers: [] }), null); // over the query limit:10
  assert.strictEqual(A.cleanHome({ stats, blocks: [{ ...b1, reward: "999000000000000" }], transfers: [] }), null); // raw non-empty cleans to empty
  assert.ok(b3.height === 135569); // (fixture sanity)
});
t("round2 cleanAccount: balance sum cap + last_updated", function(){
  assert.strictEqual(A.cleanAccount({ free: "20000000000000000000", frozen: "0", reserved: "2000000000000000000" }), null); // 22M total
  var a = A.cleanAccount({ free: "1000", frozen: "0", reserved: "0", last_updated: 135568 });
  assert.ok(a && a.last_updated === 135568);
  assert.strictEqual(A.cleanAccount({ free: "1000", frozen: "0", reserved: "0", last_updated: "oops" }), null);
});
t("round2 cleanAccountData: involvement / order / limit relations", function(){
  var acctRaw = { free: "1000", frozen: "0", reserved: "0", last_updated: 135568 };
  var mine = { id: "0000135565-6452c-000004", amount: "1000", from_id: GOOD_SENDER, to_id: GOOD_MINER, block_height: 135565, timestamp: TS_OLD };
  var stranger = { ...mine, id: "0000135565-6452c-000005", from_id: GOOD_SENDER, to_id: "qzkJAZCwGaihdq9vAGvFeCfcKfvYNR1rG8VkXVRv2FjCo8CwQ" };
  var okData = A.cleanAccountData({ a: acctRaw, t: [mine], mined: { aggregate: { count: 2 } } }, GOOD_MINER);
  assert.ok(okData && okData.txs.length === 1 && okData.mined === 2);
  assert.strictEqual(A.cleanAccountData({ a: acctRaw, t: [stranger], mined: { aggregate: { count: 0 } } }, GOOD_MINER), null); // strangers only -> malformed, not empty history
  var mixed = A.cleanAccountData({ a: acctRaw, t: [mine, stranger], mined: { aggregate: { count: 0 } } }, GOOD_MINER);
  assert.ok(mixed && mixed.txs.length === 1); // stranger row drops alone
  assert.strictEqual(A.cleanAccountData({ a: acctRaw, t: [{ ...mine, id: "0000135570-6452c-000004", block_height: 135570 }], mined: { aggregate: { count: 0 } } }, GOOD_MINER), null); // above last_updated, cleans to empty
  var many = Array.from({ length: 26 }, (_, i) => ({ ...mine, id: String(135565 - i).padStart(10, "0") + "-6452c-" + String(i).padStart(6, "0"), block_height: 135565 - i }));
  assert.strictEqual(A.cleanAccountData({ a: acctRaw, t: many, mined: { aggregate: { count: 0 } } }, GOOD_MINER), null); // over limit:25
});
t("round2 cleanBlock: extrinsic index + event relations", function(){
  var raw = { height: 135568, hash: "0x" + "ab".repeat(32), timestamp: TS_OLD, reward: "310000000000", mined_by_id: GOOD_MINER,
    extrinsics: [
      { id: "0x" + "11".repeat(32), index_in_block: 1, pallet: "Balances", call: "transfer_allow_death", signer_id: GOOD_SENDER, success: true, fee: "1000", args: "{}" },
      { id: "0x" + "22".repeat(32), index_in_block: 1, pallet: "Balances", call: "transfer_allow_death", signer_id: GOOD_SENDER, success: true, fee: "1000", args: "{}" },
      { id: "0x" + "33".repeat(32), index_in_block: 2, pallet: "System", call: "remark", signer_id: null, success: true, fee: "0", args: "{}" } ],
    events: [
      { id: "ev-1", type: "TRANSFER", extrinsic_id: "0x" + "11".repeat(32) },
      { id: "ev-2", type: "TRANSFER", extrinsic_id: "0x" + "99".repeat(32) },
      { id: "ev-3", type: "EXTRINSIC_SUCCESS", extrinsic_id: null } ] };
  var b = A.cleanBlock(raw);
  assert.ok(b && b.extrinsics.length === 2); // duplicate index drops
  assert.ok(b && b.events.length === 2); // foreign event drops, block-level keeps
});
/* --- round 3: producer identity relations (verified live 2026-10-14) --- */
t("round3 cleanTransferRow: id height segment must restate block_height", function(){
  var good = { id: "0000135565-6452c-000004", amount: "310000000000", from_id: GOOD_SENDER, to_id: GOOD_MINER, block_height: 135565, timestamp: TS_OLD };
  assert.ok(A.cleanTransferRow(good));
  assert.ok(A.cleanTransferRow({ ...good, id: "0000000001-cb81a-000031", block_height: 1 })); // genesis form
  assert.strictEqual(A.cleanTransferRow({ ...good, id: "0000135566-6452c-000004" }), null); // segment names another block
  assert.strictEqual(A.cleanTransferRow({ ...good, id: "t-1" }), null); // non-producer string passed round 2
  assert.strictEqual(A.cleanTransferRow({ ...good, id: "135565-6452c-000004" }), null); // unpadded segment
  assert.strictEqual(A.cleanTransferRow({ ...good, id: "0000135565-6452C-000004" }), null); // producer hex is lowercase
  assert.strictEqual(A.cleanTransferRow({ ...good, id: "0000135565-6452c-00004" }), null); // short suffix
});
t("round3 cleanExtrinsic: block_id must restate block.height", function(){
  var x = { id: "0x" + "ab".repeat(32), index_in_block: 1, pallet: "Balances", call: "transfer_allow_death", signer_id: GOOD_SENDER, success: true, fee: "1000", args: "{}", timestamp: TS_OLD, block_id: "0000135564-e1166", block: { height: 135564 } };
  var c = A.cleanExtrinsic(x);
  assert.ok(c && c.blockHeight === 135564 && c.block_id === "0000135564-e1166");
  assert.strictEqual(A.cleanExtrinsic({ ...x, block_id: "0000135565-e1166" }), null); // names the next block
  assert.strictEqual(A.cleanExtrinsic({ ...x, block_id: "135564-e1166" }), null); // unpadded
  assert.strictEqual(A.cleanExtrinsic({ ...x, block_id: "garbage" }), null);
  assert.ok(A.cleanExtrinsic({ ...x, block_id: undefined, block: undefined })); // absent fields keep the old path
});
t("round3 cleanExtrinsicEvents: events must belong to the queried extrinsic", function(){
  var xid = "0x" + "ab".repeat(32);
  var evs = [
    { id: "ev-1", type: "TRANSFER", extrinsic_id: xid },
    { id: "ev-2", type: "TRANSFER", extrinsic_id: "0x" + "99".repeat(32) }, // foreign
    { id: "ev-3", type: "MINER_REWARD", extrinsic_id: null }, // block-level
    { id: "ev-1", type: "TRANSFER", extrinsic_id: xid }, // duplicate id
    { id: "ev-4", type: "EXTRINSIC_SUCCESS", extrinsic_id: xid } ];
  var out = A.cleanExtrinsicEvents(evs, xid);
  assert.ok(out && out.length === 2 && out[0].id === "ev-1" && out[1].id === "ev-4");
  assert.strictEqual(A.cleanExtrinsicEvents({}, xid), null); // non-array is malformed
  assert.deepStrictEqual(A.cleanExtrinsicEvents([], xid), []);
});
/* --- round 4: the block row's own producer identity (verified live 2026-10-15) --- */
t("round4 cleanBlock: block id must restate its own height", function(){
  var raw = { id: "0000135568-ab123", height: 135568, hash: "0x" + "ab".repeat(32), timestamp: TS_OLD, reward: "310000000000", mined_by_id: GOOD_MINER, extrinsics: [], events: [] };
  var b = A.cleanBlock(raw);
  assert.ok(b && b.id === "0000135568-ab123");
  assert.ok(A.cleanBlock({ ...raw, id: "0000000001-cb81a", height: 1 })); // genesis form
  assert.ok(A.cleanBlock({ ...raw, id: undefined })); // absent keeps the old path (home rows carry no id)
  assert.strictEqual(A.cleanBlock({ ...raw, id: "0000135569-ab123" }), null); // segment names another block
  assert.strictEqual(A.cleanBlock({ ...raw, id: "0000000001-cb81a" }), null); // genesis id at a later height
  assert.strictEqual(A.cleanBlock({ ...raw, id: "135568-ab123" }), null); // unpadded segment
  assert.strictEqual(A.cleanBlock({ ...raw, id: "0000135568-AB123" }), null); // producer hex is lowercase
  assert.strictEqual(A.cleanBlock({ ...raw, id: "b1" }), null); // free-form id
  assert.strictEqual(A.cleanBlock({ ...raw, id: "0000135568-ab123-000001" }), null); // transfer form, not block form
  assert.strictEqual(A.cleanBlock({ ...raw, id: 135568 }), null); // non-string id
});
t("round2 blockMatchesKey", function(){
  var b = { height: 135568, hash: "0x" + "AB".repeat(32) };
  assert.ok(A.blockMatchesKey(b, "135568"));
  assert.strictEqual(A.blockMatchesKey(b, "135569"), false);
  assert.ok(A.blockMatchesKey(b, "0x" + "ab".repeat(32)));
  assert.strictEqual(A.blockMatchesKey(b, "0x" + "cd".repeat(32)), false);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
