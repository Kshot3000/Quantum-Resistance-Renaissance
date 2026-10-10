/* QTC Network Dashboard — logic tests. Run: node tests/dashboard.test.js */
"use strict";
var D = require("../app.js");
var fails = 0;
function check(name, cond, extra){
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? " :: " + extra : ""));
  if (!cond) fails++;
}

check("fmtQTC 310000000000 planck -> 0.31", D.fmtQTC("310000000000") === "0.31", D.fmtQTC("310000000000"));
check("fmtQTC 0", D.fmtQTC("0") === "0");
check("fmtQTC 1 planck renders 0.0000", D.fmtQTC("1") === "0.0000", D.fmtQTC("1"));
check("fmtQTC 1 QTC exact", D.fmtQTC("1000000000000") === "1");
check("fmtQTC big supply grouping", D.fmtQTC("5711000000000000") === "5,711", D.fmtQTC("5711000000000000"));
check("fmtQTC null -> em dash", D.fmtQTC(null) === "—");

check("fmtRewardQTC appends unit", D.fmtRewardQTC("300000000000") === "0.3 QTC", D.fmtRewardQTC("300000000000"));

check("fmtInt grouping", D.fmtInt(134847) === "134,847");
check("fmtInt null -> em dash", D.fmtInt(null) === "—");

var now = Date.parse("2026-09-29T16:05:00Z");
check("ageFmt seconds", D.ageFmt(Date.parse("2026-09-29T16:04:48Z"), now) === "12s ago");
check("ageFmt minutes", D.ageFmt(Date.parse("2026-09-29T15:58:00Z"), now) === "7m ago");
check("ageFmt hours", D.ageFmt(Date.parse("2026-09-29T13:05:00Z"), now) === "3h ago");
check("ageFmt future clamps to 0s", D.ageFmt(now + 5000, now) === "0s ago");

check("tps24h 8359/day -> ~0.0967", Math.abs(D.tps24h(8359) - 0.0967477) < 1e-6);
check("tps24h 0 -> 0", D.tps24h(0) === 0);

var ts = [now, now - 14000, now - 26000, now - 41000];
var gap = D.avgBlockGap(ts);
check("avgBlockGap ~13.67s", Math.abs(gap - 13.6667) < 1e-3, String(gap));
check("avgBlockGap ignores negative gaps", D.avgBlockGap([now, now + 1000]) === null);
check("avgBlockGap single -> null", D.avgBlockGap([now]) === null);

/* emission formula: supplyEst(0) must equal the 5.67M genesis mint */
check("supplyEst(0) = genesis mint 5.67M", Math.abs(D.supplyEst(0) - 5670000) < 1e-6);
var sup = D.supplyEst(134849);
check("supplyEst(134849) ~ 5.711M (matches curl spot-check)", sup > 5700000 && sup < 5720000, String(sup));
var rw = D.blockRewardEst(134849);
check("blockRewardEst(134849) ~ 0.306 QTC (matches indexer 0.31)", rw > 0.30 && rw < 0.32, String(rw));
check("supply approaches 21M asymptotically", D.supplyEst(1e12) > 20999000);

check("shortHash truncates", D.shortHash("0xcdaaa0b07d34408c600e2953cfa74c0918d99e0a51547a4ced2bfb5cf60afbc1") === "0xcdaaa0b0…f60afbc1");
check("shortHash short/non-string -> em dash (never a raw pass-through)", D.shortHash("abc") === "—" && D.shortHash(null) === "—" && D.shortHash(42) === "—");

/* ---- boundary hardening (Batch 23): nothing renders unvalidated ---- */
check("fmtQTC markup in planck -> em dash, never pass-through", D.fmtQTC('1234567890123<img src=x>') === "—", D.fmtQTC('1234567890123<img src=x>'));
check("fmtQTC negative/fractional/object -> em dash", D.fmtQTC("-5") === "—" && D.fmtQTC("1.5") === "—" && D.fmtQTC({}) === "—");
check("fmtQTC leading zeros normalize", D.fmtQTC("000310000000000") === "0.31", D.fmtQTC("000310000000000"));
check("fmtRewardQTC invalid -> em dash without unit", D.fmtRewardQTC("abc") === "—");
check("fmtInt negative/string/NaN -> em dash", D.fmtInt(-5) === "—" && D.fmtInt("134847") === "—" && D.fmtInt(NaN) === "—");
check("tps24h garbage -> 0, never NaN", D.tps24h("<img>") === 0 && D.tps24h(-1) === 0 && D.tps24h(1.5) === 0);
check("supplyEst garbage -> NaN (renders as em dash)", isNaN(D.supplyEst("abc")) && isNaN(D.supplyEst(-1)));
check("blockRewardEst garbage -> NaN", isNaN(D.blockRewardEst(null)));

check("nonNegInt accepts int + digit string only", D.nonNegInt(7) === 7 && D.nonNegInt("7") === 7 && D.nonNegInt(7.5) === null && D.nonNegInt(-1) === null && D.nonNegInt("7x") === null);
check("validPlancks normalizes digit strings only", D.validPlancks("000123") === "123" && D.validPlancks(123) === "123" && D.validPlancks("1.5") === null && D.validPlancks(null) === null);
check("validHash requires 0x + 64 hex", D.validHash("0x" + "a".repeat(64)) !== null && D.validHash("0xabc") === null && D.validHash('0x' + 'a'.repeat(63) + '">') === null);

var GOOD_HASH = "0x" + "ab".repeat(32);
function payload(mut){
  var d = { status: { block_height: 200000, total_accounts: 12000, total_immediate_transfers: 270000, total_scheduled_transfers: 15 },
    blocks: [{ height: 200000, hash: GOOD_HASH, timestamp: "2026-10-10T00:00:00.000Z", reward: "310000000000" }],
    daily: [{ date: "2026-10-10T00:00:00+00:00", blocks_count: 6100, tx_count: 8300, active_accounts: 950 }] };
  if (mut) mut(d);
  return d;
}
check("sanitizeData accepts a well-formed payload", !!D.sanitizeData(payload()));
check("sanitizeData rejects non-object / array / missing status", D.sanitizeData(null) === null && D.sanitizeData([]) === null && D.sanitizeData({ blocks: [], daily: [] }) === null);
check("sanitizeData rejects string/negative/fractional status fields",
  D.sanitizeData(payload(function(d){ d.status.block_height = "200000;evil"; })) === null &&
  D.sanitizeData(payload(function(d){ d.status.total_accounts = -5; })) === null &&
  D.sanitizeData(payload(function(d){ d.status.total_immediate_transfers = 1.5; })) === null);
check("sanitizeData drops a poisoned block row, keeps valid rows",
  (function(){ var c = D.sanitizeData(payload(function(d){ d.blocks.push({ height: 199999, hash: '0xabc"><img src=x>', timestamp: "2026-10-10T00:00:00.000Z", reward: "310000000000" }); }));
    return c && c.blocks.length === 1 && c.blocks[0].height === 200000; })());
check("sanitizeData drops markup-reward and bad-timestamp rows",
  (function(){ var c = D.sanitizeData(payload(function(d){
      d.blocks.push({ height: 199999, hash: GOOD_HASH, timestamp: "2026-10-10T00:00:00.000Z", reward: "1<img>" });
      d.blocks.push({ height: 199998, hash: GOOD_HASH, timestamp: "not-a-date", reward: "310000000000" }); }));
    return c && c.blocks.length === 1; })());
check("sanitizeData drops a poisoned daily row, keeps valid rows",
  (function(){ var c = D.sanitizeData(payload(function(d){ d.daily.push({ date: "2026-10-09T00:00:00+00:00", blocks_count: 6000, tx_count: "<img>", active_accounts: 900 }); }));
    return c && c.daily.length === 1 && c.daily[0].tx_count === 8300; })());
check("sanitizeData rejects a non-array blocks/daily container",
  D.sanitizeData(payload(function(d){ d.blocks = {}; })) === null &&
  D.sanitizeData(payload(function(d){ d.daily = "x"; })) === null);
check("sanitizeData coerces digit-string counts to numbers",
  (function(){ var c = D.sanitizeData(payload(function(d){ d.status.block_height = "200000"; }));
    return c && c.status.block_height === 200000; })());

console.log(fails === 0 ? "\nALL TESTS PASSED" : "\n" + fails + " TEST(S) FAILED");
process.exit(fails === 0 ? 0 : 1);
