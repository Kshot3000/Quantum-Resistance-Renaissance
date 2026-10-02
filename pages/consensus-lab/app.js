/* QTC Consensus Lab — app.js */
import {
  calculateDifficulty, hashrateFromDifficulty, fmtHashrate, fmtDiff, fmtMs, pctChange,
  retargetZone, TARGET_MS, MIN_DIFF, MAX_DIFF, INITIAL_DIFF, MAX_REORG_DEPTH,
} from "./consensus-core.js";

const $ = (id) => document.getElementById(id);
const SNAP = "../../data/consensus.json";

let S = null; // snapshot
let chartRange = "trend", chartScale = "log";

/* ---------- snapshot ---------- */
/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}
async function loadSnapshot() {
  try {
    const r = await fetch(SNAP, { cache: "no-store", signal: timeoutSignal(9000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    S = await r.json();
    const age = Math.max(0, Math.round((Date.now() - Date.parse(S.fetched_at)) / 60000));
    $("snapPill").textContent = `snapshot · block ${S.head.toLocaleString()} · ${age}m old`;
    $("snapPill").classList.add("live");
    return true;
  } catch (e) {
    $("snapPill").textContent = "snapshot unavailable — showing protocol constants only";
    return false;
  }
}

function hero() {
  const el = $("heroStats");
  if (!S) {
    el.innerHTML = `<div class="hstat"><div class="k">Target block time</div><div class="v">12 <small>s</small></div><div class="s">genesis difficulty 99.99G</div></div>
      <div class="hstat"><div class="k">Retarget</div><div class="v">every <small>block</small></div><div class="s">Homestead-style, ±1/2048 steps</div></div>`;
    return;
  }
  const D = BigInt(S.current.difficulty);
  const H = BigInt(S.current.est_hashrate_hs);
  el.innerHTML = `
    <div class="hstat"><div class="k">Network difficulty</div><div class="v">${fmtDiff(D)}</div><div class="s mono">${S.current.difficulty}</div></div>
    <div class="hstat"><div class="k">Est. network hashrate</div><div class="v">${fmtHashrate(H)}</div><div class="s">D / 12 s expected</div></div>
    <div class="hstat"><div class="k">Avg block time (3k)</div><div class="v">${(S.block_times_ms.avg_ms / 1000).toFixed(1)} <small>s</small></div><div class="s">median ${(S.block_times_ms.median_ms / 1000).toFixed(1)} s · target 12 s</div></div>
    <div class="hstat"><div class="k">Since genesis</div><div class="v">${S.difficulty.net_change_pct >= 0 ? "+" : ""}${S.difficulty.net_change_pct.toLocaleString()}<small>%</small></div><div class="s">${S.head.toLocaleString()} blocks indexed</div></div>`;
}

/* ---------- formula section ---------- */
function constTable() {
  const rows = [
    ["Target block time", "12,000 ms", "runtime/src/lib.rs"],
    ["Retarget divisor", "10,000 ms", "target × 10 / 12"],
    ["Step size", "D / 2048 per block", "≈ ±0.0488%"],
    ["Max fall per block", "−99/2048 ≈ −4.83%", "asymmetric"],
    ["Block-time floor", "500 ms", "MIN_RETARGET_BLOCK_TIME_MS"],
    ["Difficulty floor", "131,072 = 2¹⁷", "get_min_difficulty"],
    ["Difficulty ceiling", "2⁵¹² − 1", "U512::MAX"],
    ["Genesis difficulty", "99,999,999,999", "QPoWInitialDifficulty"],
    ["Max reorg depth", "100 blocks", "MaxReorgDepth"],
  ];
  $("constTable").innerHTML = "<table>" + rows.map(r =>
    `<tr><td>${r[0]}<br><span class="mono" style="font-size:11px">${r[2]}</span></td><td class="mono">${r[1]}</td></tr>`).join("") + "</table>";
}

function zoneTable() {
  const zones = [
    ["< 10 s", "0", "+1", "+1/2048 ≈ +0.049%", "up", "difficulty rises"],
    ["10 s – 20 s", "1", "0", "no change", "flat", "dead zone"],
    ["20 s – 30 s", "2", "−1", "−1/2048 ≈ −0.049%", "down", "difficulty falls"],
    ["30 s – 40 s", "3", "−2", "−2/2048 ≈ −0.098%", "down", "difficulty falls"],
    ["…", "k", "1−k", "−k/2048", "down", "difficulty falls"],
    ["≥ 1,000 s", "≥ 100", "−99 (cap)", "−99/2048 ≈ −4.83%", "down", "max fall"],
  ];
  $("zoneTable").querySelector("tbody").innerHTML = zones.map(z =>
    `<tr><td class="mono">${z[0]}</td><td class="mono">${z[1]}</td><td class="mono">${z[2]}</td><td><span class="tag ${z[4]}">${z[5]}</span> <span class="mono" style="font-size:12px">${z[3]}</span></td></tr>`).join("");
}

function simulator() {
  const tIn = $("simTime"), dIn = $("simDiff");
  function run() {
    const t = BigInt(tIn.value);
    $("simTimeOut").textContent = (Number(t) / 1000).toFixed(1) + " s";
    let parent;
    try { parent = BigInt(dIn.value.replace(/[^0-9]/g, "") || "0"); }
    catch { parent = 0n; }
    if (parent <= 0n) { $("simSteps").innerHTML = `<div class="step"><span class="k">Enter a parent difficulty</span><span class="v">—</span></div>`; return; }
    const r = calculateDifficulty(parent, t);
    const chg = pctChange(parent, r.difficulty);
    const dir = r.adjustment > 0n ? "▲ rises" : r.adjustment < 0n ? "▼ falls" : "— flat";
    $("simSteps").innerHTML = `
      <div class="step"><span class="k">block_time (floored at 500 ms${r.floored ? " — floor hit" : ""})</span><span class="v">${t} ms</span></div>
      <div class="step"><span class="k">divisor = 12000 × 10 / 12</span><span class="v">${r.divisor} ms</span></div>
      <div class="step"><span class="k">time_factor = ${t} / ${r.divisor}</span><span class="v">${r.timeFactor}</span></div>
      <div class="step"><span class="k">adjustment = max(1 − ${r.timeFactor}, −99)</span><span class="v">${r.adjustment > 0 ? "+" : ""}${r.adjustment} ${dir}</span></div>
      <div class="step"><span class="k">increment = ${fmtDiff(parent)} / 2048</span><span class="v">${fmtDiff(r.increment)}</span></div>
      <div class="step total"><span class="k">new difficulty</span><span class="v">${r.difficulty.toString()} (${chg >= 0 ? "+" : ""}${chg.toFixed(4)}%)</span></div>`;
  }
  tIn.addEventListener("input", run);
  dIn.addEventListener("input", run);
  $("simUseLive").addEventListener("click", () => {
    if (S) { dIn.value = S.current.difficulty; run(); }
  });
  run();
}

/* ---------- difficulty history chart ---------- */
function setupCanvas(cv, hCss = 300) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || cv.parentElement.clientWidth;
  cv.width = w * dpr; cv.height = hCss * dpr;
  cv.style.height = hCss + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hCss };
}

function drawDiffChart() {
  const cv = $("diffChart");
  if (!S) { cv.getContext("2d"); return; }
  const { ctx, w, h } = setupCanvas(cv);
  const pts = (chartRange === "trend" ? S.trend : S.recent).map(p => [p[0], BigInt(p[2])]);
  const pad = { l: 64, r: 14, t: 14, b: 30 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const xs = pts.map(p => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = pts[0][1], hi = pts[0][1];
  for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  const useLog = chartScale === "log";
  const ln = (d) => Math.log(Number(d) / 1e9); // log of billions keeps float precision
  const vLo = useLog ? ln(lo) : Number(lo), vHi = useLog ? ln(hi) : Number(hi);
  const X = (x) => pad.l + (x - x0) / Math.max(1, x1 - x0) * iw;
  const Y = (d) => {
    const v = useLog ? ln(d) : Number(d);
    return pad.t + ih - (v - vLo) / Math.max(1e-9, vHi - vLo) * ih;
  };
  ctx.clearRect(0, 0, w, h);
  // grid + y labels
  ctx.font = "10px JetBrains Mono, monospace"; ctx.fillStyle = "#93a0c0";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = vLo + (vHi - vLo) * i / ticks;
    const y = pad.t + ih - (v - vLo) / Math.max(1e-9, vHi - vLo) * ih;
    ctx.strokeStyle = "rgba(27,37,64,.8)"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    let label;
    if (useLog) { const d = BigInt(Math.round(Math.exp(v) * 1e9)); label = fmtDiff(d); }
    else label = fmtDiff(BigInt(Math.round(v)));
    ctx.fillText(label, 6, y + 3);
  }
  // x labels: dates
  const tOf = new Map((chartRange === "trend" ? S.trend : S.recent).map(p => [p[0], p[1]]));
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const x = x0 + (x1 - x0) * i / 4;
    const ts = tOf.get(Math.round(x)) || tOf.get(xs.reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a));
    if (ts) ctx.fillText(new Date(ts).toISOString().slice(0, 10), X(x), h - 10);
  }
  ctx.textAlign = "left";
  // area + line
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
  grad.addColorStop(0, "rgba(109,242,184,.35)"); grad.addColorStop(1, "rgba(109,242,184,.02)");
  ctx.beginPath(); ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (const p of pts) ctx.lineTo(X(p[0]), Y(p[1]));
  ctx.lineTo(X(pts[pts.length - 1][0]), pad.t + ih); ctx.lineTo(X(pts[0][0]), pad.t + ih); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (const p of pts) ctx.lineTo(X(p[0]), Y(p[1]));
  ctx.strokeStyle = "#6df2b8"; ctx.lineWidth = 1.6; ctx.stroke();
  // genesis marker
  ctx.fillStyle = "#9d8bff";
  ctx.fillText("genesis D = 99.99G", X(pts[0][0]) + 6, Y(pts[0][1]) - 6);
}

function histStats() {
  if (!S) return;
  $("histBlocks").textContent = S.blocks_indexed.toLocaleString();
  const D0 = INITIAL_DIFF, DN = BigInt(S.current.difficulty);
  const chg = pctChange(D0, DN);
  $("histStats").innerHTML = `
    <div class="stat"><div class="k">Genesis difficulty</div><div class="v">${fmtDiff(D0)}</div></div>
    <div class="stat"><div class="k">All-time high</div><div class="v">${fmtDiff(BigInt(S.difficulty.max))}</div><div class="k" style="margin-top:4px">block ${S.difficulty.max_height.toLocaleString()}</div></div>
    <div class="stat"><div class="k">All-time low</div><div class="v">${fmtDiff(BigInt(S.difficulty.min))}</div><div class="k" style="margin-top:4px">block ${S.difficulty.min_height.toLocaleString()}</div></div>
    <div class="stat"><div class="k">Net change</div><div class="v ${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : ""}${chg.toLocaleString()}%</div></div>
    <div class="stat"><div class="k">Recomputed over</div><div class="v">${S.blocks_indexed.toLocaleString()}</div><div class="k" style="margin-top:4px">blocks · ${S.missing_heights} gaps</div></div>`;
  $("histNote").textContent = `Method: replayed pallet_qpow::calculate_difficulty over real block timestamps. ` +
    `Snapshot ${new Date(S.fetched_at).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
}

/* ---------- block-time observatory ---------- */
function drawBtChart() {
  const cv = $("btChart");
  const { ctx, w, h } = setupCanvas(cv, 260);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 46, r: 12, t: 12, b: 30 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const NB = 40, loL = Math.log(500), hiL = Math.log(130000);
  const bins = new Array(NB).fill(0);
  const times = S ? S.block_times_ms.last : [];
  for (const t of times) {
    const b = Math.floor((Math.log(Math.max(500, t)) - loL) / (hiL - loL) * NB);
    bins[Math.max(0, Math.min(NB - 1, b))]++;
  }
  const maxB = Math.max(...bins, 1);
  const X = (i) => pad.l + i / NB * iw;
  const Y = (c) => pad.t + ih - c / maxB * ih;
  // ideal exponential overlay: P in bucket ~ lambda*e^{-lambda*t} * width
  ctx.font = "10px JetBrains Mono, monospace"; ctx.fillStyle = "#93a0c0";
  const lam = 1 / 12000;
  ctx.strokeStyle = "#ffcf6e"; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]); ctx.beginPath();
  for (let i = 0; i <= NB; i++) {
    const tLo = Math.exp(loL + (hiL - loL) * i / NB);
    const width = Math.exp(loL + (hiL - loL) * (i + 0.5) / NB) - tLo;
    const ideal = times.length * lam * Math.exp(-lam * tLo) * Math.max(1, width);
    const y = Y(Math.min(ideal, maxB * 1.05));
    i === 0 ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y);
  }
  ctx.stroke(); ctx.setLineDash([]);
  for (let i = 0; i < NB; i++) {
    const bh = bins[i] / maxB * ih;
    ctx.fillStyle = bins[i] ? "rgba(109,242,184,.75)" : "rgba(27,37,64,.5)";
    ctx.fillRect(X(i) + 1, pad.t + ih - bh, iw / NB - 2, bh);
  }
  // x labels
  const marks = [1000, 5000, 10000, 20000, 60000, 120000];
  ctx.textAlign = "center";
  for (const m of marks) {
    const i = (Math.log(m) - loL) / (hiL - loL) * NB;
    if (i < 0 || i > NB) continue;
    ctx.fillText(fmtMs(m), X(i), h - 10);
    ctx.strokeStyle = "rgba(27,37,64,.8)"; ctx.beginPath();
    ctx.moveTo(X(i), pad.t); ctx.lineTo(X(i), pad.t + ih); ctx.stroke();
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffcf6e"; ctx.fillText("— ideal 12 s exponential", pad.l + 8, pad.t + 12);
}

function btStats() {
  if (!S) { $("btSample").textContent = "—"; return; }
  const b = S.block_times_ms;
  $("btSample").textContent = b.sample.toLocaleString();
  $("btStats").innerHTML = `
    <div class="stat"><div class="k">Mean</div><div class="v">${fmtMs(b.avg_ms)}</div></div>
    <div class="stat"><div class="k">Median</div><div class="v">${fmtMs(b.median_ms)}</div></div>
    <div class="stat"><div class="k">p90</div><div class="v">${fmtMs(b.p90_ms)}</div></div>
    <div class="stat"><div class="k">Slowest (3k window)</div><div class="v">${fmtMs(b.max_ms)}</div></div>
    <div class="stat"><div class="k">Longest gap ever</div><div class="v">${fmtMs(b.longest_gap_ms)}</div><div class="k" style="margin-top:4px">block ${b.longest_gap_height.toLocaleString()}</div></div>
    <div class="stat"><div class="k">Target</div><div class="v">12.0 s</div><div class="k" style="margin-top:4px">dead zone 10–20 s</div></div>`;
}

/* ---------- 51% cost lab ---------- */
function attackLab() {
  function run() {
    const per = parseFloat($("atkH").value) || 0;
    const unit = parseFloat($("atkHU").value) || 1;
    const n = Math.max(1, parseInt($("atkN").value) || 0);
    const capex = Math.max(0, parseFloat($("atkCapex").value) || 0);
    const watts = Math.max(0, parseFloat($("atkW").value) || 0);
    const kwh = Math.max(0, parseFloat($("atkKwh").value) || 0);
    const hrs = Math.max(1, parseFloat($("atkHrs").value) || 0);
    const mine = BigInt(Math.round(per * unit)) * BigInt(n); // H/s as BigInt
    const out = $("attackOut");
    if (!S || mine <= 0n) {
      out.innerHTML = `<div class="big">—</div><p class="fine">Enter your hashrate to price the attack. Network hashrate needs the snapshot.</p>`;
      return;
    }
    const net = BigInt(S.current.est_hashrate_hs);
    const sharePct = Number((mine * 1000000n) / (net + mine)) / 10000;
    const majority = mine > net;
    const totalCapex = capex * n;
    const energyKwh = watts * n * hrs / 1000;
    const energyCost = energyKwh * kwh;
    const fmtUSD = (x) => "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    out.innerHTML = `
      <div class="row"><span class="k">Your hashrate</span><span class="v">${fmtHashrate(mine)}</span></div>
      <div class="row"><span class="k">Network hashrate (est.)</span><span class="v">${fmtHashrate(net)}</span></div>
      <div class="row"><span class="k">Your share of total</span><span class="v" style="color:${majority ? "#6df2b8" : "#ff7d8a"}">${sharePct.toFixed(2)}% ${majority ? "— MAJORITY" : "— not enough"}</span></div>
      <div class="row"><span class="k">Hardware capex</span><span class="v">${fmtUSD(totalCapex)}</span></div>
      <div class="row"><span class="k">Energy for ${hrs} h</span><span class="v">${energyKwh.toLocaleString("en-US", { maximumFractionDigits: 0 })} kWh → ${fmtUSD(energyCost)}</span></div>
      <div class="row"><span class="k">All-in attack cost</span><span class="v" style="color:#6df2b8;font-weight:800">${fmtUSD(totalCapex + energyCost)}</span></div>
      <p class="fine">A sustained majority lets you censor, double-spend your own sends, and dictate the canonical chain —
      until the honest network's difficulty outruns your private fork. This prices <em>your</em> hardware only:
      sourcing it at scale is the hard part (see honest limits below).</p>`;
  }
  for (const id of ["atkH", "atkHU", "atkN", "atkCapex", "atkW", "atkKwh", "atkHrs"])
    $(id).addEventListener("input", run);
  run();
  return run; // re-run after the snapshot loads
}

/* ---------- boot ---------- */
function wireChartSegs() {
  document.querySelectorAll(".seg").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      if (b.dataset.range) chartRange = b.dataset.range;
      if (b.dataset.scale) chartScale = b.dataset.scale;
      drawDiffChart();
    });
  });
}

function wireCopy() {
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "copied ✓"; }
      catch { btn.textContent = btn.dataset.copy; }
      setTimeout(() => { btn.textContent = btn.dataset.copy; }, 1600);
    });
  });
}

window.addEventListener("resize", () => { drawDiffChart(); drawBtChart(); });

(async function boot() {
  constTable();
  zoneTable();
  simulator();
  wireChartSegs();
  wireCopy();
  const atkRerun = attackLab();
  await loadSnapshot();
  hero();
  histStats();
  drawDiffChart();
  drawBtChart();
  btStats();
  atkRerun(); // snapshot is in: price the attack against live network hashrate
  if (S) { $("simUseLive").click(); }
})();
