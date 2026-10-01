/* QTC Pool Desk — node test suite.
 * Anchored to verified sources (all read 2026-10-01):
 *  - AriaPool: https://pool.ariabrain.com/qtc.html (fee 1%, PPLNS window 2x
 *    difficulty, payouts 06:00/18:00 Paris, min 0.11 QTC, endpoints, miner
 *    builds + SHA-256 checksums, TLS pin, QPoW constants)
 *  - Quanpool terms: 0xmoei/quantus community guide (pool fee 1%,
 *    quanpool-miner dev fee 5% -> 6% total, PPLNS or Solo, min 0.25 QTC,
 *    hourly payouts, 105 confirmations)
 *  - Network defaults: repo data/live.json (avg reward 0.309 QTC, 2026-09-30)
 *    and data/consensus.json (difficulty 306344884677664 @ h142417 -> /12s).
 */
const P = require("../js/app.js");

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : extra); }
}
function eq(name, got, want) {
  t(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}
function approx(name, got, want, tol) {
  t(name, Math.abs(got - want) <= tol, "got " + got + " want ~" + want);
}
const HEX64 = /^[0-9a-f]{64}$/;

// --- fee stacking: the core honesty math of the desk
approx("1% pool + 0% dev = 1%", P.effectiveFee(0.01, 0), 0.01, 1e-12);
approx("1% pool + 1% dev stacks, not adds", P.effectiveFee(0.01, 0.01), 0.0199, 1e-12);
approx("Quanpool 1% + 5% = 5.95% effective (6% total nominal)", P.effectiveFee(0.01, 0.05), 0.0595, 1e-12);
approx("AriaPool CPU 1% + 3% = 3.97%", P.effectiveFee(0.01, 0.03), 0.0397, 1e-12);
eq("fees clamp at [0,1] -> 100% fee", P.effectiveFee(2, -1), 1);

// --- comparator math
eq("7200 blocks/day at 12s", P.BLOCKS_PER_DAY, 7200);
// 1 TH/s of 25.528740389805 TH/s, 0.309 reward
approx("gross/day sane", P.grossPerDay(1e12, 25528740389805, 0.309), (1e12 / 25528740389805) * 7200 * 0.309, 1e-9);
eq("gross/day zero on bad input", P.grossPerDay(0, 1e12, 0.3), 0);
eq("gross/day zero on zero nethash", P.grossPerDay(1e12, 0, 0.3), 0);
approx("net/day = gross * (1 - stacked fee)", P.netPerDay(1e12, 25528740389805, 0.309, 0.01, 0.05),
  P.grossPerDay(1e12, 25528740389805, 0.309) * (1 - 0.0595), 1e-9);

// --- solo lottery stats
const solo = P.soloStats(1e12, 25528740389805);
approx("solo blocks/day matches share", solo.blocksPerDay, (1e12 / 25528740389805) * 7200, 1e-9);
approx("solo days/block is reciprocal", solo.daysPerBlock, 1 / solo.blocksPerDay, 1e-6);
t("solo days/block finite for sane input", isFinite(solo.daysPerBlock));

// --- unit conversion
eq("2.5 TH/s -> H/s", P.toHS(2.5, "TH/s"), 2.5e12);
eq("500 GH/s -> H/s", P.toHS(500, "GH/s"), 500e9);
eq("unknown unit defaults TH/s", P.toHS(1, "ZZ/s"), 1e12);

// --- formatting
eq("fmtQTC trims", P.fmtQTC(0.3090), "0.309");
eq("fmtQTC digits", P.fmtQTC(1.5, 2), "1.5");
eq("fmtQTC non-finite", P.fmtQTC(Infinity), "—");
eq("fmtDays hours", P.fmtDays(0.5), "12.0 h");
eq("fmtDays days", P.fmtDays(3.25), "3.3 days");

// --- validators
t("good qz address passes", P.validateAddress("qz" + "a".repeat(46)).ok);
t("empty address fails", !P.validateAddress("").ok);
t("non-qz fails", !P.validateAddress("5abc").ok);
t("non-base58 fails", !P.validateAddress("qzabc0OIl").ok);
const short = P.validateAddress("qzabc");
t("odd length warns softly", !short.ok && short.soft === true);
t("empty worker ok", P.validateWorker("").ok);
t("good worker ok", P.validateWorker("rig1").ok);
t("bad worker fails", !P.validateWorker("RIG 1!").ok);
t("33-char worker fails", !P.validateWorker("a".repeat(33)).ok);

// --- auth token
eq("token with worker", P.authToken("qzABC", "rig1"), "qzABC.rig1");
eq("token without worker", P.authToken("qzABC", ""), "qzABC");

// --- command builder: AriaPool official QUIC
let r = P.buildCommand("ariapool", "official", "qzTESTADDRESS", "rig1");
t("aria official ok", r.ok);
t("aria official endpoint", r.cmd.includes("qtc-node.ariabrain.com:9834"));
t("aria official auth token", r.cmd.includes("--auth-token qzTESTADDRESS.rig1"));
t("aria official TLS pin", r.cmd.includes("870d67d848c69661a5e86aeea37b63332af3b7d642855e4aa5f19156d1cab889"));
t("aria official warns about pin rotation", r.warn.some((w) => /re-verify/i.test(w)));

// --- command builder: AriaMiner getwork (install + checksum + run)
r = P.buildCommand("ariapool", "ariaminer", "qzTESTADDRESS", "");
t("ariaminer ok", r.ok);
t("ariaminer download URL", r.cmd.includes("ariaminer-qtc-v2.1.1-linux-x86_64.tar.gz"));
t("ariaminer sha256 in cmd", r.cmd.includes("416617e73d8aa2f67ec3813d27b79b479d799af0844071d06a690fbee696dedb"));
t("ariaminer getwork endpoint", r.cmd.includes("http://qtc-node.ariabrain.com:9412/"));
t("ariaminer default worker rig1", r.cmd.includes("--worker rig1"));
t("ariaminer checksum warning", r.warn.some((w) => /SHA-256/i.test(w)));

// --- command builder: datacenter + CPU variants
r = P.buildCommand("ariapool", "ariadtc", "qzA", "dc1");
t("aria_dtc binary", r.cmd.includes("./aria_dtc"));
t("aria_dtc checksum", r.cmd.includes("8ae7359ab34ba86c62992c8194d3abfd544c85a5d0cebe739a5a7a1f31b03553"));
r = P.buildCommand("ariapool", "ariacpu", "qzA", "");
t("cpu uses mine subcommand", r.cmd.includes("./ariaminer-qtc-cpu mine"));
t("cpu checksum", r.cmd.includes("eda2d60e59d27d7619a1f443494e682be7878a70d1d2af33bef8271d7872ad75"));

// --- command builder: Quanpool (never invents server/pin)
r = P.buildCommand("quanpool", "quanpoolminer", "qzTEST", "w1");
t("quanpool ok", r.ok);
t("quanpool uses quanpool-miner", r.cmd.includes("quanpool-miner-6.0.0 serve"));
t("quanpool token shape", r.cmd.includes("--auth-token qzTEST.w1"));
t("quanpool does NOT invent server", r.cmd.includes("PASTE_SERVER_FROM_SITE") && !r.cmd.includes("37.187.143.115"));
t("quanpool does NOT invent pin", r.cmd.includes("PASTE_FROM_SITE"));
t("quanpool warns to re-copy", r.warn.some((w) => /re-copy/i.test(w)));

t("unknown pool fails", !P.buildCommand("nosuch", "official", "qzA", "").ok);
t("unknown miner fails", !P.buildCommand("ariapool", "nosuch", "qzA", "").ok);

// --- data integrity: every published fact well-formed
t("two pools listed", P.POOLS.length === 2);
P.POOLS.forEach((p) => {
  t(p.id + " has site", /^https:\/\//.test(p.site));
  t(p.id + " has verified date", /^\d{4}-\d{2}-\d{2}$/.test(p.verified));
  t(p.id + " fee in [0,1)", p.poolFee >= 0 && p.poolFee < 1);
  t(p.id + " min payout positive", p.minPayoutQTC > 0);
  t(p.id + " has miners", p.miners.length > 0);
  p.miners.forEach((m) => {
    t(p.id + "/" + m.id + " devFee in [0,1)", m.devFee >= 0 && m.devFee < 1);
    if (m.tlsPin && !/PASTE/.test(m.tlsPin)) t(p.id + "/" + m.id + " TLS pin is 64-hex", HEX64.test(m.tlsPin));
    if (m.sha256linux) t(p.id + "/" + m.id + " sha256 is 64-hex", HEX64.test(m.sha256linux));
  });
});
// AriaPool specifics from the pool page
const aria = P.poolById("ariapool");
eq("AriaPool fee 1%", aria.poolFee, 0.01);
eq("AriaPool min payout 0.11 QTC", aria.minPayoutQTC, 0.11);
t("AriaPool payout schedule Paris time", /Paris/.test(aria.payoutSchedule));
const qp = P.poolById("quanpool");
eq("Quanpool fee 1%", qp.poolFee, 0.01);
eq("Quanpool miner dev fee 5%", qp.miners[0].devFee, 0.05);
eq("Quanpool min payout 0.25 QTC", qp.minPayoutQTC, 0.25);
t("Quanpool confirmations 105", qp.payoutNotes.some((n) => /105/.test(n)));
t("minerOptions helper", P.minerOptions("ariapool").length === 4 && P.minerOptions("quanpool").length === 1);

// --- PPLNS window helper
const w = P.pplnsWindowBlocks(306344884677664);
eq("PPLNS window multiple is 2x difficulty", w.windowMultiple, 2);

console.log(pass + "/" + (pass + fail) + " pool-desk tests green");
process.exit(fail ? 1 : 0);
