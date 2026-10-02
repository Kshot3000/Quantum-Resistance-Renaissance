/* QTC Pool Desk — node test suite.
 * Anchored to verified sources (all read 2026-10-01):
 *  - AriaPool: https://pool.ariabrain.com/qtc.html (fee 1%, PPLNS window 2x
 *    difficulty, payouts 06:00/18:00 Paris, min 0.11 QTC, endpoints, miner
 *    builds + SHA-256 checksums, TLS pin, QPoW constants)
 *  - Quanpool terms: 0xmoei/quantus community guide (pool fee 1%,
 *    quanpool-miner dev fee 5% -> 6% total, PPLNS or Solo, min 0.25 QTC,
 *    hourly payouts, 105 confirmations)
 *  - Network defaults: derived live at page load from repo data/*.json
 *    (consensus.json est_hashrate_hs, supply.json total_supply_plancks via the
 *    emission formula, consensus.json block_times_ms observed pace); the
 *    2026-10-02 statics in NETWORK_DEFAULTS are the honest, dated fallback
 *    when snapshots can't load.
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

// --- live snapshot derivation (v1.44.0): defaults from hourly data/*.json
// emission formula: R = (21M - total_issuance) / 50M, total_issuance INCLUDES genesis
approx("blockRewardQtc formula exact to planck",
  P.blockRewardQtc("5763112233946770492"),
  (21000000 - 5763112233946770492 / 1e12) / 50000000, 1e-12);
approx("blockRewardQtc ~0.3047 at current supply", P.blockRewardQtc("5763112233946770492"), 0.3047, 1e-4);

eq("totalSupplyOf prefers total_supply_plancks",
  P.totalSupplyOf({ total_supply_plancks: "5763112233946770492" }), "5763112233946770492");
eq("totalSupplyOf falls back to balances aggregate",
  P.totalSupplyOf({ balances_plancks: { free: "100", reserved: "5", frozen: "7" } }), "112");
eq("totalSupplyOf null when unusable", P.totalSupplyOf({}), null);

approx("paceBlocksPerDay from 13365ms avg", P.paceBlocksPerDay(13365), 86400000 / 13365, 1e-6);
eq("paceBlocksPerDay falls back to 7200 target", P.paceBlocksPerDay(null), 7200);

eq("formatUtc", P.formatUtc("2026-10-02T06:00:21.381Z"), "2026-10-02 06:00 UTC");

// full derivation from realistic snapshot fixtures
const fixture = {
  live: {
    fetched_at: "2026-10-02T06:00:11.401Z",
    data: { blocks: [{ reward: "310000000000" }, { reward: "300000000000" }] },
  },
  consensus: {
    fetched_at: "2026-10-02T06:00:21.381Z",
    current: { height: 150644, est_hashrate_hs: "38525603542782" },
    block_times_ms: { sample: 3000, avg_ms: 13365 },
  },
  supply: { fetched_at: "2026-10-02T06:00:30.000Z", total_supply_plancks: "5763112233946770492" },
};
const d = P.deriveNetworkDefaults(fixture);
approx("derive: reward from emission formula", d.rewardQtc, P.blockRewardQtc("5763112233946770492"), 1e-12);
eq("derive: netHash from est_hashrate_hs", d.netHashHs, 38525603542782);
approx("derive: pace from block_times_ms", d.blocksPerDay, 86400000 / 13365, 1e-6);
t("derive: reward label cites emission formula + snapshot", /emission formula/.test(d.rewardLabel) && /2026-10-02 06:00 UTC/.test(d.rewardLabel));
t("derive: netHash label cites 12s target", /38.53 TH\/s/.test(d.netHashLabel) && /12 s target/.test(d.netHashLabel));
t("derive: pace label cites observed sample", /6,465 blocks\/day/.test(d.paceLabel) && /last 3000 blocks/.test(d.paceLabel));

// fallback layers: no supply -> avg of recent block rewards
const d2 = P.deriveNetworkDefaults({ live: fixture.live, consensus: fixture.consensus, supply: {} });
approx("derive: reward falls back to block avg", d2.rewardQtc, 0.305, 1e-9);
t("derive: block-avg label says so", /avg of last 2 mainnet blocks/.test(d2.rewardLabel));
// nothing usable at all
eq("derive: null for empty snapshots", P.deriveNetworkDefaults({}), null);
eq("derive: null for non-object", P.deriveNetworkDefaults(null), null);
// no consensus -> static netHash fallback + 7200 pace
const d3 = P.deriveNetworkDefaults({ live: fixture.live, consensus: null, supply: fixture.supply });
eq("derive: netHash static fallback", d3.netHashHs, P.NETWORK_DEFAULTS.netHashHS);
eq("derive: pace static fallback", d3.blocksPerDay, 7200);

// optional pace param stays backward compatible
approx("grossPerDay 4th param pace", P.grossPerDay(1e12, 2e12, 0.3, 6465), 0.5 * 6465 * 0.3, 1e-9);
approx("grossPerDay default 7200", P.grossPerDay(1e12, 2e12, 0.3), 0.5 * 7200 * 0.3, 1e-9);
const s2 = P.soloStats(1e12, 2e12, 6465);
approx("soloStats honors pace param", s2.blocksPerDay, 0.5 * 6465, 1e-9);

// --- fallback bundle integrity (regression guard, added 2026-10-02)
// The Sept-30 fallback bundle survived two days of difficulty growth: at half
// the real hashrate it overstated every fallback-path earnings figure ~2x.
// These guards fail if the bundle ever mixes captures or drifts far from the
// repo snapshots again — refresh NETWORK_DEFAULTS from ONE fresh capture.
(function () {
  const nd = P.NETWORK_DEFAULTS;
  const dNum = /difficulty (\d+)/.exec(nd.netHashLabel);
  const dHt = /@ height (\d+)/.exec(nd.netHashLabel);
  const rHt = /@ height (\d+)/.exec(nd.blockRewardLabel);
  const dateOf = (s) => { const m = /(\d{4}-\d{2}-\d{2})/.exec(s); return m && m[1]; };
  t("fallback: netHash label names a difficulty", !!dNum);
  t("fallback: netHashHS = floor(difficulty / 12)", !!dNum && nd.netHashHS === Math.floor(Number(dNum[1]) / 12),
    "got " + nd.netHashHS);
  t("fallback: netHash label TH/s matches netHashHS", /≈([\d.]+) TH\/s/.test(nd.netHashLabel) &&
    Math.abs(parseFloat(/≈([\d.]+) TH\/s/.exec(nd.netHashLabel)[1]) - nd.netHashHS / 1e12) < 0.005);
  t("fallback: reward label value matches blockRewardQTC (4dp)",
    nd.blockRewardLabel.startsWith(nd.blockRewardQTC.toFixed(4)));
  t("fallback: both labels carry the same capture date",
    !!dateOf(nd.netHashLabel) && dateOf(nd.netHashLabel) === dateOf(nd.blockRewardLabel),
    nd.netHashLabel + " vs " + nd.blockRewardLabel);
  t("fallback: both labels cite heights from one capture (<=10 blocks apart)",
    !!dHt && !!rHt && Math.abs(Number(dHt[1]) - Number(rHt[1])) <= 10,
    nd.netHashLabel + " vs " + nd.blockRewardLabel);
  // Freshness tripwire vs the repo snapshots (skipped when data/ is absent,
  // e.g. a standalone copy of the app).
  try {
    const fs = require("fs"), path = require("path");
    const root = path.join(__dirname, "..", "..", "..");
    const cons = JSON.parse(fs.readFileSync(path.join(root, "data", "consensus.json"), "utf8"));
    const sup = JSON.parse(fs.readFileSync(path.join(root, "data", "supply.json"), "utf8"));
    const ratio = nd.netHashHS / Number(cons.current.est_hashrate_hs);
    t("fallback: hashrate within 0.6x-1.67x of snapshot (refresh bundle when this fails)",
      ratio >= 0.6 && ratio <= 1.67, "ratio " + ratio.toFixed(3));
    const snapReward = P.blockRewardQtc(P.totalSupplyOf(sup));
    t("fallback: reward within 2% of snapshot emission reward",
      Math.abs(nd.blockRewardQTC / snapReward - 1) <= 0.02,
      "fallback " + nd.blockRewardQTC + " vs snapshot " + snapReward);
  } catch (e) { /* standalone copy: internal-consistency guards above still apply */ }
})();

console.log(pass + "/" + (pass + fail) + " pool-desk tests green");
process.exit(fail ? 1 : 0);
