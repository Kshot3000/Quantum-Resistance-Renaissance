// QTC Emission Lab — pure math core + browser UI.
// The math below is the exact on-chain emission model, verified Sept 29-30, 2026:
//   reward(block) = floor((MAX_SUPPLY - total_issuance - tx_fees) / EMISSION_DIVISOR)
// Sources: Quantus-Network/docs docs/reference/tokenomics.md ("Emission" section) and
// Quantus-Network/chain runtime/src/configs/mod.rs (EmissionDivisor = ConstU128<50_000_000>).
// Quantization note: the minted reward is aligned to the wormhole leaf quantum (0.01 QTC);
// indexer-reported rewards therefore oscillate around the true model value.
// Run tests: node tests/emission.test.js
"use strict";

var MAX_SUPPLY = 21000000;        // QTC hard cap
var GENESIS_MINT = 5670000;       // 27% minted at genesis (vested)
var MINING_EMISSIONS = 15330000;  // 73% emitted to miners (21M - 5.67M)
var EMISSION_DIVISOR = 50000000;  // mainnet constant
var PLANCKS = 1e12;               // 1 QTC = 10^12 planck
var LEAF_QUANTUM_QTC = 0.01;      // wormhole leaf quantum; rewards quantized to this
var LEAF_PLANCKS = 10000000000;   // 0.01 QTC in plancks (10^12 / 100)
var MAX_CHAIN_HEIGHT = 10000000;  // fleet plausible-height ceiling
var R0_QUANTUM_TOLERANCE = 500000; // 1 leaf quantum x EMISSION_DIVISOR: the most a
                                   // quantum-cluster mean can misstate R0, either way
var GENESIS_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z"); // pre-launch floor

// ---- Closed-form decay model ----------------------------------------------
// Anchored at a live observation: R0 = implied remaining mining supply (QTC)
// derived from current rewards. Discrete per-block: R_{n+1} = R_n * (1 - 1/D).
function decayFactor(n){ return Math.pow(1 - 1 / EMISSION_DIVISOR, n); }
function remainingQtc(blocksFromAnchor, R0){ return R0 * decayFactor(blocksFromAnchor); }
function supplyQtc(blocksFromAnchor, R0){ return MAX_SUPPLY - remainingQtc(blocksFromAnchor, R0); }
function rewardQtc(blocksFromAnchor, R0){ return remainingQtc(blocksFromAnchor, R0) / EMISSION_DIVISOR; }
// Inverse: how many blocks until remaining supply falls to Rtarget?
function blocksToRemaining(R0, Rtarget){
  if (Rtarget >= R0) return 0;
  return Math.log(Rtarget / R0) / Math.log(1 - 1 / EMISSION_DIVISOR);
}
// QTC issued over the next `blocks` blocks, starting at the anchor.
function issuanceOver(blocks, R0){ return R0 - remainingQtc(blocks, R0); }
// Annual inflation rate (issuance over a year / current supply), as a fraction.
function annualInflation(R0, blocksPerYear){ return issuanceOver(blocksPerYear, R0) / supplyQtc(0, R0); }
// Time (blocks) for the block reward to halve — the exponential analogue of a halving.
function halvingBlocks(){ return Math.log(0.5) / Math.log(1 - 1 / EMISSION_DIVISOR); }
// Quantize a reward to the wormhole leaf quantum, like the pallet does pre-mint.
function quantizeQuantum(qtc){ return Math.round(qtc / LEAF_QUANTUM_QTC) * LEAF_QUANTUM_QTC; }

// ---- Formatting ------------------------------------------------------------
function fmtQTC(x, digits){
  if (!isFinite(x)) return "—";
  var d = (digits === undefined) ? 4 : digits;
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtInt(x){ return Math.round(x).toLocaleString("en-US"); }
function fmtCompact(x){
  if (!isFinite(x)) return "—";
  var a = Math.abs(x);
  if (a >= 1e9) return (x/1e9).toFixed(2) + "B";
  if (a >= 1e6) return (x/1e6).toFixed(2) + "M";
  if (a >= 1e3) return (x/1e3).toFixed(2) + "K";
  return x.toFixed(2);
}
function fmtDate(ms){
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", timeZone: "UTC" });
}
function fmtDays(days){
  if (days < 730) return Math.round(days) + " days";
  return (days / 365.25).toFixed(1) + " yrs";
}

// ---- Milestones ------------------------------------------------------------
// Each milestone: blocks until R0 decays to a target remaining supply.
function milestones(R0, blocksPerDay){
  var list = [
    { label: "25% of mining emissions issued", target: MINING_EMISSIONS * 0.75 },
    { label: "50% of mining emissions issued", target: MINING_EMISSIONS * 0.50 },
    { label: "75% of mining emissions issued", target: MINING_EMISSIONS * 0.25 },
    { label: "90% of mining emissions issued", target: MINING_EMISSIONS * 0.10 },
    { label: "Block reward falls below 0.10 QTC", target: 0.10 * EMISSION_DIVISOR },
    { label: "Block reward falls below 0.01 QTC (leaf quantum)", target: 0.01 * EMISSION_DIVISOR },
    { label: "Daily issuance falls below 100 QTC", target: (100 / blocksPerDay) * EMISSION_DIVISOR },
  ];
  return list.map(function(m){
    var blocks = blocksToRemaining(R0, m.target);
    return { label: m.label, blocks: blocks, days: blocks / blocksPerDay,
             rewardAt: rewardQtc(blocks, R0), supplyAt: supplyQtc(blocks, R0) };
  }).sort(function(a, b){ return a.blocks - b.blocks; });
}

// ---- Snapshot anchor ---------------------------------------------------------
// Round 2 (2026-10-13): validate RELATIONS, not just shapes. Round 1 (below,
// previously inline) shape-checked each block alone and FILTERED the bad
// ones out, so a snapshot that mixed two different chain moments — heights
// with a gap or a duplicate, timestamps out of order in the middle, one
// reward far from the cluster — still anchored the page on whatever rows
// survived, and fetched_at from 2999 painted as the snapshot time. The
// producer (scripts/fetch-chain-data.mjs) guarantees a precise shape: the
// latest <=15 blocks ordered by height desc (chain heights are sequential,
// so the window is strictly descending and consecutive), every reward the
// pallet minted — hence quantized to the 0.01 QTC leaf quantum pre-mint —
// and a status.block_height from the SAME query as the block list. This
// anchor enforces exactly those relations and rejects (null -> fail():
// no figures rather than invented ones) anything that breaks them:
//   * 2..15 blocks (fewer than 2 leaves the block time unobserved — the old
//     code silently defaulted it to a hard-coded 13.7 s);
//   * every height an integer in [1, MAX_CHAIN_HEIGHT], steps of exactly 1;
//   * every timestamp a real chain-era time (genesis floor, now+1h cap),
//     strictly descending with its height, each step <= 600 s;
//   * every reward a positive integer planck count that is an exact
//     multiple of the leaf quantum (round 3, 2026-10-14: the payout is
//     the indexer's MiningRewards "Total reward (base + fees)" — the
//     subsquid generated types say so in as many words — so a block
//     carrying fee-paying extrinsics legitimately pays whole quanta
//     ABOVE the base emission; the round-2 whole-window cluster spread
//     rejected the real snapshot whenever such a block landed in the
//     window (live sample: 10 of 300 blocks at 0.32-0.42 QTC, window
//     spread 0.08). The base cluster is what anchors: payouts within
//     one quantum of the window minimum (the true base moves by a
//     factor of (1 - 1/50M) per block, so over 15 blocks the base
//     oscillation is exactly that 1 quantum), the cluster must be the
//     MAJORITY of the window (fee-carrying blocks are ~3% of blocks),
//     and R0 is derived from the cluster mean alone — fee blocks are
//     displayed in the pulse but never anchor a figure);
//   * status.block_height, when the payload carries one, equals the top
//     block's height (a disagreement is a mixed-date snapshot);
//   * the newest block is not newer than the fetched_at that claims to
//     contain it (+60 s clock slack), and fetched_at itself must be a real
//     capture time (fleet bounds) or it is dropped to null — a label, never
//     painted from an out-of-bounds value;
//   * the cluster-derived R0 is held to the chain it claims (round 3):
//     R0 <= MINING_EMISSIONS + R0_QUANTUM_TOLERANCE (remaining mining
//     supply starts at 15.33M and only falls; the tolerance is the one
//     quantum a cluster mean can misstate it by — past it, the implied
//     supply sits below the genesis mint), and the implied minted total
//     MINING_EMISSIONS - R0, again past the same tolerance, cannot
//     exceed height x the genesis-era reward MINING_EMISSIONS /
//     EMISSION_DIVISOR (the per-block emission only ever decays, so no
//     window at this height can imply more minted than that).
function anchorFromSnapshot(data, nowMs){
  var now = isFinite(nowMs) ? nowMs : Date.now();
  if (!data || !Array.isArray(data.blocks)) return null;
  var blocks = data.blocks;
  if (blocks.length < 2 || blocks.length > 15) return null;
  var fetchedAt = data.fetched_at;
  var fetchedMs = null;
  if (typeof fetchedAt === "string" && isFinite(Date.parse(fetchedAt))){
    var fm = Date.parse(fetchedAt);
    if (fm >= GENESIS_FLOOR_MS && fm <= now + 3600000) fetchedMs = fm;
  }
  if (fetchedMs === null) fetchedAt = null; // never render "Invalid Date" or a 2999 label
  var heights = [], times = [], rewards = [];
  for (var i = 0; i < blocks.length; i++){
    var b = blocks[i];
    if (!b) return null;
    var rw = Number(b.reward), h = Number(b.height);
    if (!isFinite(h) || Math.floor(h) !== h || h < 1 || h > MAX_CHAIN_HEIGHT) return null;
    if (!isFinite(rw) || Math.floor(rw) !== rw || rw <= 0 || rw % LEAF_PLANCKS !== 0) return null;
    if (!isFinite(Date.parse(b.timestamp))) return null;
    var t = Date.parse(b.timestamp);
    if (t < GENESIS_FLOOR_MS || t > now + 3600000) return null;
    heights.push(h); times.push(t); rewards.push(rw / PLANCKS);
  }
  for (var j = 1; j < blocks.length; j++){
    if (heights[j - 1] - heights[j] !== 1) return null; // descending, consecutive
    var dt = times[j - 1] - times[j];
    if (!(dt > 0) || dt > 600000) return null; // strictly descending, <= 10 min apart
  }
  if (data.status != null){
    var sh = Number(data.status && data.status.block_height);
    if (!isFinite(sh) || sh !== heights[0]) return null; // status and blocks: same moment
  }
  if (fetchedMs !== null && times[0] > fetchedMs + 60000) return null; // block newer than its snapshot
  // Base cluster (round 3): payouts within one leaf quantum of the window
  // minimum are base emission; anything above paid the miner fees on top
  // and is counted (feeBlocks) but never anchors. The cluster must be the
  // majority — a window where most blocks claim fee bumps is not the
  // producer's ~3% fee-carrying rate, it is a forged window.
  var rMin = Math.min.apply(null, rewards);
  var cluster = rewards.filter(function(x){ return x <= rMin + LEAF_QUANTUM_QTC + 1e-9; });
  if (cluster.length < Math.ceil(rewards.length / 2)) return null;
  var mean = cluster.reduce(function(a, x){ return a + x; }, 0) / cluster.length;
  var R0 = mean * EMISSION_DIVISOR;
  if (!isFinite(mean) || mean <= 0 || !isFinite(R0) || R0 <= 0 || R0 >= MAX_SUPPLY) return null;
  if (R0 > MINING_EMISSIONS + R0_QUANTUM_TOLERANCE) return null; // supply below the genesis mint
  if ((MINING_EMISSIONS - R0) - R0_QUANTUM_TOLERANCE >
      heights[0] * (MINING_EMISSIONS / EMISSION_DIVISOR)) return null; // minted more than the chain can have
  var bt = (times[0] - times[times.length - 1]) / 1000 / (heights[0] - heights[heights.length - 1]);
  if (!isFinite(bt) || bt < 1 || bt > 600) return null; // internally inconsistent snapshot
  return { R0: R0, meanReward: mean, rewards: rewards, heights: heights,
           height: heights[0], time: times[0], blockTime: bt,
           feeBlocks: rewards.length - cluster.length,
           clusterMax: Math.max.apply(null, cluster),
           fetchedAt: fetchedAt };
}

// Node export for tests
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    MAX_SUPPLY: MAX_SUPPLY, GENESIS_MINT: GENESIS_MINT, MINING_EMISSIONS: MINING_EMISSIONS,
    EMISSION_DIVISOR: EMISSION_DIVISOR, PLANCKS: PLANCKS, LEAF_QUANTUM_QTC: LEAF_QUANTUM_QTC,
    LEAF_PLANCKS: LEAF_PLANCKS, MAX_CHAIN_HEIGHT: MAX_CHAIN_HEIGHT,
    R0_QUANTUM_TOLERANCE: R0_QUANTUM_TOLERANCE, GENESIS_FLOOR_MS: GENESIS_FLOOR_MS,
    decayFactor: decayFactor, remainingQtc: remainingQtc, supplyQtc: supplyQtc,
    rewardQtc: rewardQtc, blocksToRemaining: blocksToRemaining, issuanceOver: issuanceOver,
    annualInflation: annualInflation, halvingBlocks: halvingBlocks,
    quantizeQuantum: quantizeQuantum, milestones: milestones, anchorFromSnapshot: anchorFromSnapshot,
    fmtQTC: fmtQTC, fmtInt: fmtInt, fmtCompact: fmtCompact, fmtDate: fmtDate, fmtDays: fmtDays,
  };
}

// ---- Browser UI ------------------------------------------------------------
if (typeof window !== "undefined"){
(function(){
  "use strict";
  var SNAPSHOT = "../../data/live.json";
  var el = function(id){ return document.getElementById(id); };
  var state = { anchor: null, blockTime: 13.7, simYears: 10 };

  // The anchor itself (anchorFromSnapshot) is defined above the browser UI
  // as pure, node-testable logic: it validates the snapshot's RELATIONS
  // (round 2, 2026-10-13 — see its header comment) and returns null for
  // anything that is not one coherent producer-shaped window, so the boot
  // below routes to fail(): no figures rather than invented ones.

  /* Abort a fetch that never settles: a hung request must fall through to
   * the app's error/fallback path, not strand the page on "Loading…" forever. */
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    var ctl = new AbortController();
    setTimeout(function () { ctl.abort(); }, ms);
    return ctl.signal;
  }
  function loadData(){
    /* Test hook for headless QA: window.__qtcemission_mock = {ok, data} */
    if (window.__qtcemission_mock){
      var m = window.__qtcemission_mock;
      return m.ok ? Promise.resolve(m.data) : Promise.reject(new Error(m.error || "mock failure"));
    }
    return fetch(SNAPSHOT, { cache: "no-store", signal: timeoutSignal(9000) }).then(function(r){
      if (!r.ok) throw new Error("snapshot HTTP " + r.status);
      return r.json();
    }).then(function(j){ var d = j.data || j; d.fetched_at = d.fetched_at || j.fetched_at; return d; });
  }

  function countUp(node, target, fmt){
    var start = null, dur = 900;
    function frame(ts){
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * e);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderHero(a){
    countUp(el("stat-reward"), a.meanReward, function(x){ return fmtQTC(x, 4); });
    countUp(el("stat-remaining"), a.R0, function(x){ return fmtCompact(x); });
    countUp(el("stat-supply"), supplyQtc(0, a.R0), function(x){ return fmtCompact(x); });
    var minedFrac = (MINING_EMISSIONS - a.R0) / MINING_EMISSIONS * 100;
    el("stat-mined").textContent = (minedFrac < 0 ? 0 : minedFrac).toFixed(3) + "%";
    el("stat-snapshot").textContent = a.fetchedAt ?
      "snapshot " + new Date(a.fetchedAt).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "live";
    el("hero-note").textContent =
      "Anchored on " + a.rewards.length + " recent blocks (mean base reward " + fmtQTC(a.meanReward, 4) +
      " QTC, quantized to " + LEAF_QUANTUM_QTC.toFixed(2) + " QTC" +
      (a.feeBlocks ? "; " + a.feeBlocks + " fee-carrying block(s) paid above base and are excluded from the anchor" : "") +
      "). Remaining supply and " +
      "projections are derived from the on-chain formula R = (21M − S) / 50,000,000 — " +
      "a model, not a chain-state read. Small deviations from pure exponential come " +
      "from fee burns, included fees, and reward quantization.";
  }

  function drawPulse(a){
    var cv = el("reward-pulse"), ctx = cv.getContext("2d");
    var W = cv.width = cv.offsetWidth * 2, H = cv.height = 220;
    var pad = 24 * 2, n = a.rewards.length;
    var max = Math.max.apply(null, a.rewards) * 1.15, min = Math.min.apply(null, a.rewards) * 0.85;
    var bw = (W - pad * 2) / n;
    ctx.clearRect(0, 0, W, H);
    // model line
    var yModel = H - 20 - ((a.meanReward - min) / (max - min)) * (H - 60);
    ctx.strokeStyle = "rgba(255,209,102,.85)"; ctx.lineWidth = 3; ctx.setLineDash([10, 7]);
    ctx.beginPath(); ctx.moveTo(pad, yModel); ctx.lineTo(W - pad, yModel); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,209,102,.9)"; ctx.font = "600 20px system-ui";
    ctx.fillText("model: " + fmtQTC(a.meanReward, 4) + " QTC", pad, yModel - 12);
    // bars
    for (var i = 0; i < n; i++){
      var v = a.rewards[i], x = pad + i * bw + bw * 0.18, w = bw * 0.64;
      var h = ((v - min) / (max - min)) * (H - 60), y = H - 20 - h;
      var g = ctx.createLinearGradient(0, y, 0, H - 20);
      g.addColorStop(0, "rgba(255,209,102,.95)"); g.addColorStop(1, "rgba(255,209,102,.25)");
      ctx.fillStyle = g;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8); else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.fillStyle = "rgba(235,240,255,.55)"; ctx.font = "19px system-ui"; ctx.textAlign = "center";
      if (n <= 16) ctx.fillText(String(a.heights[i]).slice(-4), x + w / 2, H - 2);
      ctx.textAlign = "left";
    }
    el("pulse-note").textContent = a.rewards.length + " blocks · the base emission alternates between " +
      fmtQTC(Math.min.apply(null, a.rewards), 2) + " and " + fmtQTC(a.clusterMax, 2) +
      " QTC because the pallet quantizes each reward to the 0.01 QTC leaf quantum before minting" +
      (a.feeBlocks ? "; " + a.feeBlocks + " block(s) pay more — up to " + fmtQTC(Math.max.apply(null, a.rewards), 2) +
        " QTC — because the miner payout is base + fees, and fee-carrying blocks keep the fees on top." : ".");
  }

  function drawSupply(a, log){
    var cv = el("supply-curve"), ctx = cv.getContext("2d");
    var W = cv.width = cv.offsetWidth * 2, H = cv.height = 320;
    var padL = 90, padR = 30, padT = 30, padB = 50;
    var years = 80, pts = 240;
    var bpd = 86400 / state.blockTime;
    var data = [];
    for (var i = 0; i <= pts; i++){
      var y = i / pts * years, n = y * 365.25 * bpd;
      data.push({ y: y, s: supplyQtc(n, a.R0) });
    }
    var lo = log ? Math.log10(GENESIS_MINT * 0.9) : GENESIS_MINT * 0.9;
    var hi = log ? Math.log10(MAX_SUPPLY) : MAX_SUPPLY;
    function X(y){ return padL + (y / years) * (W - padL - padR); }
    function Y(s){ var v = log ? Math.log10(s) : s; return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB); }
    ctx.clearRect(0, 0, W, H);
    // asymptote
    ctx.strokeStyle = "rgba(235,240,255,.25)"; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(padL, Y(MAX_SUPPLY)); ctx.lineTo(W - padR, Y(MAX_SUPPLY)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "rgba(235,240,255,.6)"; ctx.font = "600 19px system-ui";
    ctx.fillText("21,000,000 QTC cap", W - padR - 300, Y(MAX_SUPPLY) - 12);
    // genesis marker
    ctx.strokeStyle = "rgba(94,234,212,.5)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(0), Y(GENESIS_MINT)); ctx.lineTo(X(0), H - padB); ctx.stroke();
    ctx.fillStyle = "rgba(94,234,212,.9)";
    ctx.fillText("genesis 5.67M", X(0) + 10, Y(GENESIS_MINT) + 26);
    // curve with glow
    ctx.shadowColor = "rgba(255,209,102,.7)"; ctx.shadowBlur = 18;
    var grad = ctx.createLinearGradient(padL, 0, W - padR, 0);
    grad.addColorStop(0, "#ffd166"); grad.addColorStop(1, "#f59e0b");
    ctx.strokeStyle = grad; ctx.lineWidth = 5; ctx.beginPath();
    data.forEach(function(p, i){ var x = X(p.y), y = Y(p.s); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.shadowBlur = 0;
    // now marker
    ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(X(0.02), Y(supplyQtc(0, a.R0)), 9, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(235,240,255,.85)"; ctx.font = "600 19px system-ui";
    ctx.fillText("now · " + fmtCompact(supplyQtc(0, a.R0)) + " QTC", X(0.02) + 18, Y(supplyQtc(0, a.R0)) - 14);
    // x labels
    ctx.fillStyle = "rgba(235,240,255,.5)"; ctx.font = "18px system-ui";
    for (var t = 0; t <= years; t += 20){ ctx.fillText("+" + t + "y", X(t) - 16, H - 18); }
    el("supply-note").textContent = "Projected with the closed-form model S(n) = 21M − R₀·(1 − 1/50M)ⁿ " +
      "at " + state.blockTime.toFixed(2) + " s/block. Genesis mint (5.67M QTC, 27%) is the curve's floor.";
  }

  function drawCompare(a){
    var cv = el("decay-compare"), ctx = cv.getContext("2d");
    var W = cv.width = cv.offsetWidth * 2, H = cv.height = 260;
    var padL = 90, padR = 30, padT = 30, padB = 50, years = 24, pts = 120;
    var bpd = 86400 / state.blockTime;
    function X(y){ return padL + (y / years) * (W - padL - padR); }
    var r0 = rewardQtc(0, a.R0), max = r0 * 1.1;
    function Y(v){ return padT + (1 - v / max) * (H - padT - padB); }
    ctx.clearRect(0, 0, W, H);
    // hypothetical 4-year halving curve (labeled hypothetical)
    ctx.strokeStyle = "rgba(129,140,248,.85)"; ctx.lineWidth = 4; ctx.setLineDash([12, 8]);
    ctx.beginPath();
    for (var i = 0; i <= pts; i++){
      var y = i / pts * years, v = r0 * Math.pow(0.5, y / 4);
      i ? ctx.lineTo(X(y), Y(v)) : ctx.moveTo(X(y), Y(v));
    }
    ctx.stroke(); ctx.setLineDash([]);
    // real exponential
    ctx.shadowColor = "rgba(255,209,102,.7)"; ctx.shadowBlur = 14;
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 5; ctx.beginPath();
    for (var j = 0; j <= pts; j++){
      var yy = j / pts * years, vv = rewardQtc(yy * 365.25 * bpd, a.R0);
      j ? ctx.lineTo(X(yy), Y(vv)) : ctx.moveTo(X(yy), Y(vv));
    }
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.font = "600 19px system-ui"; ctx.fillStyle = "#ffd166";
    ctx.fillText("Quantus exponential (real)", padL + 12, padT + 28);
    ctx.fillStyle = "rgba(129,140,248,.95)";
    ctx.fillText("Hypothetical 4-yr halvings", padL + 12, padT + 56);
    ctx.fillStyle = "rgba(235,240,255,.5)"; ctx.font = "18px system-ui";
    for (var t = 0; t <= years; t += 6){ ctx.fillText("+" + t + "y", X(t) - 14, H - 18); }
    ctx.save(); ctx.translate(26, H / 2 + 60); ctx.rotate(-Math.PI / 2);
    ctx.fillText("block reward (QTC)", 0, 0); ctx.restore();
  }

  function renderSim(a){
    var years = state.simYears, bpd = 86400 / state.blockTime;
    var n = years * 365.25 * bpd;
    el("sim-years-val").textContent = years.toFixed(1) + " years";
    el("sim-bt-val").textContent = state.blockTime.toFixed(2) + " s";
    el("sim-height").textContent = fmtInt(a.height + n);
    el("sim-date").textContent = fmtDate(a.time + years * 365.25 * 86400000);
    el("sim-reward").textContent = fmtQTC(rewardQtc(n, a.R0), 5) + " QTC";
    el("sim-daily").textContent = fmtQTC(issuanceOver(bpd, a.R0) * (remainingQtc(n, a.R0) / a.R0), 1) + " QTC";
    el("sim-annual").textContent = fmtCompact(issuanceOver(bpd * 365.25, a.R0) * (remainingQtc(n, a.R0) / a.R0)) + " QTC";
    el("sim-supply").textContent = fmtCompact(supplyQtc(n, a.R0)) + " QTC";
    el("sim-remaining").textContent = fmtCompact(remainingQtc(n, a.R0)) + " QTC";
    var infl = issuanceOver(bpd * 365.25, a.R0) * (remainingQtc(n, a.R0) / a.R0) / supplyQtc(n, a.R0) * 100;
    el("sim-inflation").textContent = infl.toFixed(2) + "%";
    var hb = halvingBlocks(), hbDays = hb / bpd;
    el("sim-halving").textContent = "Reward halves every " + fmtInt(hb) + " blocks ≈ " + fmtDays(hbDays) +
      " at " + state.blockTime.toFixed(2) + " s/block";
  }

  function renderMilestones(a){
    var bpd = 86400 / state.blockTime;
    var rows = milestones(a.R0, bpd).map(function(m){
      var date = fmtDate(a.time + m.days * 86400000);
      return "<tr><td>" + m.label + "</td><td class='num'>" + date + "</td>" +
        "<td class='num'>" + fmtCompact(m.blocks) + "</td>" +
        "<td class='num'>" + fmtQTC(m.rewardAt, 4) + " QTC</td></tr>";
    }).join("");
    el("milestone-rows").innerHTML = rows;
    el("milestone-note").textContent = "Dates assume " + state.blockTime.toFixed(2) +
      " s/block (observed in the snapshot window). Move the block-time slider in the simulator to re-project.";
  }

  function bind(a){
    el("sim-years").addEventListener("input", function(e){
      state.simYears = parseFloat(e.target.value); renderSim(a);
    });
    el("sim-blocktime").addEventListener("input", function(e){
      state.blockTime = parseFloat(e.target.value);
      renderSim(a); renderMilestones(a); drawSupply(a, state.log); drawCompare(a);
    });
    el("scale-toggle").addEventListener("click", function(e){
      if (e.target.tagName !== "BUTTON") return;
      state.log = e.target.dataset.scale === "log";
      var btns = el("scale-toggle").querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i] === e.target);
      drawSupply(a, state.log);
    });
    window.addEventListener("resize", function(){
      drawPulse(a); drawSupply(a, state.log); drawCompare(a);
    });
  }

  function fail(err){
    var msg = "Could not load chain data (" + (err && err.message ? err.message : err) + "). " +
      "The indexer snapshot is unreachable from here — no figures are shown rather than invented ones.";
    ["stat-reward","stat-remaining","stat-supply","stat-mined"].forEach(function(id){ el(id).textContent = "—"; });
    el("hero-note").textContent = msg;
    el("pulse-note").textContent = msg;
    el("milestone-note").textContent = msg;
  }

  function wireCopy(){
    document.querySelectorAll("[data-copy]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var v = btn.getAttribute("data-copy");
        function done(){
          var t = btn.textContent; btn.textContent = "copied ✓";
          setTimeout(function(){ btn.textContent = t; }, 1500);
        }
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(v).then(done, done);
        else done();
      });
    });
  }

  function initGrain(){
    // Ambient drift: faint gold decay glyphs sinking like the emission curve itself.
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var cv = document.getElementById("sigrain"); if (!cv) return;
    var ctx = cv.getContext("2d"), W, H, parts = [];
    function size(){ W = cv.width = innerWidth; H = cv.height = innerHeight; }
    size(); addEventListener("resize", size);
    var glyphs = ["e⁻ˣ", "÷", "λ", "◐", "≈", "∑", "·", "Q"];
    for (var i = 0; i < 46; i++) parts.push({
      x: Math.random(), y: Math.random(),
      s: 0.00025 + Math.random() * 0.0008,
      g: glyphs[Math.floor(Math.random() * glyphs.length)],
      o: 0.03 + Math.random() * 0.08, fs: 10 + Math.random() * 14
    });
    (function tick(){
      ctx.clearRect(0, 0, W, H);
      for (var k = 0; k < parts.length; k++){
        var p = parts[k];
        p.y += p.s; if (p.y > 1.02){ p.y = -0.02; p.x = Math.random(); }
        ctx.globalAlpha = p.o; ctx.fillStyle = "#ffd166";
        ctx.font = p.fs + "px monospace";
        ctx.fillText(p.g, p.x * W, p.y * H);
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    })();
  }

  document.addEventListener("DOMContentLoaded", function(){
    wireCopy();
    initGrain();
    loadData().then(function(data){
      var a = anchorFromSnapshot(data);
      if (!a) throw new Error("empty snapshot");
      state.anchor = a; state.blockTime = a.blockTime; state.log = false;
      var bt = el("sim-blocktime");
      bt.min = 8; bt.max = 20; bt.step = 0.01; bt.value = a.blockTime.toFixed(2);
      renderHero(a); drawPulse(a); renderSim(a); renderMilestones(a);
      drawSupply(a, false); drawCompare(a); bind(a);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function(){
        drawPulse(a); drawSupply(a, state.log); drawCompare(a);
      });
    }).catch(fail);
  });
})();
}
