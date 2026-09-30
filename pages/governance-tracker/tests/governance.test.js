/* Unit tests for gov-core.js — run: node tests/governance.test.js */
"use strict";
const assert = require("node:assert/strict");
const C = require("../js/gov-core.js");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name, "\n ", e.message); process.exitCode = 1; }
}

// --- track constants vs upstream ----------------------------------------------
t("track 0 is tech_collective_members with 2h/1d/1d/1d windows", () => {
  const tr = C.trackById(0);
  assert.equal(tr.name, "tech_collective_members");
  assert.equal(tr.prepare_blocks, 600);
  assert.equal(tr.decision_blocks, 7200);
  assert.equal(tr.confirm_blocks, 7200);
  assert.equal(tr.min_enactment_blocks, 7200);
  assert.equal(tr.min_approval, 0.61);
  assert.equal(tr.min_support, 0.60);
});
t("track 1 is fast_upgrade with 10min windows and 80/80 curves", () => {
  const tr = C.trackById(1);
  assert.equal(tr.name, "fast_upgrade");
  assert.equal(tr.prepare_blocks, 50);
  assert.equal(tr.confirm_blocks, 50);
  assert.equal(tr.min_enactment_blocks, 50);
  assert.equal(tr.min_approval, 0.80);
  assert.equal(tr.min_support, 0.80);
});
t("decision deposit is 0.1 QTC on both tracks", () => {
  assert.equal(C.fmtQTC(C.TRACKS[0].decision_deposit_plancks), "0.1");
  assert.equal(C.fmtQTC(C.TRACKS[1].decision_deposit_plancks), "0.1");
});
t("submission deposit 0.1 QTC; undeciding timeout 45 days", () => {
  assert.equal(C.fmtQTC(C.GOV.submission_deposit_plancks), "0.1");
  assert.equal(C.blocksToMs(C.GOV.undeciding_timeout_blocks), 45 * 24 * 3600 * 1000);
});
t("member bounds: floor 5, cap 13, genesis 10", () => {
  assert.equal(C.GOV.min_member_count, 5);
  assert.equal(C.GOV.max_member_count, 13);
  assert.equal(C.GOV.genesis_member_count, 10);
});

// --- status derivation ---------------------------------------------------------
t("statusOf follows the referendum lifecycle", () => {
  const ev = (type) => ({ type });
  assert.equal(C.statusOf([ev("SUBMITTED")]), "SUBMITTED");
  assert.equal(C.statusOf([ev("SUBMITTED"), ev("DECISION_STARTED")]), "DECISION_STARTED");
  assert.equal(C.statusOf([ev("SUBMITTED"), ev("DECISION_STARTED"), ev("CONFIRM_STARTED")]), "CONFIRM_STARTED");
  assert.equal(C.statusOf([ev("SUBMITTED"), ev("DECISION_STARTED"), ev("CONFIRM_STARTED"), ev("CONFIRMED")]), "CONFIRMED");
});
t("statusOf: terminal states win regardless of order", () => {
  const ev = (type) => ({ type });
  assert.equal(C.statusOf([ev("CONFIRMED"), ev("KILLED")]), "KILLED");
  assert.equal(C.statusOf([ev("CANCELLED"), ev("CONFIRMED")]), "CANCELLED");
  assert.equal(C.statusOf([ev("DECISION_STARTED"), ev("TIMED_OUT")]), "TIMED_OUT");
  assert.equal(C.statusOf([ev("REJECTED"), ev("CONFIRM_STARTED")]), "REJECTED");
});
t("groupByReferendum groups and orders by index", () => {
  const gs = C.groupByReferendum([
    { referendum_index: 3, type: "SUBMITTED" },
    { referendum_index: 0, type: "SUBMITTED" },
    { referendum_index: 0, type: "CONFIRMED" }
  ]);
  assert.equal(gs.length, 2);
  assert.equal(gs[0].index, 0);
  assert.equal(gs[0].events.length, 2);
  assert.equal(gs[1].index, 3);
});

// --- threshold math --------------------------------------------------------------
t("verdictFor: referendum 0 (8 ayes, 0 nays, 10 members) passes fast_upgrade", () => {
  const v = C.verdictFor(C.trackById(1), 8, 0, 10);
  assert.equal(v.approval, 1);
  assert.equal(v.support, 0.8);
  assert.ok(v.passes);
});
t("verdictFor: 7 ayes of 10 members fails fast_upgrade support", () => {
  const v = C.verdictFor(C.trackById(1), 7, 0, 10);
  assert.ok(v.okApproval);
  assert.ok(!v.okSupport);
  assert.ok(!v.passes);
});
t("verdictFor: nays can sink approval on the tech lane", () => {
  const v = C.verdictFor(C.trackById(0), 3, 2, 5); // 3/5 = 60% approval < 61%
  assert.equal(v.approval, 0.6);
  assert.ok(!v.okApproval);
  assert.ok(!v.passes);
});
t("verdictFor: tech lane 3 ayes 1 nay of 5 members passes", () => {
  const v = C.verdictFor(C.trackById(0), 3, 1, 5); // 75% approval ≥ 61%, 60% support ≥ 60%
  assert.ok(v.passes);
});
t("verdictFor handles zero votes without crashing", () => {
  const v = C.verdictFor(C.trackById(1), 0, 0, 10);
  assert.equal(v.approval, null);
  assert.equal(v.support, 0);
  assert.ok(!v.passes);
});
t("minAyesFor: fast_upgrade with 10 members needs 8", () => {
  assert.equal(C.minAyesFor(C.trackById(1), 10), 8);
});
t("minAyesFor: fast_upgrade with 5 members needs 4", () => {
  assert.equal(C.minAyesFor(C.trackById(1), 5), 4);
});
t("minAyesFor: tech lane with 5 members needs 3", () => {
  assert.equal(C.minAyesFor(C.trackById(0), 5), 3);
});
t("minAyesVsNays: 2 nays on tech lane need 4 ayes (4/6 = 66.7% ≥ 61%)", () => {
  assert.equal(C.minAyesVsNays(C.trackById(0), 2), 4);
});

// --- preimage deposit --------------------------------------------------------------
t("preimage deposit: 34-byte proposal costs 0.01035 QTC", () => {
  const p = C.preimageDepositPlancks(34, 1);
  assert.equal(C.fmtQTC(p), "0.01035");
});
t("preimage deposit: max 4KiB blob ≈ 0.05097 QTC", () => {
  const p = C.preimageDepositPlancks(4096, 1); // footprint size + 1 noted preimage
  assert.equal(C.fmtQTC(p), "0.05097");
});

// --- formatting ----------------------------------------------------------------------
t("fmtDuration renders compact human durations", () => {
  assert.equal(C.fmtDuration(690000), "11m");
  assert.equal(C.fmtDuration(783000), "13m");
  assert.equal(C.fmtDuration(45 * 24 * 3600 * 1000), "45d");
  assert.equal(C.fmtDuration(0), "0s");
});
t("heightOfBlockId parses indexer block ids", () => {
  assert.equal(C.heightOfBlockId("0000095606-92d35"), 95606);
  assert.equal(C.heightOfBlockId("0000097141-94b40"), 97141);
  assert.equal(C.heightOfBlockId("garbage"), null);
});
t("isPreimageHash validates 0x + 64 hex", () => {
  assert.ok(C.isPreimageHash("0xb3de57a77b5ccde4cd2c6ac001333b3ac7abc0c10924d892f57d3017adee7524"));
  assert.ok(!C.isPreimageHash("0x1234"));
  assert.ok(!C.isPreimageHash("not-a-hash"));
});
t("parseVoteArgs decodes TechCollective vote args", () => {
  assert.deepEqual(C.parseVoteArgs('{"poll":0,"aye":true}'), { poll: 0, aye: true });
  assert.deepEqual(C.parseVoteArgs('{"poll":2,"aye":false}'), { poll: 2, aye: false });
  assert.equal(C.parseVoteArgs("junk"), null);
});
t("parseProposalCalls decodes the indexer proposal_calls JSON", () => {
  const calls = C.parseProposalCalls('[{"name":"System.authorize_upgrade","pallet":"System","method":"authorize_upgrade"}]');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "authorize_upgrade");
  assert.deepEqual(C.parseProposalCalls("junk"), []);
});
t("latestTally picks the newest event carrying a tally", () => {
  const evs = [
    { type: "SUBMITTED", tally_ayes: null, timestamp: "2026-09-23T08:14:00Z" },
    { type: "DECISION_STARTED", tally_ayes: "1", tally_nays: "0", tally_bare_ayes: "1", timestamp: "2026-09-23T08:25:00Z" },
    { type: "CONFIRMED", tally_ayes: "8", tally_nays: "0", tally_bare_ayes: "8", timestamp: "2026-09-23T12:45:00Z" }
  ];
  const tl = C.latestTally(evs);
  assert.equal(tl.ayes, 8);
  assert.equal(tl.nays, 0);
  assert.equal(tl.bare_ayes, 8);
});

console.log("\n" + passed + " tests passed");
