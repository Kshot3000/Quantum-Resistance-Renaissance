/* QTC Governance Tracker — pure logic (no DOM).
 * Every constant below is read from Quantus-Network/chain main (2026-09-30):
 *   runtime/src/governance/definitions.rs  — track windows, curves, deposits, preimage model
 *   runtime/src/configs/mod.rs             — submission deposit, timeouts, member bounds, Tally
 *   runtime/src/lib.rs                     — TARGET_BLOCK_TIME_MS=12000, UNIT, FEE_SCALE 1/10
 */
"use strict";

var PLANCKS_PER_QTC = 1000000000000n; // 10^12
var BLOCK_TIME_MS = 12000;

// --- fee scale: every absolute-QTC runtime price runs through scale_fee (1/10) ---
function scaleFee(basePlancks) { return (basePlancks * 1n) / 10n; }

// --- Governance tracks: TechCollectiveTracksInfo (runtime/src/governance/definitions.rs) ---
// Curves are Constant (LinearDecreasing with floor == ceil), so thresholds never decay.
var TRACKS = [
  {
    id: 0,
    name: "tech_collective_members",
    label: "Tech lane",
    purpose: "Root proposals — membership changes, treasury-grade Root calls",
    origin: "Root",
    prepare_blocks: 2 * 300,      // 2 * HOURS (HOURS = 300 blocks @12s)
    decision_blocks: 7200,        // DAYS
    confirm_blocks: 7200,         // DAYS
    min_enactment_blocks: 7200,   // DAYS
    min_approval: 0.61,
    min_support: 0.60,
    decision_deposit_plancks: 100000000000n, // scale_fee(UNIT) = 0.1 QTC
    submit_note: "SubmitOrigin = Root or tech-collective member"
  },
  {
    id: 1,
    name: "fast_upgrade",
    label: "Fast upgrade",
    purpose: "Emergency runtime-upgrade lane — System.authorize_upgrade ONLY, never arbitrary Root",
    origin: "FastUpgrade",
    prepare_blocks: 50,           // 10 * MINUTES (MINUTES = 5 blocks @12s)
    decision_blocks: 7200,        // DAYS
    confirm_blocks: 50,           // 10 * MINUTES
    min_enactment_blocks: 50,     // 10 * MINUTES
    min_approval: 0.80,
    min_support: 0.80,
    decision_deposit_plancks: 100000000000n, // scale_fee(UNIT) = 0.1 QTC
    submit_note: "SubmitOrigin = Root or tech-collective member; FastUpgrade origin honored only by System.authorize_upgrade"
  }
];

// --- chain-wide governance bounds (runtime/src/configs/mod.rs) ---
var GOV = {
  submission_deposit_plancks: 100000000000n, // scale_fee(UNIT) = 0.1 QTC
  undeciding_timeout_blocks: 45 * 7200,      // 45 * DAYS — submit with no decision deposit → TimedOut
  max_active: 128,
  max_active_per_account: 8,
  max_queued_per_track: 100,
  max_proposal_size_bytes: 4096,
  max_member_count: 13,
  min_member_count: 5,          // MIN_TECH_COLLECTIVE_MEMBERS — the curves assume ≥5
  genesis_member_count: 10,     // per upstream comment: fast_upgrade needs "8-of-10 ayes"
  preimage_base_plancks: 10000000000n,  // scale_fee(UNIT/10) = 0.01 QTC
  preimage_per_byte_plancks: 10000000n  // scale_fee(UNIT/10000) = 0.00001 QTC/byte
};

function trackById(id) {
  for (var i = 0; i < TRACKS.length; i++) if (TRACKS[i].id === id) return TRACKS[i];
  return null;
}

function blocksToMs(blocks) { return blocks * BLOCK_TIME_MS; }

// --- referendum status from its event stream ---------------------------------
// Terminal states take precedence; otherwise the latest non-terminal milestone wins.
var TERMINAL = { KILLED: 5, CANCELLED: 4, TIMED_OUT: 3, REJECTED: 2, CONFIRMED: 1 };
var PROGRESS = { CONFIRM_STARTED: 4, DECISION_STARTED: 3, SUBMITTED: 2 };
var STATUS_META = {
  SUBMITTED:        { label: "Submitted",       cls: "st-submitted",  blurb: "On chain, waiting for a decision deposit to enter the track queue." },
  DECISION_STARTED: { label: "Deciding",        cls: "st-deciding",   blurb: "Decision deposit placed — the collective can vote; approval/support curves apply." },
  CONFIRM_STARTED:  { label: "Confirming",     cls: "st-confirming", blurb: "Tally crossed the confirm threshold — a final quiet period before approval." },
  CONFIRMED:        { label: "Confirmed",       cls: "st-confirmed",  blurb: "Approved and queued for enactment after the track's min-enactment window." },
  REJECTED:         { label: "Rejected",       cls: "st-rejected",   blurb: "Failed the decision — deposits returned, proposal discarded." },
  CANCELLED:        { label: "Cancelled",       cls: "st-cancelled",  blurb: "Cancelled by Root — deposits slashed (burned)." },
  KILLED:           { label: "Killed",          cls: "st-killed",     blurb: "Killed by Root while not passing — deposits slashed (burned)." },
  TIMED_OUT:        { label: "Timed out",       cls: "st-timedout",   blurb: "Never entered the deciding queue — rejected after the 45-day undeciding timeout." }
};

function statusOf(events) {
  var bestTerminal = null, bestTerminalRank = -1;
  var bestProgress = null, bestProgressRank = -1;
  for (var i = 0; i < events.length; i++) {
    var t = events[i] && events[i].type;
    if (TERMINAL[t] && TERMINAL[t] > bestTerminalRank) { bestTerminal = t; bestTerminalRank = TERMINAL[t]; }
    else if (PROGRESS[t] && PROGRESS[t] > bestProgressRank) { bestProgress = t; bestProgressRank = PROGRESS[t]; }
  }
  return bestTerminal || bestProgress || "SUBMITTED";
}

function groupByReferendum(events) {
  var groups = {}, order = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i], k = String(e.referendum_index);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(e);
  }
  order.sort(function(a, b) { return parseInt(a, 10) - parseInt(b, 10); });
  return order.map(function(k) { return { index: parseInt(k, 10), events: groups[k] }; });
}

function latestTally(events) {
  for (var i = events.length - 1; i >= 0; i--) {
    var e = events[i];
    if (e.tally_ayes !== null && e.tally_ayes !== undefined) {
      return {
        ayes: parseFloat(e.tally_ayes),
        nays: parseFloat(e.tally_nays || "0"),
        bare_ayes: e.tally_bare_ayes !== null && e.tally_bare_ayes !== undefined ? parseFloat(e.tally_bare_ayes) : null,
        at: e.timestamp
      };
    }
  }
  return null;
}

// --- threshold math (flat curves: approval = ayes/(ayes+nays), support = ayes/members) ---
function approvalOf(ayes, nays) {
  ayes = +ayes; nays = +nays;
  if (ayes + nays <= 0) return null;
  return ayes / (ayes + nays);
}
function supportOf(ayes, members) {
  ayes = +ayes; members = +members;
  if (!(members > 0)) return null;
  return ayes / members;
}
// Minimum ayes (zero nays) to clear BOTH curves for a track with M members.
// With no nays, approval = 100% — so support is the binding constraint.
function minAyesFor(track, members) {
  members = Math.max(1, Math.floor(+members || 1));
  return Math.ceil(track.min_support * members - 1e-9);
}
// Minimum ayes to clear approval when nays > 0 (support handled separately).
function minAyesVsNays(track, nays) {
  nays = Math.max(0, Math.floor(+nays || 0));
  if (track.min_approval >= 1) return nays === 0 ? 1 : Infinity;
  return Math.ceil((track.min_approval / (1 - track.min_approval)) * nays);
}
function verdictFor(track, ayes, nays, members) {
  ayes = +ayes; nays = +nays; members = +members;
  var approval = approvalOf(ayes, nays);
  var support = supportOf(ayes, members);
  var okApproval = approval !== null && approval >= track.min_approval;
  var okSupport = support !== null && support >= track.min_support;
  return {
    approval: approval, support: support,
    needApproval: track.min_approval, needSupport: track.min_support,
    okApproval: okApproval, okSupport: okSupport,
    passes: okApproval && okSupport
  };
}

// --- preimage deposit: scale_fee(UNIT/10) + scale_fee(UNIT/10000) * (size + count) ---
function preimageDepositPlancks(bytes, count) {
  var b = BigInt(Math.max(0, Math.floor(+bytes || 0)));
  var c = BigInt(Math.max(1, Math.floor(+count || 1)));
  return GOV.preimage_base_plancks + GOV.preimage_per_byte_plancks * (b + c);
}

// --- formatting ---------------------------------------------------------------
function fmtQTC(plancksBig) {
  var p = BigInt(plancksBig);
  var neg = p < 0n; if (neg) p = -p;
  var whole = p / PLANCKS_PER_QTC;
  var frac = (p % PLANCKS_PER_QTC).toString().padStart(12, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}
function fmtDuration(ms) {
  ms = Math.max(0, +ms || 0);
  var s = Math.round(ms / 1000);
  var d = Math.floor(s / 86400); s -= d * 86400;
  var h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  var out = [];
  if (d) out.push(d + "d");
  if (h) out.push(h + "h");
  if (m) out.push(m + "m");
  if (!out.length) out.push(s + "s");
  return out.slice(0, 2).join(" ");
}
function fmtDateTime(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
function shortAddr(a) {
  a = String(a || "");
  return a.length > 16 ? a.slice(0, 8) + "…" + a.slice(-6) : a;
}
// block ids look like "0000095606-92d35" — the height is the leading number.
function heightOfBlockId(blockId) {
  var m = /^0*(\d+)-/.exec(String(blockId || ""));
  return m ? parseInt(m[1], 10) : null;
}
function isPreimageHash(s) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(s || "").trim());
}
function parseVoteArgs(args) {
  try {
    var o = typeof args === "string" ? JSON.parse(args) : args;
    if (o && typeof o.poll !== "undefined" && typeof o.aye !== "undefined")
      return { poll: +o.poll, aye: !!o.aye };
  } catch (e) { /* fall through */ }
  return null;
}
function parseProposalCalls(json) {
  try {
    var arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PLANCKS_PER_QTC: PLANCKS_PER_QTC, BLOCK_TIME_MS: BLOCK_TIME_MS,
    TRACKS: TRACKS, GOV: GOV, STATUS_META: STATUS_META,
    scaleFee: scaleFee, trackById: trackById, blocksToMs: blocksToMs,
    statusOf: statusOf, groupByReferendum: groupByReferendum, latestTally: latestTally,
    approvalOf: approvalOf, supportOf: supportOf,
    minAyesFor: minAyesFor, minAyesVsNays: minAyesVsNays, verdictFor: verdictFor,
    preimageDepositPlancks: preimageDepositPlancks,
    fmtQTC: fmtQTC, fmtDuration: fmtDuration, fmtDateTime: fmtDateTime,
    shortAddr: shortAddr, heightOfBlockId: heightOfBlockId,
    isPreimageHash: isPreimageHash, parseVoteArgs: parseVoteArgs, parseProposalCalls: parseProposalCalls
  };
}
