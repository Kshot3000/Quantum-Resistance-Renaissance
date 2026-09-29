/* QTC Fee & Throughput Lab — fee estimator, throughput visualizer, aggregation
 * explorer, signature-size lab.
 *
 * All protocol figures verified 2026-09-29 against upstream:
 *   docs/architecture.md (12s blocks, 3.75 MB tx/block, throughput modes)
 *   docs/deep-dives/pqc.md (ML-DSA-87 sizes)
 *   docs/reference/tokenomics.md (fee destinations, wormhole 0.04%, high-security 1%)
 *   chain/runtime/src/configs/mod.rs + runtime/src/lib.rs
 *       (UNIT=10^12 plancks, FEE_SCALE=1/10, LengthToFee=100,000 plancks/byte,
 *        WeightToFee=ScaledIdentityFee ~0.1 planck/ps of ref_time [benchmark-dependent])
 *
 * Pure helpers are exported for node tests; the DOM renderer only runs in a
 * browser. Fully offline — no network calls anywhere in this app.
 */
(function(){
"use strict";

/* ================= Verifed protocol constants ================= */
var UNIT = 1e12;              // plancks per QTC
var BLOCK_TIME = 12;          // seconds per block (target)
var BLOCK_BYTES = 3750000;    // 3.75 MB of transactions per block
var PK_BYTES = 2592;          // ML-DSA-87 public key
var SIG_BYTES = 4627;         // ML-DSA-87 signature
var PQ_OVERHEAD = PK_BYTES + SIG_BYTES; // 7,219 B per tx vs ECDSA ~98 B
var ECDSA_BYTES = 98;
var LENGTH_FEE_PER_BYTE = 100000; // plancks per byte (LengthToFee polynomial)
var FEE_SCALE_NUM = 1, FEE_SCALE_DEN = 10; // FEE_SCALE = 1/10
var WEIGHT_FEE_PER_PS = 0.1;  // ScaledIdentityFee ≈ 0.1 planck per ps of ref_time
                              // (benchmark-dependent estimate — never a fixed fee)
var EXISTENTIAL_QTC = 0.001;
var QUANTUM_QTC = 0.01;       // 1 quantum = 0.01 QTC (settlement ceil unit)
var WORMHOLE_FEE_RATE = 0.0004; // 0.04% volume fee (4 bps)
var HIGHSEC_FEE_RATE = 0.01;    // 1% volume fee, burned

var BADGE_LABEL = { measured:"measured", claimed:"claimed", approx:"approx", estimate:"estimate" };

/* Throughput modes — transfers/block and QTPS = transfers / 12s */
var MODES = [
  { id:"transparent", name:"Transparent ML-DSA-87",
    desc:"Raw quantum-safe transfers, no aggregation.",
    perBlock:510, qtps:"43", badge:"claimed",
    note:"~510 ÷ 12 s ≈ 43 QTPS · docs/architecture.md design figure" },
  { id:"encrypted", name:"Encrypted · two-layer aggregation",
    desc:"Batched proofs collapse the per-transfer on-chain cost.",
    perBlock:5200, qtps:"430", badge:"claimed",
    note:"~5,200 ÷ 12 s ≈ 430 QTPS · docs/architecture.md design target" },
  { id:"ceiling", name:"Encrypted · theoretical ceiling",
    desc:"Absolute packing limit of the 3.75 MB block budget.",
    perBlock:33000, qtps:"2,800", badge:"claimed",
    note:"~33,000 ÷ 12 s ≈ 2,750 QTPS · claimed ceiling" }
];
var AMORT_BYTES_PER_TX = BLOCK_BYTES / 5200; // ≈ 721.15 B/tx aggregated

/* Comparison row */
var CMP = [
  { name:"Bitcoin · quantum-secure (if it went ML-DSA)", tps:"1.1", badge:"claimed",
    note:"Quantus whitepaper claim — Bitcoin's claim to a PQ future" },
  { name:"Bitcoin (classical ECDSA, 1 MB/10 min blocks)", tps:"~7", badge:"approx",
    note:"Observed average, varies with demand" },
  { name:"Ethereum (classical, 12 s slots)", tps:"~15", badge:"approx",
    note:"Observed base-layer average, varies with demand" }
];

/* Wormhole aggregation flow (5 steps) */
var WORMHOLE_STEPS = [
  { n:1, t:"Burn to the wormhole",
    d:"Coins are burned to the wormhole address H(H(salt|secret)). The address itself commits to a secret only you know." },
  { n:2, t:"Prove knowledge in zero-knowledge",
    d:"A Plonky2 ZK proof shows you know the secret preimage — without revealing the salt or secret to anyone." },
  { n:3, t:"Aggregate into one compact proof",
    d:"Many individual proofs are recursively batched into a single compact proof, collapsing the on-chain footprint." },
  { n:4, t:"Post onchain, withdraw",
    d:"The compact proof is posted onchain and the receiver withdraws fresh coins. Sender→receiver link is broken." },
  { n:5, t:"Privacy side-effect",
    d:"A Tornado-Cash-like mechanism: the sender↔receiver link is broken, though amounts and exit addresses remain visible." }
];

/* Sources */
var SOURCES = [
  { t:"Quantus docs — architecture (block time, 3.75 MB, throughput modes)",
    u:"https://github.com/Quantus-Network/docs/blob/main/architecture.md" },
  { t:"Quantus docs — deep dive: post-quantum cryptography (ML-DSA-87 sizes)",
    u:"https://github.com/Quantus-Network/docs/blob/main/deep-dives/pqc.md" },
  { t:"Quantus docs — tokenomics reference (fee destinations, wormhole 0.04%, high-security 1%)",
    u:"https://github.com/Quantus-Network/docs/blob/main/reference/tokenomics.md" },
  { t:"Quantus chain — runtime configs (UNIT, FEE_SCALE, LengthToFee)",
    u:"https://github.com/Quantus-Network/chain/blob/main/runtime/src/configs/mod.rs" },
  { t:"Quantus chain — runtime lib (WeightToFee = ScaledIdentityFee)",
    u:"https://github.com/Quantus-Network/chain/blob/main/runtime/src/lib.rs" },
  { t:"Quantus upstream org",
    u:"https://github.com/Quantus-Network" }
];

/* ================= Pure helpers (node-testable) ================= */

/* Exact length fee: bytes × 100,000 plancks */
function lengthFeePlancks(bytes){
  if (!(bytes > 0)) return 0;
  return Math.round(bytes) * LENGTH_FEE_PER_BYTE;
}

function plancksToQTC(plancks){ return plancks / UNIT; }

/* Human QTC string: up to 8 decimals, trimmed */
function fmtQTC(plancks){
  var q = plancksToQTC(plancks);
  var s = q.toFixed(8).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

function fmtPlancks(plancks){
  return Math.round(plancks).toLocaleString("en-US") + " plancks";
}

/* Weight fee — benchmark-dependent estimate: 0.1 planck per ps of ref_time */
function weightFeeEstimatePlancks(refTimePs){
  if (!(refTimePs > 0)) return 0;
  return refTimePs * WEIGHT_FEE_PER_PS;
}

/* Standard transfer: length fee + weight estimate + optional tip → all to miner */
function standardFee(bytes, tipQTC, refTimePs){
  var len = lengthFeePlancks(bytes);
  var w = weightFeeEstimatePlancks(refTimePs);
  var tip = (tipQTC > 0 ? tipQTC : 0) * UNIT;
  return { lengthPlancks: len, weightPlancks: w, tipPlancks: tip,
           totalPlancks: len + w + tip, toMinerPlancks: len + w + tip };
}

/* Wormhole exit: 0.04% fee; burn = ceil(50% of fee); remainder → miner */
function wormholeFee(amountQTC){
  var amountP = Math.round(Math.max(0, amountQTC) * UNIT);
  var fee = Math.round(amountP * WORMHOLE_FEE_RATE);
  var burn = Math.ceil(fee / 2);
  return { amountPlancks: amountP, feePlancks: fee,
           burnPlancks: burn, minerPlancks: fee - burn };
}

/* High-security / reversible transfer: 1% volume fee, burned */
function highSecFee(amountQTC){
  var amountP = Math.round(Math.max(0, amountQTC) * UNIT);
  var fee = Math.round(amountP * HIGHSEC_FEE_RATE);
  return { amountPlancks: amountP, feePlancks: fee, burnPlancks: fee, minerPlancks: 0 };
}

/* QTPS arithmetic: transfers per block ÷ 12 s block time */
function qtps(perBlock){ return perBlock / BLOCK_TIME; }

/* Aggregation: naive vs amortized on-chain footprint */
function naiveBytes(n){ return Math.max(0, Math.round(n)) * PQ_OVERHEAD; }
function aggregatedBytes(n){ return Math.max(0, Math.round(n)) * AMORT_BYTES_PER_TX; }
function naiveBlocks(n){ return naiveBytes(n) / BLOCK_BYTES; }

function fmtBytes(bytes){
  if (!(bytes > 0)) return "0 B";
  var units = ["B","KB","MB","GB","TB"], i = 0, v = bytes;
  while (v >= 1000 && i < units.length - 1){ v /= 1000; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + " " + units[i];
}

/* ================= Browser renderer ================= */
function el(tag, cls, html){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function fmtQtps(p){ return (qtps(p)).toLocaleString("en-US", {maximumFractionDigits:1}); }

function init(){
  renderModes(); renderCmp(); renderEstimator(); renderAgg(); renderSig(); renderSources(); wireCopy();
  wireCanvas();
}

/* ---- Throughput visualizer ---- */
function renderModes(){
  var wrap = document.getElementById("mode-bars");
  var max = Math.max.apply(null, MODES.map(function(m){ return m.perBlock; }));
  MODES.forEach(function(m, i){
    var row = el("div", "mode-row");
    var info = el("div", "mode-info",
      "<div class='mode-name'>" + m.name +
      " <span class='badge b-" + m.badge + "'>" + BADGE_LABEL[m.badge] + "</span></div>" +
      "<div class='mode-desc'>" + m.desc + "</div>" +
      "<div class='mode-math'>" + m.perBlock.toLocaleString("en-US") + " transfers ÷ " +
      BLOCK_TIME + " s = <strong>" + fmtQtps(m.perBlock) + " QTPS</strong>" +
      " <span class='mode-approx'>(≈ " + m.qtps + " QTPS)</span></div>" +
      "<div class='mode-note'>" + m.note + "</div>");
    var barw = el("div", "bar-track", "<div class='bar-fill'></div>");
    row.appendChild(info); row.appendChild(barw); wrap.appendChild(row);
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        barw.querySelector(".bar-fill").style.width = (m.perBlock / max * 100).toFixed(2) + "%";
      });
    });
  });
}

function renderCmp(){
  var wrap = document.getElementById("cmp-row");
  var scale = 2800;
  CMP.forEach(function(c){
    var tpsNum = parseFloat(c.tps.replace("~",""));
    var row = el("div", "cmp-card",
      "<div class='cmp-name'>" + c.name + "</div>" +
      "<div class='cmp-tps'>" + c.tps + " <span>TPS</span></div>" +
      "<div class='bar-track thin'><div class='bar-fill cmp-fill'></div></div>" +
      "<div class='cmp-note'>" + c.note + " <span class='badge b-" + c.badge + "'>" +
      BADGE_LABEL[c.badge] + "</span></div>");
    wrap.appendChild(row);
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        row.querySelector(".cmp-fill").style.width =
          Math.max(0.6, tpsNum / scale * 100).toFixed(2) + "%";
      });
    });
  });
}

/* ---- Fee estimator tabs ---- */
var estState = { bytes: 7500, tip: 0.0002, refTime: 1e9, wh: 100, hs: 50 };

function renderEstimator(){
  var tabs = document.querySelectorAll("#estimator .tab");
  tabs.forEach(function(tab){
    tab.addEventListener("click", function(){
      tabs.forEach(function(t2){ t2.classList.remove("active"); });
      tab.classList.add("active");
      document.querySelectorAll("#estimator .pane").forEach(function(p){
        p.classList.toggle("active", p.id === "pane-" + tab.dataset.tab);
      });
    });
  });

  /* standard pane */
  var bytesIn = document.getElementById("std-bytes");
  var bytesOut = document.getElementById("std-bytes-out");
  var tipIn = document.getElementById("std-tip");
  var tipOut = document.getElementById("std-tip-out");
  var refIn = document.getElementById("std-ref");
  var calcStd = function(){
    estState.bytes = Math.max(0, Math.round(parseFloat(bytesIn.value) || 0));
    estState.tip = Math.max(0, parseFloat(tipIn.value) || 0);
    estState.refTime = Math.max(0, parseFloat(refIn.value) || 0);
    bytesOut.textContent = estState.bytes.toLocaleString("en-US") + " B";
    tipOut.textContent = estState.tip + " QTC";
    var r = standardFee(estState.bytes, estState.tip, estState.refTime);
    document.getElementById("std-len").textContent =
      fmtPlancks(r.lengthPlancks) + " = " + fmtQTC(r.lengthPlancks) + " QTC";
    document.getElementById("std-len-math").textContent =
      estState.bytes.toLocaleString("en-US") + " B × 100,000 plancks/B";
    document.getElementById("std-w").textContent =
      fmtPlancks(r.weightPlancks) + " ≈ " + fmtQTC(r.weightPlancks) + " QTC";
    document.getElementById("std-w-math").textContent =
      "0.1 planck × " + estState.refTime.toExponential(0).replace("e+","×10^") + " ps ref_time (example)";
    document.getElementById("std-tip-v").textContent =
      fmtPlancks(r.tipPlancks) + " = " + estState.tip + " QTC";
    document.getElementById("std-total").textContent =
      fmtQTC(r.totalPlancks) + " QTC";
    document.getElementById("std-total-p").textContent = fmtPlancks(r.totalPlancks);
  };
  [bytesIn, tipIn, refIn].forEach(function(i){ i.addEventListener("input", calcStd); });
  calcStd();

  /* wormhole pane */
  var whIn = document.getElementById("wh-amount");
  var calcWh = function(){
    estState.wh = Math.max(0, parseFloat(whIn.value) || 0);
    var r = wormholeFee(estState.wh);
    document.getElementById("wh-fee").textContent =
      fmtQTC(r.feePlancks) + " QTC  (" + fmtPlancks(r.feePlancks) + ")";
    document.getElementById("wh-fee-math").textContent =
      estState.wh + " QTC × 0.04% = " + estState.wh + " × 0.0004";
    document.getElementById("wh-burn").textContent =
      fmtQTC(r.burnPlancks) + " QTC  (" + fmtPlancks(r.burnPlancks) + ")";
    document.getElementById("wh-miner").textContent =
      fmtQTC(r.minerPlancks) + " QTC  (" + fmtPlancks(r.minerPlancks) + ")";
  };
  whIn.addEventListener("input", calcWh);
  calcWh();

  /* high-security pane */
  var hsIn = document.getElementById("hs-amount");
  var calcHs = function(){
    estState.hs = Math.max(0, parseFloat(hsIn.value) || 0);
    var r = highSecFee(estState.hs);
    document.getElementById("hs-fee").textContent =
      fmtQTC(r.feePlancks) + " QTC  (" + fmtPlancks(r.feePlancks) + ")";
    document.getElementById("hs-fee-math").textContent =
      estState.hs + " QTC × 1% — burned in full, no miner share";
  };
  hsIn.addEventListener("input", calcHs);
  calcHs();
}

/* ---- Aggregation explorer ---- */
var aggDots = [];
function renderAgg(){
  /* wormhole steps */
  var steps = document.getElementById("worm-steps");
  WORMHOLE_STEPS.forEach(function(s){
    steps.appendChild(el("div", "wstep",
      "<div class='wstep-n'>" + s.n + "</div>" +
      "<div><div class='wstep-t'>" + s.t + "</div><div class='wstep-d'>" + s.d + "</div></div>"));
  });

  var nIn = document.getElementById("agg-n");
  var nOut = document.getElementById("agg-n-out");
  var upd = function(){
    var n = Math.max(10, Math.round(parseFloat(nIn.value) || 10));
    nOut.textContent = n.toLocaleString("en-US");
    var nb = naiveBytes(n), ab = aggregatedBytes(n), bl = naiveBlocks(n);
    document.getElementById("agg-naive").textContent = fmtBytes(nb);
    document.getElementById("agg-naive-math").textContent =
      n.toLocaleString("en-US") + " × 7,219 B = " + Math.round(nb).toLocaleString("en-US") + " B";
    document.getElementById("agg-blocks").textContent =
      bl < 1.05 ? "≈ 1 block" : "≈ " + bl.toFixed(1) + " blocks";
    document.getElementById("agg-agg").textContent = fmtBytes(ab);
    document.getElementById("agg-agg-math").textContent =
      n.toLocaleString("en-US") + " × " + AMORT_BYTES_PER_TX.toFixed(1) + " B/tx";
    document.getElementById("agg-ratio").textContent =
      (PQ_OVERHEAD / AMORT_BYTES_PER_TX).toFixed(1) + "×";
    seedAggDots(n);
  };
  nIn.addEventListener("input", upd);
  upd();
}

/* animated batching: dots stream from a cloud into one compact proof bar */
function seedAggDots(n){
  var cap = 420;
  var shown = Math.min(n, cap);
  aggDots = [];
  for (var i = 0; i < shown; i++){
    aggDots.push({ x: Math.random() * 0.62, y: 0.06 + Math.random() * 0.88,
      sp: 0.25 + Math.random() * 0.5, ph: Math.random() * Math.PI * 2,
      amt: n / shown });
  }
}
function wireCanvas(){
  var c = document.getElementById("agg-canvas");
  if (!c) return;
  var ctx = c.getContext("2d");
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function size(){ c.width = c.offsetWidth * 2; c.height = 300 * 2; }
  size(); addEventListener("resize", size);
  var t = 0;
  function frame(){
    t += 0.016;
    var W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    /* proof bar zone (right side) */
    ctx.fillStyle = "rgba(51,255,200,.10)";
    ctx.fillRect(W * 0.72, H * 0.18, W * 0.20, H * 0.64);
    ctx.strokeStyle = "rgba(51,255,200,.55)"; ctx.lineWidth = 3;
    ctx.strokeRect(W * 0.72, H * 0.18, W * 0.20, H * 0.64);
    ctx.fillStyle = "rgba(240,255,250,.85)";
    ctx.font = (26 * 2) + "px system-ui";
    ctx.fillText("1 compact proof", W * 0.735, H * 0.52);
    /* dots fly right, get absorbed */
    aggDots.forEach(function(d){
      var x = d.x;
      if (!reduce){
        x += d.sp * 0.016 * 1.2;
        if (x > 0.72) x = 0.0; /* loop back */
        d.x = x;
      }
      var px = x * W, py = d.y * H;
      var fade = x < 0.62 ? 1 : Math.max(0, 1 - (x - 0.62) / 0.10);
      ctx.globalAlpha = 0.9 * fade;
      ctx.fillStyle = "#33ffc8";
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, 7);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (!reduce) requestAnimationFrame(frame);
    else {
      /* static render when motion reduced */
      aggDots.forEach(function(d){
        ctx.globalAlpha = 0.9; ctx.fillStyle = "#33ffc8";
        ctx.beginPath(); ctx.arc(d.x * W, d.y * H, 5, 0, 7); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
  }
  frame();
}

/* ---- Signature-size lab ---- */
function renderSig(){
  var callIn = document.getElementById("sig-call");
  var callOut = document.getElementById("sig-call-out");
  var parts = [
    { name:"ML-DSA-87 public key", bytes: PK_BYTES, color:"#33ffc8" },
    { name:"ML-DSA-87 signature", bytes: SIG_BYTES, color:"#ffb454" },
    { name:"call data (extrinsic payload)", bytes: null, color:"#8b7bff" }
  ];
  var build = function(){
    var call = Math.max(0, Math.round(parseFloat(callIn.value) || 0));
    callOut.textContent = call.toLocaleString("en-US") + " B";
    var wrap = document.getElementById("sig-stack");
    wrap.innerHTML = "";
    var total = 0;
    parts.forEach(function(p){ total += (p.bytes != null ? p.bytes : call); });
    var row = el("div", "sig-stack-row");
    parts.forEach(function(p){
      var b = p.bytes != null ? p.bytes : call;
      var seg = el("div", "sig-seg");
      seg.style.width = Math.max(0.4, b / total * 100).toFixed(2) + "%";
      seg.style.background = p.color;
      seg.title = p.name + ": " + b.toLocaleString("en-US") + " B";
      row.appendChild(seg);
    });
    wrap.appendChild(row);
    var legend = el("div", "sig-legend");
    parts.forEach(function(p){
      var b = p.bytes != null ? p.bytes : call;
      legend.appendChild(el("div", "sig-leg",
        "<span class='chip' style='background:" + p.color + "'></span>" +
        p.name + " — <strong>" + b.toLocaleString("en-US") + " B</strong>"));
    });
    wrap.appendChild(legend);
    wrap.appendChild(el("div", "sig-total",
      "Total per transfer: <strong>" + total.toLocaleString("en-US") + " B</strong>" +
      " — the public key + signature alone cost <strong>" +
      PQ_OVERHEAD.toLocaleString("en-US") + " B</strong> before a single byte of payload."));
    /* ECDSA comparison (log scale against ~98 B) */
    var cmp = document.getElementById("sig-cmp");
    cmp.innerHTML = "";
    var log = function(v){ return Math.log10(v); };
    var lMax = log(total);
    [{ n:"Quantus transfer", v: total, c:"#33ffc8" },
     { n:"ECDSA-style transfer overhead", v: ECDSA_BYTES, c:"#64748b" }]
    .forEach(function(b2){
      var r2 = el("div", "sig-cmp-row",
        "<div class='sig-cmp-name'>" + b2.n +
        " <span class='badge b-measured'>measured</span></div>" +
        "<div class='bar-track thin'><div class='bar-fill' style='background:" + b2.c +
        "'></div></div>" +
        "<div class='sig-cmp-v'>" + b2.v.toLocaleString("en-US") + " B" +
        (b2.v === ECDSA_BYTES ? " <span class='fine'>(≈ 64 B signature + ~34 B overhead)</span>" : "") + "</div>");
      cmp.appendChild(r2);
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          r2.querySelector(".bar-fill").style.width =
            Math.max(1.5, log(b2.v) / lMax * 100).toFixed(2) + "%";
        });
      });
    });
  };
  callIn.addEventListener("input", build);
  build();
}

/* ---- Sources + copy button ---- */
function renderSources(){
  var list = document.getElementById("source-list");
  SOURCES.forEach(function(s){
    var li = document.createElement("li");
    li.innerHTML = "<a href='" + s.u + "' target='_blank' rel='noopener'>" + s.t + "</a>";
    list.appendChild(li);
  });
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

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);

/* ---- node-testable exports ---- */
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    UNIT: UNIT, BLOCK_TIME: BLOCK_TIME, BLOCK_BYTES: BLOCK_BYTES,
    PK_BYTES: PK_BYTES, SIG_BYTES: SIG_BYTES, PQ_OVERHEAD: PQ_OVERHEAD,
    ECDSA_BYTES: ECDSA_BYTES, LENGTH_FEE_PER_BYTE: LENGTH_FEE_PER_BYTE,
    WEIGHT_FEE_PER_PS: WEIGHT_FEE_PER_PS,
    EXISTENTIAL_QTC: EXISTENTIAL_QTC, QUANTUM_QTC: QUANTUM_QTC,
    WORMHOLE_FEE_RATE: WORMHOLE_FEE_RATE, HIGHSEC_FEE_RATE: HIGHSEC_FEE_RATE,
    MODES: MODES, CMP: CMP, WORMHOLE_STEPS: WORMHOLE_STEPS, SOURCES: SOURCES,
    AMORT_BYTES_PER_TX: AMORT_BYTES_PER_TX, BADGE_LABEL: BADGE_LABEL,
    lengthFeePlancks: lengthFeePlancks, plancksToQTC: plancksToQTC,
    fmtQTC: fmtQTC, fmtPlancks: fmtPlancks, fmtBytes: fmtBytes,
    weightFeeEstimatePlancks: weightFeeEstimatePlancks, standardFee: standardFee,
    wormholeFee: wormholeFee, highSecFee: highSecFee, qtps: qtps,
    naiveBytes: naiveBytes, aggregatedBytes: aggregatedBytes, naiveBlocks: naiveBlocks
  };
}
})();
