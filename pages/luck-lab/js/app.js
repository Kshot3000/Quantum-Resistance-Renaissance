/* QTC Luck Lab — app.js
 * UI wiring: live-first chain data, solo/pool simulators, canvas charts.
 * Math lives in luck-core.js (LuckCore global). No modules — plain scripts.
 */
(function () {
  "use strict";
  var L = window.LuckCore;
  var $ = function (id) { return document.getElementById(id); };

  // Fallback bundle — ONE capture, never mixed dates: every field below comes
  // from the 2026-10-03 04:01Z snapshot refresh (consensus @ block 156,769 +
  // supply @ block 156,769, fetched 21 seconds apart). The previous bundle paired
  // Oct 1 difficulty/head with an Oct 2 supply-derived reward, which silently
  // skewed every fallback-painted figure. Guarded by tests/luck-core.test.js
  // (cross-checked against energy-observatory's fallback bundle).
  var state = {
    difficulty: 751434043265225,   // fallback: consensus snapshot 2026-10-03
    netHs: 62619503605435,         // = difficulty / 12 s (indexer est. hashrate)
    reward: 0.3046213,             // fallback: (21M − 5,768,933.6312 total supply) / 50M, same capture
    blocksPerDay: 6248,            // = 86,400,000 / avgBlockMs (consensus 3,000-block sample, same snapshot)
    avgBlockMs: 13828,
    head: 156769,
    fetchedAt: "2026-10-03T04:01:26.612Z",
    source: "snapshot"
  };

  function fmtInt(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /* --- data: live head check first, snapshot for the numbers -------------- */
  function gql(query, timeoutMs) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 6000);
    return fetch("https://sqm.quantus.com/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: query }),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(to);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (j.errors) throw new Error("GraphQL error");
      return j.data;
    }, function (e) { clearTimeout(to); throw e; });
  }

  /* Abort a fetch that never settles: a hung request must fall through to
   * the app's error/fallback path, not strand the page on "Loading…" forever. */
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var ctl = new AbortController();
    setTimeout(function () { ctl.abort(); }, ms);
    return ctl.signal;
  }
  function loadData() {
    var liveHead = null;
    return gql("{ s: chain_stats_by_pk(id: \"global\") { block_height } }", 6000)
      .then(function (d) { liveHead = d && d.s && d.s.block_height; })
      .catch(function () { liveHead = null; })
      .then(function () {
        return Promise.all([
          fetch("../../data/consensus.json", { signal: timeoutSignal(9000) }).then(function (r) { return r.json(); }),
          fetch("../../data/supply.json", { signal: timeoutSignal(9000) }).then(function (r) { return r.json(); })
        ]);
      })
      .then(function (arr) {
        var c = arr[0], s = arr[1];
        state.difficulty = Number(c.current.difficulty);
        state.netHs = Number(c.current.est_hashrate_hs) || state.difficulty / 12;
        state.head = c.current.height;
        state.fetchedAt = c.fetched_at;
        // Total issuance for the emission formula (balances aggregate =
        // Currency::total_issuance(), incl. genesis — NOT mined rewards alone).
        var totalSupply = s.total_supply_plancks ? Number(s.total_supply_plancks)
          : (Number(s.balances_plancks.free) + Number(s.balances_plancks.reserved) + Number(s.balances_plancks.frozen));
        state.reward = L.currentRewardQtc(totalSupply);
        // avg block time from the recent window
        var rec = c.recent;
        if (rec && rec.length > 10) {
          var span = rec[rec.length - 1][1] - rec[0][1];
          var avg = span / (rec.length - 1);
          if (avg > 1000 && avg < 120000) {
            state.avgBlockMs = avg;
            state.blocksPerDay = 86400000 / avg;
          }
        }
        if (liveHead && Math.abs(liveHead - state.head) <= 120) {
          state.source = "live";
          state.head = liveHead;
        } else if (liveHead) {
          state.source = "snapshot-stale";
        }
      })
      .catch(function () { state.source = "snapshot"; });
  }

  /* --- canvas helpers ----------------------------------------------------- */
  function setupCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 960, h = parseInt(cv.getAttribute("height"), 10) || 300;
    cv.width = w * dpr; cv.height = h * dpr;
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function drawSoloHist() {
    var cv = $("solo-hist");
    var s = setupCanvas(cv), ctx = s.ctx, W = s.w, H = s.h;
    var padL = 8, padR = 8, padT = 14, padB = 30;
    var pw = W - padL - padR, ph = H - padT - padB;
    ctx.clearRect(0, 0, W, H);

    var h = readHashrate("solo-h", "solo-hu");
    var trials = parseInt($("solo-trials").value, 10) || 10000;
    var D = state.difficulty;
    var E = L.soloExpectedWaitSec(D, h);
    if (!isFinite(E)) {
      ctx.fillStyle = "#9fd4ae"; ctx.font = "14px sans-serif";
      ctx.fillText("Enter a hashrate above zero to simulate.", padL + 10, 40);
      $("solo-hist-note").textContent = "";
      return;
    }
    var waits = L.simulateSoloWaits(D, h, trials, 20261001);
    var NB = 48, RANGE = 6; // 0..6E
    var bins = new Array(NB + 1).fill(0);
    for (var i = 0; i < waits.length; i++) {
      var u = waits[i] / E;
      var b = u >= RANGE ? NB : Math.floor(u / RANGE * NB);
      bins[b]++;
    }
    var max = Math.max.apply(null, bins);
    var bw = pw / (NB + 1);
    for (var j = 0; j <= NB; j++) {
      var bh = bins[j] / max * ph;
      var grad = ctx.createLinearGradient(0, H - padB - bh, 0, H - padB);
      grad.addColorStop(0, "rgba(52,255,136,0.85)");
      grad.addColorStop(1, "rgba(52,255,136,0.15)");
      ctx.fillStyle = grad;
      ctx.fillRect(padL + j * bw + 0.5, H - padB - bh, bw - 1, bh);
    }
    // gridlines + labels at integer E
    ctx.font = "11px monospace"; ctx.textAlign = "center";
    for (var g = 0; g <= RANGE; g++) {
      var x = padL + g / RANGE * pw;
      ctx.strokeStyle = "rgba(159,212,174,0.18)";
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.fillStyle = "#5e8a6b";
      ctx.fillText(g === 0 ? "now" : L.fmtDuration(g * E), x, H - padB + 16);
    }
    // marker lines: median (green), mean (gold dashed), p90 (red dashed)
    function marker(uE, color, dash, label) {
      var x = padL + Math.min(uE, RANGE) / RANGE * pw;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = color; ctx.textAlign = uE > RANGE * 0.8 ? "right" : "left";
      ctx.fillText(label, x + (uE > RANGE * 0.8 ? -6 : 6), padT + 2);
    }
    marker(Math.LN2, "#4ade80", [], "median");
    marker(1, "#ffd166", [6, 4], "mean");
    marker(Math.log(10), "#f87171", [6, 4], "p90");
    var fracPastMean = waits.filter(function (w) { return w > E; }).length / waits.length;
    $("solo-hist-note").textContent =
      "Seeded run (" + fmtInt(trials) + " trials): " + L.fmtPct(fracPastMean) +
      " of waits ran past the mean — theory says " + L.fmtPct(1 - 1 / Math.E) + ". " +
      "Re-run any time: the seed is fixed, so the picture is reproducible.";
  }

  function drawPoolHist() {
    var cv = $("pool-hist");
    var s = setupCanvas(cv), ctx = s.ctx, W = s.w, H = s.h;
    var padL = 8, padR = 8, padT = 14, padB = 30;
    var pw = W - padL - padR, ph = H - padT - padB;
    ctx.clearRect(0, 0, W, H);

    var h = readHashrate("pool-h", "pool-hu");
    var fee = Math.min(100, Math.max(0, parseFloat($("pool-fee").value) || 0)) / 100;
    var days = parseInt($("pool-days").value, 10) || 90;
    var D = state.difficulty, R = state.reward;

    var solo = L.simulateSoloDailyEarnings(h, D, R, days, 4242);
    var pool = L.simulatePoolDailyEarnings(h, state.netHs, R, fee, state.blocksPerDay, days, 777);
    var exp = L.poolExpectedDailyQtc(h, state.netHs, R, fee, state.blocksPerDay);

    var all = solo.concat(pool);
    var maxV = Math.max.apply(null, all.concat([exp * 1.05, R * 0.5]));
    if (!(maxV > 0)) maxV = 1;
    var NB = 60;
    function hist(vals) {
      var bins = new Array(NB).fill(0);
      for (var i = 0; i < vals.length; i++) {
        var b = Math.min(NB - 1, Math.floor(vals[i] / maxV * NB));
        bins[b]++;
      }
      return bins;
    }
    var hs = hist(solo), hp = hist(pool);
    var mx = Math.max(Math.max.apply(null, hs), Math.max.apply(null, hp), 1);
    var bw = pw / NB;
    function bars(bins, fill) {
      for (var j = 0; j < NB; j++) {
        var bh = bins[j] / mx * ph;
        if (bh <= 0) continue;
        ctx.fillStyle = fill;
        ctx.fillRect(padL + j * bw + 0.5, H - padB - bh, bw - 1, bh);
      }
    }
    bars(hs, "rgba(248,113,113,0.55)");   // solo: red
    bars(hp, "rgba(52,255,136,0.55)");    // pool: emerald
    // expected line
    var ex = padL + exp / maxV * pw;
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(ex, padT); ctx.lineTo(ex, H - padB); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.fillStyle = "#ffd166"; ctx.font = "11px monospace"; ctx.textAlign = "left";
    ctx.fillText("expected " + L.fmtQtc(exp) + " QTC", ex + 6, padT + 2);
    // x labels
    ctx.fillStyle = "#5e8a6b"; ctx.textAlign = "center";
    for (var g = 0; g <= 4; g++) {
      var x = padL + g / 4 * pw;
      ctx.fillText(L.fmtQtc(maxV * g / 4, 2), x, H - padB + 16);
    }
    ctx.textAlign = "right";
    ctx.fillText("QTC / day", W - padR, H - 4);

    var ss = solo.slice().sort(function (a, b) { return a - b; });
    var ps = pool.slice().sort(function (a, b) { return a - b; });
    var soloZero = solo.filter(function (v) { return v === 0; }).length / solo.length;
    $("pool-hist-note").textContent =
      "Seeded " + days + "-day run: solo earned nothing on " + L.fmtPct(soloZero, 0) +
      " of days (median " + L.fmtQtc(L.percentile(ss, 0.5)) + " QTC); pool days ran " +
      L.fmtQtc(L.percentile(ps, 0.1)) + "–" + L.fmtQtc(L.percentile(ps, 0.9)) +
      " QTC (p10–p90) around the " + L.fmtQtc(exp) + " QTC mean. Both strategies share the seed family — compare shapes, not noise.";

    // percentile band card
    $("po-band").textContent = L.fmtQtc(L.percentile(ps, 0.1)) + " – " + L.fmtQtc(L.percentile(ps, 0.9));
    $("po-exp").textContent = L.fmtQtc(exp) + " QTC";
    $("po-tot").textContent = L.fmtQtc(exp * days) + " QTC";
    $("po-share").textContent = state.netHs > 0 ? L.fmtPct(h / state.netHs, 4) : "—";
    var leg = $("pool-legend-label");
    if (leg) leg.textContent = "Pool daily QTC (" + (fee * 100) + "% fee)";
  }

  /* --- inputs ------------------------------------------------------------- */
  function readHashrate(id, uid) {
    var v = parseFloat($(id).value) || 0;
    var mult = parseFloat($(uid).value) || 1;
    return v * mult;
  }

  function renderSolo() {
    var h = readHashrate("solo-h", "solo-hu");
    var D = state.difficulty;
    var E = L.soloExpectedWaitSec(D, h);
    $("so-exp").textContent = L.fmtDuration(E);
    $("so-med").textContent = L.fmtDuration(L.soloQuantileWaitSec(D, h, 0.5));
    $("so-p10").textContent = L.fmtDuration(L.soloQuantileWaitSec(D, h, 0.1));
    $("so-p90").textContent = L.fmtDuration(L.soloQuantileWaitSec(D, h, 0.9));
    $("so-p99").textContent = L.fmtDuration(L.soloQuantileWaitSec(D, h, 0.99));
    var perDay = isFinite(E) ? 86400 / E : 0;
    $("so-rate").textContent = perDay >= 100 ? perDay.toFixed(0) : perDay >= 1 ? perDay.toFixed(2) : perDay.toFixed(4);
    renderProb();
    renderDrought();
    drawSoloHist();
  }

  function renderProb() {
    var h = readHashrate("solo-h", "solo-hu");
    var t = (parseFloat($("prob-t").value) || 0) * (parseFloat($("prob-tu").value) || 86400);
    var p = L.probAtLeastOneBlock(state.difficulty, h, t);
    $("prob-out").textContent = L.fmtPct(p, 2);
  }

  function renderDrought() {
    var h = readHashrate("solo-h", "solo-hu");
    var E = L.soloExpectedWaitSec(h ? state.difficulty : 0, h);
    var tb = $("drought-tbl").querySelector("tbody");
    tb.innerHTML = "";
    [2, 3, 5].forEach(function (k) {
      var p = isFinite(E) ? Math.exp(-k) : 0; // P(wait > kE) = e^-k
      var oneIn = p > 0 ? Math.round(1 / p) : "—";
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>Longer than " + k + "× average" + (isFinite(E) ? " (" + L.fmtDuration(k * E) + ")" : "") +
        "</td><td>" + L.fmtPct(p, 2) + "</td><td>one in " + oneIn + "</td>";
      tb.appendChild(tr);
    });
  }

  function renderScenarios() {
    var h = readHashrate("solo-h", "solo-hu");
    var D = state.difficulty;
    var tb = $("scen-tbl").querySelector("tbody");
    tb.innerHTML = "";
    var rows = [
      { label: "Quarters overnight (×0.25)", r: 0.25 },
      { label: "Halves overnight (×0.5)", r: 0.5 },
      { label: "Doubles overnight (×2)", r: 2 },
      { label: "Quadruples overnight (×4)", r: 4 }
    ];
    rows.forEach(function (row) {
      var newD = D * row.r;
      var wait = L.soloExpectedWaitSec(newD, h);
      var blocks = L.retargetCatchupBlocks(row.r);
      var dur = L.fmtDuration(blocks * state.avgBlockMs / 1000);
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + row.label + "</td><td>" + L.fmtDuration(wait) +
        "</td><td>~" + fmtInt(blocks) + " blocks (~" + dur + ")</td>";
      tb.appendChild(tr);
    });
  }

  function renderPulse() {
    $("st-diff").textContent = fmtInt(state.difficulty);
    $("st-net").textContent = L.fmtHashrate(state.netHs);
    $("st-reward").textContent = L.fmtQtc(state.reward, 4) + " QTC";
    $("st-bpd").textContent = fmtInt(state.blocksPerDay);
    var badge = $("pulse-src");
    var when = "";
    try { when = new Date(state.fetchedAt).toISOString().replace("T", " ").slice(0, 16) + "Z"; } catch (e) { when = state.fetchedAt; }
    if (state.source === "live") {
      badge.textContent = "live · head " + fmtInt(state.head);
      badge.classList.remove("stale");
    } else {
      badge.textContent = "snapshot · head " + fmtInt(state.head);
      badge.classList.add("stale");
    }
    $("pulse-fine").textContent =
      "Snapshot taken " + when + " from the public Quantus Subsquid indexer. " +
      "Network hashrate is the difficulty-implied figure (D ÷ 12 s). Reward uses the exact on-chain emission formula against the indexer's total issuance (genesis endowments included). " +
      (state.source === "live" ? "Live head check just succeeded, so the snapshot is current." : "The live indexer did not answer from this browser, so figures are from the snapshot.");
  }

  function renderAll() {
    renderPulse();
    renderSolo();
    drawPoolHist();
    renderScenarios();
  }

  function debounce(fn, ms) {
    var to = null;
    return function () {
      clearTimeout(to);
      to = setTimeout(fn, ms || 250);
    };
  }

  function bind() {
    var rerender = debounce(renderAll, 200);
    ["solo-h", "solo-hu", "solo-trials", "prob-t", "prob-tu", "pool-h", "pool-hu", "pool-fee", "pool-days"]
      .forEach(function (id) {
        var el = $(id);
        if (el) el.addEventListener("input", rerender);
        if (el) el.addEventListener("change", rerender);
      });
    var chips = $("solo-chips");
    if (chips) chips.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var h = parseFloat(b.getAttribute("data-h"));
      var exp = Math.floor(Math.log10(h));
      var unitSel = $("solo-hu"), valInput = $("solo-h");
      var unit = exp >= 15 ? 1e15 : exp >= 12 ? 1e12 : exp >= 9 ? 1e9 : exp >= 6 ? 1e6 : exp >= 3 ? 1e3 : 1;
      unitSel.value = String(unit);
      valInput.value = String(h / unit);
      Array.prototype.forEach.call(chips.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      renderAll();
    });
    document.querySelectorAll("button.addr[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = btn.getAttribute("data-copy");
        function done() {
          var old = btn.textContent;
          btn.textContent = "copied ✓";
          setTimeout(function () { btn.textContent = old; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(done, done);
        } else { done(); }
      });
    });
    window.addEventListener("resize", debounce(function () { drawSoloHist(); drawPoolHist(); }, 300));
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    renderAll(); // immediate paint on fallbacks
    loadData().then(renderAll, renderAll);
  });
})();
