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

/* --- snapshot load boundary (moved from app.js in the relations round) -----
 * The renderers dereference event fields blindly (e.type.toLowerCase() in
 * the timeline, parseFloat tallies, new Date on fetched_at), so one poisoned
 * row used to wipe the whole board, render "NaN ayes", or print
 * "Invalid Date". Core corruption — an unparseable fetched_at, a non-array
 * collection, or a snapshot whose referendum events are ALL invalid — fails
 * the load honestly; malformed rows drop individually and the board renders
 * from the survivors, re-sorted into chronological order so status/tally
 * derivation sees the true sequence. The fetched_at must also be a REAL
 * capture time (fleet bounds: genesis floor 2026-09-01, now+1h ceiling) —
 * a parseable 2020 or 2999 stamp used to be rendered verbatim as the
 * board's snapshot provenance.
 *
 * Round 2 (relations): shapes per field are not a boundary — the values
 * must also satisfy the relations the producer (fetch-governance-data.mjs
 * over the indexer's tech_referendum_event / extrinsic / runtime_upgrade
 * tables, themselves mirrors of the runtime) guarantees:
 *  - every row timestamp is a chain time INSIDE the capture: at/after the
 *    genesis floor and no later than fetched_at + 60s of indexer/clock
 *    slack — an event dated after the snapshot that contains it, or before
 *    the chain existed, is not that snapshot's event;
 *  - tallies are TechCollective MEMBER counts (the runtime Tally struct is
 *    all-or-none per event): each field <= GOV.max_member_count, ayes+nays
 *    <= max_member_count (one vote per member), bare_ayes <= ayes (the bare
 *    count is the no-conviction subset of ayes);
 *  - one referendum lives on ONE track and each lifecycle type occurs ONCE
 *    per referendum: later events claiming another track, and duplicate
 *    (index, type) rows, drop — the earliest event defines the group;
 *  - track_name is a DERIVED field of track (the TRACKS table) and origin
 *    is pinned per track in the same table: the stored name is re-derived,
 *    a disagreeing origin is nulled, never painted as the lane's origin;
 *  - proposal_preimage_hash is a 32-byte hash or null; block_id must carry
 *    a plausible height (1..10,000,000, the fleet ceiling) or it is nulled;
 *  - extrinsic success is a boolean (a string "false" is neither), its
 *    index_in_block a count, its args capped; exact duplicate extrinsic
 *    and upgrade rows dedupe first-wins (a vote painted twice is a voter
 *    invented).
 *
 * Round 3 (lifecycle + identity): stages are ordered by the runtime —
 * no event stamped before a prerequisite stage, no event after a
 * terminal, TIMED_OUT never coexists with DECISION_STARTED — and all
 * events of a referendum restate one proposal identity (preimage hash,
 * size, is_runtime_upgrade from the earliest event). See validateSnapshot.
 *
 * Round 4 (extrinsics producer cap): shapes and relations bound what a
 * row may claim, but no round bounded how MANY extrinsic rows the load
 * walks — cleanExtrinsic, the JSON.stringify dedupe key and the sort ran
 * over the whole array, so a crafted snapshot carrying 200,000 distinct
 * valid rows was accepted whole (1,037.7 ms in Node) before the votes
 * and treasury views could paint. The producer queries the indexer with
 * extrinsic(limit: 500), so a producer-shaped snapshot can never carry
 * more than MAX_EXTRINSICS rows: the raw length is checked before any
 * row is cleaned and an over-cap snapshot fails honestly — truncating
 * to the first 500 would paint the EARLIEST activity as complete and
 * silently drop the newest governance actions. */
var ADDR_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/; // prefix-189 shape (qz + 47 base58), as in Vesting Desk
var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // chain exists from Sept 2026
var MAX_CHAIN_HEIGHT = 10000000; // fleet plausible-height ceiling
var MAX_REFERENDUM_INDEX = 1000000; // fleet governance-count ceiling (Watchtower MAX_GOV_COUNT)
var MAX_ARGS_CHARS = 16384;
var MAX_EXTRINSICS = 500; // producer cap: fetch-governance-data.mjs queries extrinsic(limit: 500)

function nonNegInt(v) {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }
  return null;
}
function strOrNull(v) { return typeof v === "string" ? v : null; }
function chainTimeMs(v, fetchedMs) {
  if (typeof v !== "string") return null;
  var ms = Date.parse(v);
  if (!isFinite(ms)) return null;
  if (ms < GENESIS_FLOOR_MS || ms > fetchedMs + 60000) return null;
  return ms;
}
function cleanBlockId(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !/^0*\d+-[0-9a-fA-F]+$/.test(v)) return null;
  var h = heightOfBlockId(v);
  return h !== null && h >= 1 && h <= MAX_CHAIN_HEIGHT ? v : null;
}

function cleanRefEvent(raw, fetchedMs) {
  if (!raw || typeof raw !== "object") return null;
  var idx = nonNegInt(raw.referendum_index);
  if (idx === null || idx > MAX_REFERENDUM_INDEX) return null;
  if (typeof raw.type !== "string" || !STATUS_META[raw.type]) return null;
  if (chainTimeMs(raw.timestamp, fetchedMs) === null) return null;
  var track = nonNegInt(raw.track);
  var trackObj = track === null ? null : trackById(track);
  if (!trackObj) return null; // unknown track: no honest thresholds exist for it
  // Tally relation: the runtime Tally is one struct — its fields arrive
  // all-or-none — and its counts are member counts under the runtime cap.
  var tallyFields = ["tally_ayes", "tally_nays", "tally_bare_ayes"];
  var tally = {}, present = 0;
  for (var i = 0; i < tallyFields.length; i++) {
    var f = tallyFields[i];
    if (raw[f] === null || raw[f] === undefined) { tally[f] = null; continue; }
    var tv = nonNegInt(raw[f]);
    if (tv === null || tv > GOV.max_member_count) return null;
    tally[f] = tv; present++;
  }
  if (present && present !== tallyFields.length) return null; // partial tally: not a producer row
  if (present && tally.tally_ayes + tally.tally_nays > GOV.max_member_count) return null;
  if (present && tally.tally_bare_ayes > tally.tally_ayes) return null;
  var size = nonNegInt(raw.proposal_size_bytes);
  if (size !== null && size > GOV.max_proposal_size_bytes) size = null; // implausible size: show "—", never a fabricated deposit
  var origin = strOrNull(raw.origin);
  if (origin !== null && origin !== trackObj.origin) origin = null; // origin is pinned per track
  return {
    referendum_index: idx, track: track,
    track_name: trackObj.name, type: raw.type, // track_name re-derived from track
    title: strOrNull(raw.title), description: strOrNull(raw.description),
    origin: origin,
    is_runtime_upgrade: raw.is_runtime_upgrade === true,
    tally_ayes: raw.tally_ayes == null ? null : raw.tally_ayes,
    tally_nays: raw.tally_nays == null ? null : raw.tally_nays,
    tally_bare_ayes: raw.tally_bare_ayes == null ? null : raw.tally_bare_ayes,
    proposal_preimage_hash: raw.proposal_preimage_hash == null ? null :
      (isPreimageHash(raw.proposal_preimage_hash) ? raw.proposal_preimage_hash : null),
    proposal_size_bytes: size,
    proposal_calls: strOrNull(raw.proposal_calls),
    proposal_summary: strOrNull(raw.proposal_summary),
    proposal_storage: strOrNull(raw.proposal_storage),
    timestamp: raw.timestamp,
    actor_id: typeof raw.actor_id === "string" && ADDR_RE.test(raw.actor_id) ? raw.actor_id : null,
    block_id: cleanBlockId(raw.block_id),
    extrinsic_id: strOrNull(raw.extrinsic_id)
  };
}

function cleanExtrinsic(raw, fetchedMs) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.pallet !== "string" || !raw.pallet || raw.pallet.length > 64) return null;
  if (typeof raw.call !== "string" || !raw.call || raw.call.length > 64) return null;
  if (chainTimeMs(raw.timestamp, fetchedMs) === null) return null;
  var args = raw.args === undefined ? null : raw.args;
  if (typeof args === "string" && args.length > MAX_ARGS_CHARS) args = null;
  else if (args !== null && typeof args !== "string" && typeof args !== "object") args = null;
  return {
    pallet: raw.pallet, call: raw.call, timestamp: raw.timestamp,
    signer_id: typeof raw.signer_id === "string" && ADDR_RE.test(raw.signer_id) ? raw.signer_id : null,
    block_id: cleanBlockId(raw.block_id),
    success: raw.success === true ? true : raw.success === false ? false : null,
    args: args,
    index_in_block: raw.index_in_block === undefined ? null : nonNegInt(raw.index_in_block)
  };
}

function cleanUpgrade(raw, fetchedMs) {
  if (!raw || typeof raw !== "object") return null;
  if (chainTimeMs(raw.timestamp, fetchedMs) === null) return null;
  return { id: strOrNull(raw.id), block_id: cleanBlockId(raw.block_id), timestamp: raw.timestamp };
}

function byTimestamp(a, b) { return Date.parse(a.timestamp) - Date.parse(b.timestamp); }

function validateSnapshot(raw, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.ok !== undefined && raw.ok !== true) return null;
  var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
  var d = raw.data && typeof raw.data === "object" ? raw.data : raw;
  var fetched = d.fetched_at || raw.fetched_at;
  if (typeof fetched !== "string" || !isFinite(Date.parse(fetched))) return null;
  var fetchedMs = Date.parse(fetched);
  if (fetchedMs < GENESIS_FLOOR_MS || fetchedMs > now + 3600000) return null;
  if (!Array.isArray(d.referenda)) return null;
  if (d.extrinsics !== undefined && !Array.isArray(d.extrinsics)) return null;
  if (d.upgrades !== undefined && !Array.isArray(d.upgrades)) return null;
  if (d.extrinsics !== undefined && d.extrinsics.length > MAX_EXTRINSICS) return null; // round 4: producer cap, on raw length before any row is cleaned
  var refs = [];
  d.referenda.forEach(function (r) { var c = cleanRefEvent(r, fetchedMs); if (c) refs.push(c); });
  if (d.referenda.length && !refs.length) return null; // claimed referenda, none valid — fail honestly, never an empty-board lie
  refs.sort(byTimestamp);
  // Referendum identity: one track per referendum, one row per lifecycle
  // type — the earliest surviving event defines both, later violators drop.
  var groupTrack = {}, seenType = {}, keptRefs = [];
  refs.forEach(function (r) {
    var k = String(r.referendum_index);
    if (seenType[k + "|" + r.type]) return;
    if (groupTrack[k] !== undefined && groupTrack[k] !== r.track) return;
    seenType[k + "|" + r.type] = true;
    if (groupTrack[k] === undefined) groupTrack[k] = r.track;
    keptRefs.push(r);
  });
  refs = keptRefs;
  // Round 3 (lifecycle + identity relations): the surviving events of one
  // referendum are ONE proposal's lifecycle, and the runtime orders it —
  // a stage cannot be stamped before a stage that must precede it
  // (SUBMITTED < DECISION_STARTED < CONFIRM_STARTED < any terminal), no
  // event can follow a terminal event (a terminal ends the lifecycle;
  // indices are never reused), and TIMED_OUT by definition means the
  // referendum never entered the deciding queue, so it cannot coexist
  // with a DECISION_STARTED at or before it. Every event also restates
  // the SAME proposal: the earliest event's preimage hash, size and
  // is_runtime_upgrade are the proposal's identity, and a later event
  // contradicting a stated field is not that proposal's event (a null
  // hash/size is absence, not contradiction). Violators drop; the
  // referendum's honest events stand. Verified on the real snapshot
  // (referendum #0, capture 2026-10-14): stages strictly ordered in
  // time and block height, one hash/size/upgrade flag across all rows.
  var STAGE = { SUBMITTED: 0, DECISION_STARTED: 1, CONFIRM_STARTED: 2,
    CONFIRMED: 3, REJECTED: 3, CANCELLED: 3, KILLED: 3, TIMED_OUT: 3 };
  var groups3 = {};
  refs.forEach(function (r) {
    var k = String(r.referendum_index);
    if (!groups3[k]) groups3[k] = [];
    groups3[k].push(r);
  });
  var lifeRefs = [];
  Object.keys(groups3).forEach(function (k) {
    var g = groups3[k]; // chronological (refs sorted above)
    var idHash = null, idSize = null, idUpgrade = g[0].is_runtime_upgrade;
    for (var i = 0; i < g.length; i++) {
      if (idHash === null && g[i].proposal_preimage_hash !== null) idHash = g[i].proposal_preimage_hash;
      if (idSize === null && g[i].proposal_size_bytes !== null) idSize = g[i].proposal_size_bytes;
    }
    // Pass A (prerequisites): an event stamped before a stage that must
    // precede it drops — including a terminal stamped before its own
    // prerequisites, which therefore ends nothing.
    var passA = g.filter(function (r) {
      var t = Date.parse(r.timestamp), stage = STAGE[r.type];
      for (var i = 0; i < g.length; i++) {
        var o = g[i]; if (o === r) continue;
        var ot = Date.parse(o.timestamp), os = STAGE[o.type];
        if (os < stage && ot > t) return false;
        if (r.type === "TIMED_OUT" && o.type === "DECISION_STARTED" && ot <= t) return false;
      }
      return true;
    });
    // Pass B (finality): among the lifecycle-valid survivors, an event
    // stamped after a terminal event drops — the terminal ended it.
    var passB = passA.filter(function (r) {
      var t = Date.parse(r.timestamp);
      for (var i = 0; i < passA.length; i++) {
        var o = passA[i]; if (o === r) continue;
        if (STAGE[o.type] === 3 && Date.parse(o.timestamp) < t) return false;
      }
      return true;
    });
    passB.forEach(function (r) {
      if (r.proposal_preimage_hash !== null && idHash !== null && r.proposal_preimage_hash !== idHash) return;
      if (r.proposal_size_bytes !== null && idSize !== null && r.proposal_size_bytes !== idSize) return;
      if (r.is_runtime_upgrade !== idUpgrade) return;
      lifeRefs.push(r);
    });
  });
  lifeRefs.sort(byTimestamp);
  if (refs.length && !lifeRefs.length) return null; // every claimed event violated its lifecycle — fail honestly
  refs = lifeRefs;
  var exts = [], seenExt = {};
  (d.extrinsics || []).forEach(function (x) {
    var c = cleanExtrinsic(x, fetchedMs); if (!c) return;
    var k = JSON.stringify([c.timestamp, c.pallet, c.call, c.signer_id, c.block_id, c.index_in_block]);
    if (seenExt[k]) return;
    seenExt[k] = true;
    exts.push(c);
  });
  exts.sort(byTimestamp);
  var ups = [], seenUp = {};
  (d.upgrades || []).forEach(function (u) {
    var c = cleanUpgrade(u, fetchedMs); if (!c) return;
    var k = c.id !== null ? "id|" + c.id : JSON.stringify([c.timestamp, c.block_id]);
    if (seenUp[k]) return;
    seenUp[k] = true;
    ups.push(c);
  });
  ups.sort(byTimestamp);
  return { referenda: refs, extrinsics: exts, upgrades: ups, fetched_at: fetched };
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
    isPreimageHash: isPreimageHash, parseVoteArgs: parseVoteArgs, parseProposalCalls: parseProposalCalls,
    validateSnapshot: validateSnapshot, cleanRefEvent: cleanRefEvent,
    cleanExtrinsic: cleanExtrinsic, cleanUpgrade: cleanUpgrade,
    GENESIS_FLOOR_MS: GENESIS_FLOOR_MS, ADDR_RE: ADDR_RE,
    MAX_EXTRINSICS: MAX_EXTRINSICS
  };
}
