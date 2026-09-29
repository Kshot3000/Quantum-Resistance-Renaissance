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
check("shortHash short passthrough", D.shortHash("abc") === "abc");

console.log(fails === 0 ? "\nALL TESTS PASSED" : "\n" + fails + " TEST(S) FAILED");
process.exit(fails === 0 ? 0 : 1);
