// Node unit tests for pages/distribution-planner/js/core.js
// Run: node tests/distribution.test.js
var assert = require("assert");
var vm = require("vm");
var fs = require("fs");

function loadJS(rel) {
  var ctx = { console: console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + "/../js/" + rel, "utf8"), ctx, { filename: rel });
  return ctx;
}

var coreCtx = loadJS("core.js");
var DistCore = coreCtx.DistCore;
var ss58 = loadJS("ss58.js").QSS58;

var wctx = { QTC_WORDLIST: null };
wctx.globalThis = wctx;
vm.createContext(wctx);
vm.runInContext(fs.readFileSync(__dirname + "/../js/wordlist.js", "utf8"), wctx);
var WORDLIST = wctx.QTC_WORDLIST;
var check = loadJS("checkphrase-core.js").QTC_CHECK;

var passed = 0, failed = 0;
var pending = [];
function t(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(function () { passed++; console.log("ok - " + name); },
        function (e) { failed++; console.error("FAIL - " + name + ": " + (e && e.message || e)); }));
    } else { passed++; console.log("ok - " + name); }
  } catch (e) { failed++; console.error("FAIL - " + name + ": " + (e && e.message || e)); }
}

// Real Quantus mainnet addresses (valid SS58, prefix 189) — public on-chain data.
var POOL  = "qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7";
var MSIG  = "qzjsuLN7Nhu4bjvmUbjSTr2ZTeZ7oRxXpQP9fdv6PcHUCRrVR";
var MINER = "qzowWAgbzjc2XfHY4vyEo2eVLKbknTESUFoXnisQuUh1x1koo";
var SMALL = "qzjvYrYuPNfhpwD1TTWKkPtkWc8j16U2aDauCvhm1qQGRt6dP";

/* ---------- amount parsing ---------- */
t("parseAmountToPlancks: whole and decimal QTC", function () {
  assert.strictEqual(DistCore.parseAmountToPlancks("1").plancks, BigInt("1000000000000"));
  assert.strictEqual(DistCore.parseAmountToPlancks("1.5").plancks, BigInt("1500000000000"));
  assert.strictEqual(DistCore.parseAmountToPlancks("0.000000000001").plancks, BigInt(1));
  assert.strictEqual(DistCore.parseAmountToPlancks("1,000.25").plancks, BigInt("1000250000000000"));
  assert.strictEqual(DistCore.parseAmountToPlancks("21").plancks, BigInt("21000000000000"));
});
t("parseAmountToPlancks: rejects bad input", function () {
  ["", "0", "0.0", "-1", "abc", "1.0000000000001", "1.2.3", "  "].forEach(function (s) {
    assert.strictEqual(DistCore.parseAmountToPlancks(s).ok, false, JSON.stringify(s));
  });
  assert.ok(/12/.test(DistCore.parseAmountToPlancks("1.0000000000001").error));
});
t("parseAmountToPlancks: total-supply cap (21M QTC hard cap)", function () {
  // No account can ever hold or send more QTC than will ever exist —
  // the same MAX_SUPPLY_QTC the SafeSend desk enforces. Exactly the cap
  // stays valid; one planck over is refused in the parser itself, so the
  // row path and the per-batch tip path (both call this parser) agree.
  assert.strictEqual(DistCore.MAX_SUPPLY_PLANCKS, BigInt("21000000000000000000"));
  var at = DistCore.parseAmountToPlancks("21000000");
  assert.strictEqual(at.ok, true);
  assert.strictEqual(at.plancks, BigInt("21000000000000000000"));
  ["21000000.000000000001", "150000000", "999999999999999999999"].forEach(function (s) {
    var r = DistCore.parseAmountToPlancks(s);
    assert.strictEqual(r.ok, false, s);
    assert.ok(/supply cap of 21,000,000/.test(r.error), s + " names the cap");
  });
});
t("validateRows: cumulative plan total over supply warns once, on the crossing row", function () {
  var rows = DistCore.parseInput(POOL + " 15000000\n" + MSIG + " 15000000\n" + SMALL + " 1");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  assert.strictEqual(v[0].ok, true);
  assert.ok(!v[0].warnings.some(function (w) { return /supply/.test(w); }), "row 1 clean");
  assert.strictEqual(v[1].ok, true);
  assert.ok(v[1].warnings.some(function (w) { return /plan total through this line exceeds the total QTC supply/.test(w); }), "crossing row warned");
  assert.ok(!v[2].warnings.some(function (w) { return /supply/.test(w); }), "warning fires once");
  var under = DistCore.validateRows(DistCore.parseInput(POOL + " 10000000\n" + MSIG + " 10000000"), ss58, check, WORDLIST);
  assert.ok(under.every(function (r) { return !r.warnings.some(function (w) { return /supply/.test(w); }); }), "under-supply plan unwarned");
  var over = DistCore.validateRows(DistCore.parseInput(POOL + " 150000000"), ss58, check, WORDLIST);
  assert.strictEqual(over[0].ok, false);
  assert.ok(/supply/.test(over[0].error), "single over-supply row refused");
});

/* ---------- SCALE compact lengths ---------- */
t("compactLenU128 matches SCALE compact encoding", function () {
  var c = DistCore.compactLenU128, B = BigInt;
  assert.strictEqual(c(B(0)), 1);
  assert.strictEqual(c(B(63)), 1);
  assert.strictEqual(c(B(64)), 2);
  assert.strictEqual(c(B(16383)), 2);
  assert.strictEqual(c(B(16384)), 4);
  assert.strictEqual(c(B(1073741823)), 4);
  assert.strictEqual(c(B(1073741824)), 5);
  assert.strictEqual(c(B("1000000000000")), 6);   // 1 QTC in plancks
  assert.strictEqual(c(B("1000000000000000000")), 9); // 1M QTC
  assert.strictEqual(c(B(2) ** B(128) - B(1)), 17);   // u128::MAX
});

/* ---------- input parsing ---------- */
t("parseInput handles space, comma, tab, header, comments", function () {
  var rows = DistCore.parseInput(
    "# community rewards\naddress,amount\n" +
    POOL + " 10\n" +
    MSIG + ",2.5\n" +
    MINER + "\t0.000000000001\n" +
    "\n" +
    "lonelyfield\n");
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].address, POOL);
  assert.strictEqual(rows[0].amountStr, "10");
  assert.strictEqual(rows[1].amountStr, "2.5");
  assert.strictEqual(rows[2].amountStr, "0.000000000001");
  assert.ok(/expected/.test(rows[3].error), "single-field row errors");
});

t("parseInput: comma thousand-separator amounts survive every separator form", function () {
  // parseAmountToPlancks accepts "1,000.25" (pinned above), so the field
  // splitter must deliver the whole amount token in CSV, space and tab
  // forms alike — the old every-comma split planned 1 QTC for ",1,500"
  // and glued ",500" onto the address in the spaced/tabbed forms.
  var cases = [
    [POOL + ",1,500", "1500000000000000"],
    [POOL + ", 1,500.25", "1500250000000000"],
    [POOL + " 1,500", "1500000000000000"],
    [POOL + "\t1,500", "1500000000000000"],
    [POOL + " 1,000.25", "1000250000000000"]
  ];
  cases.forEach(function (c) {
    var v = DistCore.validateRows(DistCore.parseInput(c[0]), ss58, check, WORDLIST);
    assert.strictEqual(v[0].ok, true, c[0]);
    assert.strictEqual(v[0].plancks, BigInt(c[1]), c[0]);
  });
});
t("parseInput: extra fields are an error row, never silently dropped", function () {
  [POOL + ",10,extra", POOL + " 10 extra", POOL + ",10 extra"].forEach(function (line) {
    var v = DistCore.validateRows(DistCore.parseInput(line), ss58, check, WORDLIST);
    assert.strictEqual(v[0].ok, false, line);
  });
  var rows = DistCore.parseInput(POOL + " 10 extra");
  assert.ok(/expected/.test(rows[0].error), "extra field names the expected shape");
});

/* ---------- address validation ---------- */
t("validateAddress accepts real Quantus addresses", function () {
  [POOL, MSIG, MINER, SMALL].forEach(function (a) {
    var v = DistCore.validateAddress(a, ss58);
    assert.strictEqual(v.ok, true, a);
  });
});
t("validateAddress rejects bad checksum / wrong prefix / bad chars", function () {
  var bad = POOL.slice(0, -1) + (POOL.slice(-1) === "7" ? "8" : "7");
  assert.strictEqual(DistCore.validateAddress(bad, ss58).ok, false);
  var generic = DistCore.validateAddress("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", ss58);
  assert.strictEqual(generic.ok, false);
  assert.ok(/prefix 42/.test(generic.error), "names the wrong prefix");
  assert.strictEqual(DistCore.validateAddress("qz00invalid!!", ss58).ok, false);
});

/* ---------- row validation ---------- */
t("validateRows: checkphrase, duplicates, dust", function () {
  var rows = DistCore.parseInput(
    POOL + " 10\n" + MSIG + " 0.000000000001\n" + POOL + " 5\n" +
    "notanaddress 3\n" + SMALL + " -2\n");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  assert.strictEqual(v[0].ok, true);
  assert.strictEqual(v[0].checkphrase, "list-bliss-asset-camp-portion");
  assert.strictEqual(v[0].plancks, BigInt("10000000000000"));
  assert.strictEqual(v[1].ok, true);
  assert.ok(v[1].warnings.some(function (w) { return /dust/.test(w); }), "dust warned");
  assert.ok(v[2].warnings.some(function (w) { return /duplicate of line 1/.test(w); }), "dup warned");
  assert.strictEqual(v[3].ok, false);
  assert.strictEqual(v[4].ok, false);
});

/* ---------- batching ---------- */
t("planBatches splits at the batch size with exact totals", function () {
  var rows = [];
  for (var i = 0; i < 600; i++)
    rows.push({ line: i + 1, address: POOL, plancks: BigInt("1000000000000"), ok: true });
  var batches = DistCore.planBatches(rows, 256);
  assert.strictEqual(batches.length, 3);
  assert.strictEqual(batches[0].rows.length, 256);
  assert.strictEqual(batches[2].rows.length, 88);
  assert.strictEqual(batches[0].totalPlancks, BigInt(256) * BigInt("1000000000000"));
  var grand = batches.reduce(function (a, b) { return a + b.totalPlancks; }, BigInt(0));
  assert.strictEqual(grand, BigInt(600) * BigInt("1000000000000"));
});

/* ---------- fee floor math ---------- */
t("estimateBatchFee: byte model is exact and documented", function () {
  var batch = { index: 1,
    rows: [{ plancks: BigInt("1000000000000") }], // 1 QTC -> compact len 6
    totalPlancks: BigInt("1000000000000") };
  var f = DistCore.estimateBatchFee(batch, "ml-dsa-65");
  // call: 1+1+33+6 = 41; wrapper: 1+1+compact(1)=3; overhead: 1+3309+33+16 = 3359
  assert.strictEqual(f.callBytes, 41);
  assert.strictEqual(f.wrapperBytes, 3);
  assert.strictEqual(f.overheadBytes, 3359);
  assert.strictEqual(f.totalBytes, 3403);
  assert.strictEqual(f.feePlancks, BigInt(3403) * BigInt(100000));
  var f87 = DistCore.estimateBatchFee(batch, "ml-dsa-87");
  assert.strictEqual(f87.totalBytes, 3403 - 3309 + 4627);
  assert.ok(f87.feePlancks > f.feePlancks, "ML-DSA-87 costs more length fee");
});

/* ---------- export generation ---------- */
t("buildBatchJson matches the CLI batch-file format exactly", function () {
  var batch = { index: 1,
    rows: [
      { address: POOL, plancks: BigInt("1000000000000") },
      { address: MSIG, plancks: BigInt("2500000000000") }
    ],
    totalPlancks: BigInt("3500000000000") };
  var parsed = JSON.parse(DistCore.buildBatchJson(batch));
  assert.deepStrictEqual(parsed, [
    { to: POOL, amount: "1000000000000" },
    { to: MSIG, amount: "2500000000000" }
  ]);
});
t("buildRunScript emits exact CLI commands", function () {
  var batches = [
    { index: 1, rows: new Array(2), totalPlancks: BigInt("2000000000000") },
    { index: 2, rows: new Array(1), totalPlancks: BigInt("500000000000") }
  ];
  var sh = DistCore.buildRunScript(batches, "treasury", "0.1");
  assert.ok(sh.indexOf("quantus batch config --limits") >= 0);
  assert.ok(sh.indexOf("quantus batch send --from 'treasury' --batch-file transfers-batch-1.json --tip '0.1'") >= 0);
  assert.ok(sh.indexOf("transfers-batch-2.json") >= 0);
  assert.ok(sh.indexOf("batch_all") >= 0, "mentions atomicity");
  var sh2 = DistCore.buildRunScript(batches, "", "");
  assert.ok(sh2.indexOf("--from 'my_wallet'") >= 0);
  assert.ok(sh2.indexOf("--tip") < 0, "no tip flag when empty");
});

/* ---------- formatting ---------- */
t("formatQTC formats plancks exactly", function () {
  assert.strictEqual(DistCore.formatQTC(BigInt("1500000000000")), "1.5");
  assert.strictEqual(DistCore.formatQTC(BigInt("1000000000000")), "1");
  assert.strictEqual(DistCore.formatQTC(BigInt("5498465001000000000")), "5,498,465.001");
  assert.strictEqual(DistCore.formatQTC(BigInt(340300000)), "0.0003403");
  assert.strictEqual(DistCore.formatQTC6(BigInt(1)), "0.000000");
});

/* ---------- fast checkphrase path == reference ---------- */
t("wordsFromKey over WebCrypto PBKDF2 matches the reference phrase", async function () {
  var subtle = require("crypto").webcrypto.subtle;
  var enc = new TextEncoder();
  var key = await subtle.importKey("raw", enc.encode(POOL), "PBKDF2", false, ["deriveBits"]);
  var bits = await subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode("human-readable-checksum"), iterations: 40000, hash: "SHA-256" },
    key, 56);
  var words = DistCore.wordsFromKey(new Uint8Array(bits), WORDLIST);
  // (join-compare: the two arrays live in different vm realms in this harness)
  assert.strictEqual(words.join("-"), check.addressToChecksum(POOL, WORDLIST).join("-"));
  assert.strictEqual(words.join("-"), "list-bliss-asset-camp-portion");
});

/* ---------- planner service fee (optional, disclosed, on top) ---------- */
t("computeServiceFee: floored exact split, capped at 100 bps", function () {
  var B = BigInt;
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), 50).feePlancks, B("5000000000")); // 1 QTC @ 0.5% = 0.005 QTC
  assert.strictEqual(DistCore.computeServiceFee(B("19999"), 50).feePlancks, B(99)); // floor(19999*50/10000)
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), 500).feePlancks, B("10000000000")); // capped at 1%
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), 500).feeBps, 100);
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), -50).feePlancks, B(0));
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), 0).feePlancks, B(0));
  assert.strictEqual(DistCore.computeServiceFee(B(0), 50).feePlancks, B(0));
  assert.strictEqual(DistCore.computeServiceFee(B(3), 50).feePlancks, B(0)); // floors to zero
  assert.strictEqual(DistCore.computeServiceFee(B("1000000000000"), 50.9).feeBps, 50); // fractional bps floored
});
t("computeServiceFee sweep: never above the quoted percentage", function () {
  var totals = [1n, 9999n, 10000n, 123456789n, 186250001000000000n, 21000000000000000000000n];
  [1, 25, 50, 99, 100].forEach(function (bps) {
    totals.forEach(function (total) {
      var f = DistCore.computeServiceFee(total, bps);
      assert.ok(f.feePlancks >= 0n, "fee never negative");
      assert.ok(f.feePlancks * 10000n <= total * BigInt(bps), "fee never exceeds quote");
      assert.ok((total * BigInt(bps)) / 10000n - f.feePlancks === 0n, "fee is exactly the floor");
    });
  });
});
t("feeBpsLabel formats basis points", function () {
  assert.strictEqual(DistCore.feeBpsLabel(0), "0%");
  assert.strictEqual(DistCore.feeBpsLabel(25), "0.25%");
  assert.strictEqual(DistCore.feeBpsLabel(50), "0.5%");
  assert.strictEqual(DistCore.feeBpsLabel(100), "1%");
});
t("withServiceFee: recipients untouched, fee row last, exact sums", function () {
  var rows = DistCore.parseInput(POOL + " 10\n" + MSIG + " 2.5\n");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  var valid = v.filter(function (r) { return r.ok; });
  var plan = DistCore.withServiceFee(valid, 50);
  assert.strictEqual(plan.recipientTotalPlancks, BigInt("12500000000000"));
  assert.strictEqual(plan.feePlancks, BigInt("62500000000")); // 0.5% of 12.5 QTC = 0.0625 QTC
  assert.strictEqual(plan.rows.length, 3);
  assert.strictEqual(plan.rows[0], valid[0], "recipient rows pass through in order");
  assert.strictEqual(plan.rows[1], valid[1]);
  assert.strictEqual(plan.rows[2].isServiceFee, true);
  assert.strictEqual(plan.rows[2].address, DistCore.SERVICE_FEE_ADDRESS);
  var sum = plan.rows.reduce(function (a, r) { return a + r.plancks; }, BigInt(0));
  assert.strictEqual(sum, plan.recipientTotalPlancks + plan.feePlancks, "rows sum to total + fee exactly");
  // the fee row is a real CLI batch entry for the fee address
  var batch = { index: 1, rows: plan.rows, totalPlancks: sum };
  var parsed = JSON.parse(DistCore.buildBatchJson(batch));
  assert.deepStrictEqual(parsed[2], { to: DistCore.SERVICE_FEE_ADDRESS, amount: "62500000000" });
});
t("withServiceFee: None and floor-to-zero add no row", function () {
  var rows = DistCore.parseInput(POOL + " 10\n");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  var valid = v.filter(function (r) { return r.ok; });
  var none = DistCore.withServiceFee(valid, 0);
  assert.strictEqual(none.rows.length, 1);
  assert.strictEqual(none.feeRow, null);
  var tiny = DistCore.withServiceFee([{ plancks: BigInt(3) }], 50);
  assert.strictEqual(tiny.rows.length, 1, "a fee floored to 0 plancks adds no invalid 0-transfer");
  assert.strictEqual(tiny.feePlancks, BigInt(0));
});
t("service fee lands in the FINAL batch only", function () {
  var rows = [];
  for (var i = 0; i < 600; i++)
    rows.push({ line: i + 1, address: POOL, plancks: BigInt("1000000000000"), ok: true });
  var plan = DistCore.withServiceFee(rows, 100); // 1% of 600 QTC = 6 QTC
  assert.strictEqual(plan.feePlancks, BigInt("6000000000000"));
  var batches = DistCore.planBatches(plan.rows, 256);
  assert.strictEqual(batches.length, 3);
  assert.strictEqual(batches[2].rows.length, 89, "88 recipients + the fee row");
  assert.ok(batches[2].rows.some(function (r) { return r.isServiceFee; }), "fee in final batch");
  assert.ok(!batches[0].rows.some(function (r) { return r.isServiceFee; }), "fee not in batch 1");
  assert.ok(!batches[1].rows.some(function (r) { return r.isServiceFee; }), "fee not in batch 2");
  var grand = batches.reduce(function (a, b) { return a + b.totalPlancks; }, BigInt(0));
  assert.strictEqual(grand, BigInt(606) * BigInt("1000000000000"), "batches sum to recipients + fee");
});
t("service fee address is Kyle's verified QTC address", function () {
  assert.strictEqual(DistCore.SERVICE_FEE_ADDRESS, "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau");
  assert.strictEqual(DistCore.SERVICE_FEE_MAX_BPS, 100);
  var v = DistCore.validateAddress(DistCore.SERVICE_FEE_ADDRESS, ss58);
  assert.strictEqual(v.ok, true, "fee address is a valid SS58-189 address");
});
t("buildRunScript discloses the service fee; fee-free scripts stay clean", function () {
  var rows = DistCore.parseInput(POOL + " 10\n" + MSIG + " 2.5\n");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  var valid = v.filter(function (r) { return r.ok; });
  var plan = DistCore.withServiceFee(valid, 50);
  var batches = DistCore.planBatches(plan.rows, 256);
  var sh = DistCore.buildRunScript(batches, "treasury", "",
    { feePlancks: plan.feePlancks, feeBps: plan.feeBps });
  assert.ok(sh.indexOf("Service fee (optional, disclosed)") >= 0, "script header discloses the fee");
  assert.ok(sh.indexOf("0.0625 QTC (0.5% of the recipient total)") >= 0, "amount + rate stated");
  assert.ok(sh.indexOf(DistCore.SERVICE_FEE_ADDRESS) >= 0, "fee address stated");
  assert.ok(sh.indexOf("added ON TOP") >= 0, "on-top semantics stated");
  assert.ok(sh.indexOf("includes the 0.0625 QTC service fee") >= 0, "fee batch annotated");
  var plain = DistCore.buildRunScript(DistCore.planBatches(valid, 256), "treasury", "");
  assert.ok(plain.indexOf("Service fee") < 0, "no fee text without a fee");
  assert.ok(plain.indexOf(DistCore.SERVICE_FEE_ADDRESS) < 0, "no fee address without a fee");
});

t("buildRunScript single-argument length bound (Batch 188)", function () {
  // The wallet name and tip each become ONE shell-quoted argument in
  // the script; Linux caps one argv string at 131,072. Over-cap values
  // throw naming size + cap; exactly-cap still builds.
  var batches = [{ index: 1, rows: new Array(1), totalPlancks: BigInt("1000000000000") }];
  assert.strictEqual(DistCore.MAX_SINGLE_ARG_CHARS, 131072);
  assert.strictEqual(DistCore.singleArgRoom("x".repeat(131072)), 0);
  assert.strictEqual(DistCore.singleArgRoom("x".repeat(131073)), -1);
  assert.strictEqual(DistCore.singleArgRoom(42), -1, "fail-closed on non-strings");
  assert.throws(function () { DistCore.buildRunScript(batches, "w".repeat(20000000), ""); }, /too long/);
  assert.throws(function () { DistCore.buildRunScript(batches, "treasury", "9".repeat(20000000)); }, /too long/);
  assert.throws(function () { DistCore.buildRunScript(batches, "w".repeat(131073), ""); }, /131,072/);
  var atCap = DistCore.buildRunScript(batches, "w".repeat(131072), "");
  assert.ok(atCap.indexOf("quantus batch send --from '") >= 0, "exactly-cap wallet still builds");
});

/* ---------- checkphrase queue bound ---------- */
t("checkphraseQueue: bounded to the displayed rows, deduped, fail-closed", function () {
  var stub = { addressToChecksum: function () { return ["stub"]; } };
  var addrs = [];
  for (var i = 0; i < 600; i++) {
    var key = new Array(32).fill(0);
    key[0] = i & 0xff; key[1] = (i >> 8) & 0xff; key[2] = 0x51;
    addrs.push(ss58.ss58Encode(key, 189));
  }
  var v = DistCore.validateRows(
    DistCore.parseInput(addrs.map(function (a) { return a + " 1"; }).join("\n")), ss58, stub, WORDLIST);
  assert.strictEqual(v.length, 600, "full list still validated (exports unaffected)");
  assert.strictEqual(DistCore.DISPLAY_ROW_CAP, 500);
  var q = DistCore.checkphraseQueue(v, DistCore.DISPLAY_ROW_CAP);
  assert.strictEqual(q.length, 500, "queue capped at the rendered-row cap");
  assert.strictEqual(q[0], addrs[0]);
  assert.strictEqual(q[499], addrs[499]);
  assert.ok(q.indexOf(addrs[500]) < 0, "row 501 never queued for derivation");
  var mixed = DistCore.validateRows(
    DistCore.parseInput(addrs[0] + " 1\nbad 2\n" + addrs[0] + " 3\n" + addrs[1] + " 1"), ss58, stub, WORDLIST);
  var qm = DistCore.checkphraseQueue(mixed, 500);
  assert.strictEqual(qm.length, 2, "deduped, invalid rows skipped (count)");
  assert.strictEqual(qm[0], addrs[0], "deduped, invalid rows skipped (first)");
  assert.strictEqual(qm[1], addrs[1], "deduped, invalid rows skipped (second)");
  assert.strictEqual(DistCore.checkphraseQueue(v, 0).length, 0, "cap 0 fail-closed");
  assert.strictEqual(DistCore.checkphraseQueue(v, -1).length, 0, "negative cap fail-closed");
  assert.strictEqual(DistCore.checkphraseQueue(v, NaN).length, 0, "NaN cap fail-closed");
  assert.strictEqual(DistCore.checkphraseQueue(null, 500).length, 0, "null rows fail-closed");
  assert.strictEqual(DistCore.checkphraseQueue(v.slice(0, 3), 500).length, 3, "below cap passes through");
});

/* ---------- recipient-list file gate ---------- */
t("listFileRoom: cap arithmetic at 4 MiB", function () {
  assert.strictEqual(DistCore.MAX_LIST_FILE_BYTES, 4 * 1024 * 1024);
  assert.strictEqual(DistCore.listFileRoom(0), true);
  assert.strictEqual(DistCore.listFileRoom(4194304), true, "exactly at cap loads");
  assert.strictEqual(DistCore.listFileRoom(4194305), false, "one byte over refuses");
});
t("listFileRoom: fail-closed on non-numeric sizes", function () {
  [NaN, -1, "100", undefined, null, Infinity].forEach(function (v) {
    assert.strictEqual(DistCore.listFileRoom(v), false, String(v));
  });
});
t("listFileRoom: the largest genuine list fits — every chain account, max-length amount", function () {
  // Legitimate-scale bound (see core.js): 27,008 accounts at the
  // 2026-10-16 supply capture x a 75-byte max-length line (49-char
  // address + ", " + the longest supply-valid amount, 23 chars, + \n)
  // serializes to exactly 2,025,600 bytes; every row validates.
  var line = POOL + ", 20,999,999.999999999999\n";
  assert.strictEqual(Buffer.byteLength(line), 75);
  assert.strictEqual(27008 * 75, 2025600);
  assert.strictEqual(DistCore.listFileRoom(2025600), true, "whole-chain payout list loads");
  var v = DistCore.validateRows(DistCore.parseInput(line), ss58, check, WORDLIST);
  assert.strictEqual(v[0].ok, true, "the max-length line itself is a valid row");
  assert.strictEqual(v[0].plancks, BigInt("20999999999999999999"));
});

/* ---------- recipient-list paste bound (scan window + row cap) ---------- */
t("paste bound: caps pinned, scan cap equals the file cap", function () {
  // A paste carries exactly what a list file carries — one cap serves
  // both, pinned so the two can never drift apart.
  assert.strictEqual(DistCore.MAX_LIST_SCAN_CHARS, 4 * 1024 * 1024);
  assert.strictEqual(DistCore.MAX_LIST_SCAN_CHARS, DistCore.MAX_LIST_FILE_BYTES);
  assert.strictEqual(DistCore.MAX_RECIPIENT_ROWS, 65536);
});
t("listTextWindow: window arithmetic at the cap", function () {
  var exact = DistCore.listTextWindow("x".repeat(4194304));
  assert.strictEqual(exact.scannedChars, 4194304);
  assert.strictEqual(exact.skippedChars, 0);
  assert.strictEqual(exact.text.length, 4194304);
  var over = DistCore.listTextWindow("x".repeat(4194305));
  assert.strictEqual(over.text, "", "single line longer than the window scans as empty");
  assert.strictEqual(over.skippedChars, 4194305);
  var lined = DistCore.listTextWindow(("a".repeat(99) + "\n").repeat(50000)); // 5,000,000 chars
  assert.strictEqual(lined.scannedChars % 100, 0, "mid-line cut backs off to the last newline");
  assert.strictEqual(lined.skippedChars, 5000000 - lined.scannedChars);
  var small = DistCore.listTextWindow("a 1\nb 2");
  assert.strictEqual(small.skippedChars, 0);
  assert.strictEqual(small.text, "a 1\nb 2");
});
t("listTextWindow: fail-closed on non-strings", function () {
  [null, undefined, 42, {}, []].forEach(function (v) {
    var w = DistCore.listTextWindow(v);
    assert.strictEqual(w.text, "", String(v));
    assert.strictEqual(w.skippedChars, 0, String(v));
  });
});
t("parseInputBounded: small lists match parseInput exactly", function () {
  var text = "# plan\naddress,amount\n" + POOL + " 10\n\n" + MSIG + ",2.5\nlonelyfield\n";
  var b = DistCore.parseInputBounded(text);
  var p = DistCore.parseInput(text);
  assert.strictEqual(b.droppedRows, 0);
  assert.strictEqual(b.skippedChars, 0);
  assert.strictEqual(b.rows.length, p.length);
  b.rows.forEach(function (r, i) {
    assert.strictEqual(r.line, p[i].line);
    assert.strictEqual(r.address, p[i].address);
    assert.strictEqual(r.amountStr, p[i].amountStr);
    assert.strictEqual(r.error, p[i].error);
  });
  assert.strictEqual(b.rows[0].line, 3, "original line numbers preserved");
});
t("parseInputBounded: the largest genuine list scans intact", function () {
  // Every account on chain (27,008 at the 2026-10-16 capture) at a
  // max-length amount: 2,025,600 chars / 27,008 rows — under both caps.
  var line = POOL + ", 20,999,999.999999999999\n";
  var b = DistCore.parseInputBounded(line.repeat(27008));
  assert.strictEqual(b.rows.length, 27008);
  assert.strictEqual(b.droppedRows, 0);
  assert.strictEqual(b.skippedChars, 0);
});
t("parseInputBounded: row cap counts dropped rows exactly", function () {
  var text = (POOL + " 1\n").repeat(70000); // inside the char window, past the row cap
  var b = DistCore.parseInputBounded(text);
  assert.strictEqual(b.rows.length, 65536);
  assert.strictEqual(b.droppedRows, 4464);
  assert.strictEqual(b.totalRows, 70000);
  assert.strictEqual(b.skippedChars, 0);
  assert.strictEqual(b.rows[65535].line, 65536, "kept rows keep original line numbers");
});
t("parseInputBounded: tail counting skips blanks, comments and a header", function () {
  var text = "a 1\n".repeat(65536) + "\n# note\naddress,amount\nb 2\nc 3\n";
  var b = DistCore.parseInputBounded(text);
  assert.strictEqual(b.rows.length, 65536);
  assert.strictEqual(b.droppedRows, 2, "only the two data rows past the cap count as dropped");
});
t("parseInputBounded: giant paste is windowed and row-capped", function () {
  var giant = (POOL + " 1\n").repeat(400000); // 20,800,000 chars
  var b = DistCore.parseInputBounded(giant);
  assert.ok(b.scannedChars <= DistCore.MAX_LIST_SCAN_CHARS, "scan windowed");
  assert.strictEqual(b.skippedChars, giant.length - b.scannedChars);
  assert.ok(b.skippedChars > 15000000, "tail reported, not parsed");
  assert.strictEqual(b.rows.length, 65536);
  assert.ok(b.droppedRows > 0, "in-window rows past the cap counted");
});

/* ---------- summarize ---------- */
t("summarize counts and totals", function () {
  var rows = DistCore.parseInput(POOL + " 1\n" + MSIG + " 2\n" + "bad 3\n");
  var v = DistCore.validateRows(rows, ss58, check, WORDLIST);
  var s = DistCore.summarize(v);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.valid, 2);
  assert.strictEqual(s.invalid, 1);
  assert.strictEqual(s.totalPlancks, BigInt("3000000000000"));
});

/* Batch 194: amount-input length bound — refused before BigInt, cap named. */
t("amount bound: parseAmountToPlancks length gate", function () {
  var g = DistCore.parseAmountToPlancks("1.5");
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.plancks, BigInt("1500000000000"));
  var o = DistCore.parseAmountToPlancks("9".repeat(600));
  assert.strictEqual(o.ok, false);
  assert.ok(/512/.test(o.error), o.error);
  var v = DistCore.parseAmountToPlancks("0".repeat(600) + "1.5");
  assert.strictEqual(v.ok, false);
  assert.ok(/512/.test(v.error), v.error);
  var h = DistCore.parseAmountToPlancks("9".repeat(2000000));
  assert.strictEqual(h.ok, false);
});

(async function () {
  await Promise.all(pending);
  console.log("---");
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
