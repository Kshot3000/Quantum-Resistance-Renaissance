/* QTC Governance Tracker — page renderer. Reads the same-origin governance snapshot. */
"use strict";
/* global TRACKS, GOV, STATUS_META, statusOf, groupByReferendum, latestTally,
   approvalOf, supportOf, minAyesFor, minAyesVsNays, verdictFor,
   preimageDepositPlancks, fmtQTC, fmtDuration, fmtDateTime, shortAddr,
   heightOfBlockId, isPreimageHash, parseVoteArgs, parseProposalCalls, trackById, blocksToMs */

var SNAPSHOT = "../../data/governance.json";

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function loadSnapshot() {
  // QA hook: headless file:// cannot fetch() across origins, so the QA harness may
  // inject the snapshot (the real data/governance.json content) before navigation.
  if (typeof window !== "undefined" && window.__qgov_mock) {
    var mk = window.__qgov_mock;
    var d = mk.data || mk;
    d.fetched_at = d.fetched_at || mk.fetched_at || null;
    return Promise.resolve(d);
  }
  return fetch(SNAPSHOT, { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error("snapshot HTTP " + r.status);
    return r.json();
  }).then(function (j) {
    var d = j.data || j;
    d.fetched_at = d.fetched_at || j.fetched_at;
    if (!d.referenda) throw new Error("snapshot missing referenda");
    return d;
  });
}

// --- referendum cards ----------------------------------------------------------
function eventLabel(type) {
  var map = {
    SUBMITTED: "Submitted", DECISION_STARTED: "Decision started",
    CONFIRM_STARTED: "Confirm started", CONFIRMED: "Confirmed",
    REJECTED: "Rejected", CANCELLED: "Cancelled", KILLED: "Killed", TIMED_OUT: "Timed out"
  };
  return map[type] || type;
}

function renderTimeline(events) {
  var html = '<ol class="timeline">';
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var gap = "";
    if (i > 0) {
      var dt = new Date(e.timestamp) - new Date(events[i - 1].timestamp);
      gap = '<span class="gap">+' + esc(fmtDuration(dt)) + "</span>";
    }
    html += '<li class="tl-' + esc(e.type.toLowerCase()) + '">' +
      '<span class="tl-dot" aria-hidden="true"></span>' +
      '<div><div class="tl-head"><strong>' + esc(eventLabel(e.type)) + "</strong>" + gap + "</div>" +
      '<div class="tl-time">' + esc(fmtDateTime(e.timestamp)) + "</div></div></li>";
  }
  return html + "</ol>";
}

function renderTally(events, track, group) {
  var tl = latestTally(events);
  if (!tl) return '<div class="tally none"><p>No votes recorded yet.</p></div>';
  var members = GOV.genesis_member_count; // indexer reports member votes; genesis = 10
  var v = verdictFor(track, tl.ayes, tl.nays, members);
  function bar(pct, need, label) {
    var w = Math.max(0, Math.min(100, pct === null ? 0 : pct * 100));
    return '<div class="meter-row"><div class="meter-top"><span>' + label + '</span><span class="mono">' +
      (pct === null ? "—" : (pct * 100).toFixed(1) + "%") + " · needs " + (need * 100).toFixed(0) + "%</span></div>" +
      '<div class="meter"><div class="meter-fill ' + (pct !== null && pct >= need ? "ok" : "bad") + '" style="width:' + w.toFixed(1) + '%"></div>' +
      '<div class="meter-need" style="left:' + (need * 100).toFixed(1) + '%"></div></div></div>';
  }
  var html = '<div class="tally">';
  html += '<div class="tally-score"><span class="aye">' + esc(String(tl.ayes)) + " ayes</span>" +
    '<span class="sep">/</span><span class="nay">' + esc(String(tl.nays)) + " nays</span>" +
    (tl.bare_ayes !== null ? '<span class="bare">(bare ayes ' + esc(String(tl.bare_ayes)) + " — no conviction multipliers)</span>" : "") + "</div>";
  html += bar(v.approval, v.needApproval, "Approval — ayes ÷ (ayes + nays)");
  html += bar(v.support, v.needSupport, "Support — ayes ÷ " + members + " members");
  html += '<div class="verdict ' + (v.passes ? "pass" : "fail") + '">' +
    (v.passes ? "✓ Clears both curves" : "✕ Does not clear both curves") +
    ' <span class="fine">member count assumed ' + members + " (genesis collective)</span></div>";
  html += "</div>";
  return html;
}

function renderProposal(group, data) {
  var rep = group.events[0];
  var calls = parseProposalCalls(rep.proposal_calls);
  var callRows = calls.map(function (c) {
    return '<div class="call"><span class="mono">' + esc(c.pallet || "?") + "." + esc(c.method || c.name || "?") + "</span>" +
      (c.summary ? '<span class="fine">' + esc(c.summary) + "</span>" : "") + "</div>";
  }).join("");
  var dep = rep.proposal_size_bytes ? fmtQTC(preimageDepositPlancks(rep.proposal_size_bytes, 1)) + " QTC" : "—";
  return '<div class="proposal">' +
    "<h4>Proposal</h4>" +
    '<div class="prop-grid">' +
    '<div><div class="k">Preimage hash</div><div class="mono hash' + (isPreimageHash(rep.proposal_preimage_hash) ? " ok" : "") + '">' + esc(rep.proposal_preimage_hash || "—") + "</div></div>" +
    '<div><div class="k">Size</div><div class="mono">' + esc(String(rep.proposal_size_bytes || "—")) + " bytes" + (rep.proposal_storage ? ' · storage ' + esc(rep.proposal_storage) : "") + "</div></div>" +
    '<div><div class="k">Preimage deposit</div><div class="mono">' + esc(dep) + '</div></div>' +
    '<div><div class="k">Calls</div>' + (callRows || '<span class="fine">not decoded by indexer</span>') + "</div>" +
    "</div></div>";
}

function renderTrail(group, data) {
  var idx = group.index;
  var rows = [];
  (data.extrinsics || []).forEach(function (x) {
    if (x.pallet === "TechCollective" && x.call === "vote") {
      var va = parseVoteArgs(x.args);
      if (va && va.poll === idx) rows.push({ t: x.timestamp, what: "TechCollective.vote → " + (va.aye ? "aye" : "nay"), who: x.signer_id, ok: x.success });
    } else if (x.pallet === "TechReferenda" || x.pallet === "Preimage") {
      rows.push({ t: x.timestamp, what: x.pallet + "." + x.call, who: x.signer_id, ok: x.success });
    }
  });
  rows.sort(function (a, b) { return new Date(a.t) - new Date(b.t); });
  var html = '<div class="trail"><h4>Extrinsic trail</h4><ol>';
  rows.forEach(function (r) {
    html += "<li><span class='mono'>" + esc(fmtDateTime(r.t).slice(0, 16)) + "</span> " +
      "<strong>" + esc(r.what) + "</strong> <span class='fine'>by " + esc(shortAddr(r.who)) + (r.ok === false ? " · FAILED" : "") + "</span></li>";
  });
  // enacted runtime upgrade shortly after confirmation
  var last = group.events[group.events.length - 1];
  if (last && last.type === "CONFIRMED" && rep0IsRuntimeUpgrade(group)) {
    (data.upgrades || []).forEach(function (u) {
      if (new Date(u.timestamp) > new Date(last.timestamp)) {
        var h = heightOfBlockId(u.block_id);
        html += "<li><span class='mono'>" + esc(fmtDateTime(u.timestamp).slice(0, 16)) + "</span> " +
          "<strong>Runtime upgrade applied</strong> <span class='fine'>block " + (h === null ? esc(u.block_id) : h.toLocaleString("en-US")) + "</span></li>";
      }
    });
  }
  return html + "</ol></div>";
}

function rep0IsRuntimeUpgrade(group) {
  return !!group.events[0].is_runtime_upgrade;
}

function renderReferendum(group, data) {
  var status = statusOf(group.events);
  var meta = STATUS_META[status] || STATUS_META.SUBMITTED;
  var rep = group.events[0];
  var track = trackById(rep.track);
  var proposer = rep.actor_id;
  var html = '<article class="ref-card" id="ref-' + group.index + '">';
  html += '<header class="ref-head"><div class="ref-title"><span class="ref-idx">#' + group.index + "</span>" +
    '<span class="badge ' + meta.cls + '">' + esc(meta.label) + "</span>" +
    (track ? '<span class="badge track">' + esc(track.name) + " · track " + track.id + "</span>" : "") +
    (rep.is_runtime_upgrade ? '<span class="badge upgrade">runtime upgrade</span>' : "") + "</div>" +
    '<div class="ref-origin fine">origin <strong>' + esc(rep.origin || "—") + "</strong>" +
    (proposer ? " · submitted by <span class='mono'>" + esc(shortAddr(proposer)) + "</span>" : "") + "</div></header>";
  html += '<p class="status-blurb">' + esc(meta.blurb) + "</p>";
  html += '<div class="ref-cols"><div class="ref-col">' + renderTimeline(group.events) + "</div>" +
    '<div class="ref-col">' + renderTally(group.events, track || trackById(1), group) + renderProposal(group, data) + "</div></div>";
  html += renderTrail(group, data);
  return html + "</article>";
}

function renderBoard(data) {
  var groups = groupByReferendum(data.referenda || []);
  var confirmed = 0;
  var cards = groups.map(function (g) {
    if (statusOf(g.events) === "CONFIRMED") confirmed++;
    return renderReferendum(g, data);
  }).join("");
  $("stat-refs").textContent = String(groups.length);
  $("stat-confirmed").textContent = String(confirmed);
  if (!groups.length) {
    $("ref-board").innerHTML = '<div class="honest-box"><p>No referenda in the snapshot. The board below explains how the lane works so it is ready when the first referendum lands.</p></div>';
  } else {
    $("ref-board").innerHTML = cards;
  }
  return groups;
}

// --- track cards -------------------------------------------------------------------
function renderTracks() {
  $("track-cards").innerHTML = TRACKS.map(function (tr) {
    function win(blocks) {
      return blocks.toLocaleString("en-US") + " blocks ≈ " + fmtDuration(blocksToMs(blocks));
    }
    return '<div class="track-card"><div class="track-head"><span class="track-id">track ' + tr.id + "</span>" +
      '<h3>' + esc(tr.name) + "</h3><span class='track-tag'>" + esc(tr.label) + "</span></div>" +
      '<p class="track-purpose">' + esc(tr.purpose) + "</p>" +
      '<dl class="track-dl">' +
      "<div><dt>Prepare</dt><dd>" + esc(win(tr.prepare_blocks)) + "</dd></div>" +
      "<div><dt>Decision</dt><dd>" + esc(win(tr.decision_blocks)) + "</dd></div>" +
      "<div><dt>Confirm</dt><dd>" + esc(win(tr.confirm_blocks)) + "</dd></div>" +
      "<div><dt>Min enactment</dt><dd>" + esc(win(tr.min_enactment_blocks)) + "</dd></div>" +
      "<div><dt>Approval curve</dt><dd>" + (tr.min_approval * 100).toFixed(0) + "% constant</dd></div>" +
      "<div><dt>Support curve</dt><dd>" + (tr.min_support * 100).toFixed(0) + "% constant</dd></div>" +
      "<div><dt>Decision deposit</dt><dd>" + esc(fmtQTC(tr.decision_deposit_plancks)) + " QTC</dd></div>" +
      "<div><dt>Proposals from</dt><dd>" + esc(tr.origin) + "</dd></div>" +
      "</dl>" +
      '<p class="fine">' + esc(tr.submit_note) + "</p></div>";
  }).join("");
}

// --- threshold lab -----------------------------------------------------------------
function renderLab() {
  var trackSel = $("lab-track"), mEl = $("lab-members"), aEl = $("lab-ayes"), nEl = $("lab-nays");
  function update() {
    var track = trackById(parseInt(trackSel.value, 10)) || TRACKS[1];
    var m = +mEl.value, a = +aEl.value, n = +nEl.value;
    $("lab-members-v").textContent = m;
    $("lab-ayes-v").textContent = a;
    $("lab-nays-v").textContent = n;
    aEl.max = m; nEl.max = m;
    if (a > m) { aEl.value = m; a = m; }
    var v = verdictFor(track, a, n, m);
    var need = minAyesFor(track, m);
    var needVsNays = minAyesVsNays(track, n);
    function row(label, val, req) {
      var txt = val === null ? "—" : (val * 100).toFixed(1) + "%";
      var cls = val !== null && val >= req ? "ok" : "bad";
      return '<div class="lab-row"><span>' + label + '</span><span class="mono ' + cls + '">' + txt + " / needs " + (req * 100).toFixed(0) + "%</span></div>";
    }
    var html = '<div class="lab-verdict ' + (v.passes ? "pass" : "fail") + '">' +
      (v.passes ? "✓ PASSES " + esc(track.name) : "✕ FAILS " + esc(track.name)) + "</div>";
    html += row("Approval", v.approval, v.needApproval);
    html += row("Support", v.support, v.needSupport);
    html += '<div class="lab-hint fine">Needs at least <strong>' + need + " ayes</strong> of " + m +
      " members with no nays" + (n > 0 ? "; with " + n + " nay" + (n > 1 ? "s" : "") + ", approval alone needs <strong>" + needVsNays + " ayes</strong>" : "") + ".</div>";
    $("lab-out").innerHTML = html;
  }
  [trackSel, mEl, aEl, nEl].forEach(function (el) { el.addEventListener("input", update); el.addEventListener("change", update); });
  update();
}

// --- votes table -------------------------------------------------------------------
function renderVotes(data) {
  var tb = document.querySelector("#votes-table tbody");
  var votes = (data.extrinsics || []).filter(function (x) {
    return x.pallet === "TechCollective" && x.call === "vote";
  }).map(function (x) {
    var va = parseVoteArgs(x.args);
    return { t: x.timestamp, who: x.signer_id, poll: va ? va.poll : null, aye: va ? va.aye : null };
  }).sort(function (a, b) { return new Date(a.t) - new Date(b.t); });
  if (!votes.length) {
    tb.innerHTML = '<tr><td colspan="3" class="fine">No collective votes in the snapshot.</td></tr>';
    return;
  }
  tb.innerHTML = votes.map(function (v) {
    return "<tr><td class='mono'>" + esc(fmtDateTime(v.t)) + "</td>" +
      "<td class='mono'>" + esc(v.who || "—") + "</td>" +
      "<td><span class='vote-" + (v.aye ? "aye" : "nay") + "'>" + (v.aye === null ? "—" : v.aye ? "aye" : "nay") + "</span>" +
      (v.poll !== null ? " <span class='fine'>poll " + v.poll + "</span>" : "") + "</td></tr>";
  }).join("");
}

// --- treasury ----------------------------------------------------------------------
function renderTreasury(data) {
  var hits = (data.extrinsics || []).filter(function (x) {
    return /treasury/i.test(x.pallet || "") || /treasury/i.test(x.call || "");
  });
  if (!hits.length) {
    $("treasury-status").innerHTML = "<p><strong>No treasury activity observed on chain yet.</strong> The indexer snapshot contains no TreasuryPallet extrinsics or treasury events. When the collective starts spending, proposals will appear here with the same lifecycle tracking as referenda.</p>" +
      "<p class='fine'>Spend path: a member submits <code>propose_spend</code> through the tech-collective lane; a confirmed referendum dispatches it.</p>";
  } else {
    $("treasury-status").innerHTML = "<p><strong>" + hits.length + " treasury-related calls</strong> observed:</p><ul class='bullets'>" +
      hits.map(function (h) { return "<li><span class='mono'>" + esc(fmtDateTime(h.timestamp)) + "</span> " + esc(h.pallet) + "." + esc(h.call) + " by " + esc(shortAddr(h.signer_id)) + "</li>"; }).join("") + "</ul>";
  }
}

// --- boot --------------------------------------------------------------------------
function boot() {
  renderTracks();
  renderLab();
  drawSeal();
  loadSnapshot().then(function (data) {
    renderBoard(data);
    renderVotes(data);
    renderTreasury(data);
    $("stat-snapshot").textContent = data.fetched_at ?
      new Date(data.fetched_at).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT" : "live";
  }).catch(function (e) {
    $("ref-board").innerHTML = '<div class="honest-box"><p><strong>Governance data unavailable.</strong> The snapshot could not be loaded (' + esc(e.message) + ") — no figures are shown rather than invented ones. The track map, threshold lab, and lifecycle below are still exact: they come from the runtime source.</p></div>";
    $("votes-table").querySelector("tbody").innerHTML = '<tr><td colspan="3" class="fine">Votes unavailable — snapshot failed to load.</td></tr>';
    $("treasury-status").innerHTML = "<p><strong>Treasury status unknown</strong> — snapshot failed to load.</p>";
    $("stat-snapshot").textContent = "offline";
  });
}

// --- ambient seal canvas -------------------------------------------------------------
function drawSeal() {
  var c = $("seal");
  if (!c || !c.getContext) return;
  var ctx = c.getContext("2d");
  function size() { c.width = innerWidth; c.height = innerHeight; }
  size(); addEventListener("resize", size);
  var t = 0;
  (function frame() {
    t += 0.0016;
    ctx.clearRect(0, 0, c.width, c.height);
    var cx = c.width / 2, cy = c.height * 0.32;
    for (var i = 0; i < 3; i++) {
      var r = 120 + i * 90 + Math.sin(t * 3 + i) * 6;
      ctx.beginPath();
      ctx.arc(cx, cy, r, t * (i % 2 ? -1 : 1), t * (i % 2 ? -1 : 1) + Math.PI * 1.5);
      ctx.strokeStyle = "rgba(212,167,44," + (0.10 - i * 0.025) + ")";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    requestAnimationFrame(frame);
  })();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
