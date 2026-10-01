/* QTC Mining Calculator — pure chain math + UI.
 * Chain facts (verified 2026-09-29 against Quantus-Network/docs):
 *   - 12s target block time (docs/architecture.md)
 *   - Block reward = (21,000,000 - currentSupply) / 50,000,000 (docs/reference/tokenomics.md)
 *   - 21M cap, 27% genesis mint (5.67M QTC), 73% to miners, 100% of each block reward to miner
 *   - 1 QTC = 10^12 planck; mainnet live Sept 9, 2026
 */
(function(){
"use strict";

var CHAIN = {
  BLOCK_TIME_S: 12,
  MAX_SUPPLY: 21000000,
  GENESIS_MINT: 5670000,
  EMISSION_DIVISOR: 50000000,
  MAINNET_T0: Date.parse("2026-09-09T00:00:00Z"),
  UNITS: {"H/s":1,"kH/s":1e3,"MH/s":1e6,"GH/s":1e9,"TH/s":1e12}
};
CHAIN.BLOCKS_PER_DAY = 86400 / CHAIN.BLOCK_TIME_S; // 7200

/* Pure: chain state at a timestamp. Exponential decay derived from the
 * per-block formula reward = (MAX - S)/DIVISOR applied continuously. */
function chainState(atMs){
  var blocks = Math.max(0, Math.floor((atMs - CHAIN.MAINNET_T0) / (CHAIN.BLOCK_TIME_S*1000)));
  var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-blocks / CHAIN.EMISSION_DIVISOR);
  var supply = CHAIN.MAX_SUPPLY - remaining;
  var reward = remaining / CHAIN.EMISSION_DIVISOR;
  return { blocks: blocks, supply: supply, reward: reward, blocksPerDay: CHAIN.BLOCKS_PER_DAY };
}

/* Pure: mining estimate. All rates per day. */
function estimate(o){
  var userHs = o.userHs > 0 ? o.userHs : 0;
  var netHs  = o.netHs  > 0 ? o.netHs  : 0;
  var share = netHs > 0 ? userHs / netHs : 0;
  var clamped = false;
  if (share > 1){ share = 1; clamped = true; }
  var blocksPerDay = share * CHAIN.BLOCKS_PER_DAY;
  var qtcPerDay = blocksPerDay * o.reward;
  var daysPerBlock = share > 0 ? (1 / share) / CHAIN.BLOCKS_PER_DAY : Infinity;
  var kwhPerDay = Math.max(0, o.watts) * 24 / 1000;
  var powerCost = kwhPerDay * Math.max(0, o.kwhPrice);
  var revenue = o.qtcPrice > 0 ? qtcPerDay * o.qtcPrice : 0;
  var profit = o.qtcPrice > 0 ? revenue - powerCost : -powerCost;
  var breakeven = qtcPerDay > 0 ? powerCost / qtcPerDay : Infinity;
  return {
    share: share, shareClamped: clamped, blocksPerDay: blocksPerDay,
    qtcPerDay: qtcPerDay, daysPerBlock: daysPerBlock,
    powerCost: powerCost, revenue: revenue, profit: profit,
    breakeven: breakeven, hasPrice: o.qtcPrice > 0
  };
}

function fmtNum(n, digits){
  if (!isFinite(n)) return "\u2014";
  if (n === 0) return "0";
  var a = Math.abs(n);
  var suf = "", v = n;
  if (a >= 1e9){ v = n/1e9; suf = "B"; }
  else if (a >= 1e6){ v = n/1e6; suf = "M"; }
  else if (a >= 1e3){ v = n/1e3; suf = "K"; }
  return v.toFixed(digits == null ? 2 : digits).replace(/\.?0+$/,"") + (suf ? " " + suf : "");
}
function fmtQTC(n){
  if (!isFinite(n)) return "\u2014";
  return n >= 100 ? fmtNum(n,2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
function fmtMoney(n){
  if (!isFinite(n)) return "\u2014";
  var sign = n < 0 ? "-" : "", a = Math.abs(n), suf = "", v = a;
  if (a >= 1e9){ v = a/1e9; suf = "B"; }
  else if (a >= 1e6){ v = a/1e6; suf = "M"; }
  else if (a >= 1e3){ v = a/1e3; suf = "K"; }
  return sign + "$" + v.toFixed(2) + (suf ? " " + suf : "");
}
function fmtDuration(days){
  if (!isFinite(days)) return "\u2014";
  if (days < 1) return (days*24).toFixed(1) + " hours";
  if (days < 60) return days.toFixed(1) + " days";
  if (days < 730) return (days/30.44).toFixed(1) + " months";
  return (days/365.25).toFixed(1) + " years";
}

/* ---------- UI wiring (browser only) ---------- */
function init(){
  var $ = function(id){ return document.getElementById(id); };
  var inputs = ["in-user","in-user-unit","in-net","in-net-unit","in-watts","in-kwh","in-price","in-supply"];

  // Hash-rain canvas: falling hex glyphs, gold on obsidian.
  (function(){
    var c = $("hashrain"), x = c.getContext("2d"), cols = [], glyphs = "0123456789abcdef";
    function size(){ c.width = innerWidth; c.height = innerHeight;
      var n = Math.floor(innerWidth/26); cols = [];
      for (var i=0;i<n;i++) cols.push({x:i*26, y:Math.random()*innerHeight, v:1+Math.random()*2.4});
    }
    size(); addEventListener("resize", size);
    x.font = "15px monospace";
    var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    (function tick(){
      x.fillStyle = "rgba(8,5,3,0.14)"; x.fillRect(0,0,c.width,c.height);
      for (var i=0;i<cols.length;i++){ var col = cols[i];
        var g = glyphs[(Math.random()*16)|0];
        x.fillStyle = Math.random() < .06 ? "rgba(255,217,122,.85)" : "rgba(245,185,66,.34)";
        x.fillText(g, col.x, col.y);
        col.y += col.v * 15;
        if (col.y > c.height + 20){ col.y = -20; col.v = 1 + Math.random()*2.4; }
      }
      if (!REDUCE_MOTION) requestAnimationFrame(tick);
    })();
  })();

  function readInputs(){
    var state = chainState(Date.now());
    var supplyOv = parseFloat($("in-supply").value);
    var supply = isFinite(supplyOv) && supplyOv > 0 ? supplyOv : state.supply;
    var reward = (CHAIN.MAX_SUPPLY - supply) / CHAIN.EMISSION_DIVISOR;
    return {
      userHs: parseFloat($("in-user").value) * (CHAIN.UNITS[$("in-user-unit").value] || 1),
      netHs:  parseFloat($("in-net").value)  * (CHAIN.UNITS[$("in-net-unit").value]  || 1),
      watts: parseFloat($("in-watts").value) || 0,
      kwhPrice: parseFloat($("in-kwh").value) || 0,
      qtcPrice: parseFloat($("in-price").value),
      reward: reward, supply: supply
    };
  }

  function recalc(){
    var inp = readInputs();
    if (!isFinite(inp.qtcPrice) || inp.qtcPrice < 0) inp.qtcPrice = 0;
    var e = estimate({ userHs: inp.userHs, netHs: inp.netHs, watts: inp.watts,
                       kwhPrice: inp.kwhPrice, qtcPrice: inp.qtcPrice, reward: inp.reward });
    $("r-qtcday").textContent = fmtQTC(e.qtcPerDay);
    $("r-profit").textContent = e.hasPrice ? fmtMoney(e.profit) : "\u2014";
    $("r-share").textContent = (e.share*100) >= 0.01 ? (e.share*100).toFixed(e.share*100 >= 1 ? 2 : 4) + "%" : "< 0.01%";
    $("r-blocks").textContent = fmtNum(e.blocksPerDay, 2);
    $("r-ttp").textContent = fmtDuration(e.daysPerBlock);
    $("r-reward").textContent = fmtQTC(inp.reward) + " QTC";
    $("r-cost").textContent = fmtMoney(e.powerCost);
    $("r-rev").textContent = e.hasPrice ? fmtMoney(e.revenue) : "\u2014";
    $("r-breakeven").textContent = e.hasPrice || e.qtcPerDay > 0 ? fmtMoney(e.breakeven) + " / QTC" : "\u2014";
    var warn = $("r-warn");
    if (e.shareClamped){ warn.hidden = false; warn.textContent = "Your hashrate meets or exceeds the network figure — share capped at 100%. Check the network value."; }
    else if (inp.netHs <= 0){ warn.hidden = false; warn.textContent = "Enter the live network hashrate (see telemetry) for a real estimate."; }
    else warn.hidden = true;
  }
  inputs.forEach(function(id){
    $(id).addEventListener("input", recalc);
    $(id).addEventListener("change", recalc);
  });

  // Emission chart: block-reward decay over 12 years + "today" marker.
  (function(){
    var c = $("chart"), x = c.getContext("2d");
    function draw(){
      var W = c.width, H = c.height, padL = 64, padR = 16, padT = 18, padB = 34;
      var YEARS = 12, pts = [];
      for (var i=0;i<=240;i++){
        var yrs = YEARS * i/240;
        var blocks = yrs * 365.25 * CHAIN.BLOCKS_PER_DAY;
        var remaining = (CHAIN.MAX_SUPPLY - CHAIN.GENESIS_MINT) * Math.exp(-blocks / CHAIN.EMISSION_DIVISOR);
        pts.push({x: yrs, y: remaining / CHAIN.EMISSION_DIVISOR});
      }
      var maxY = pts[0].y * 1.05;
      var X = function(v){ return padL + (v/YEARS)*(W-padL-padR); };
      var Y = function(v){ return H-padB - (v/maxY)*(H-padT-padB); };
      x.clearRect(0,0,W,H);
      x.strokeStyle = "rgba(245,185,66,.12)"; x.fillStyle = "rgba(168,152,128,.9)";
      x.font = "11px monospace"; x.lineWidth = 1;
      for (var g=0; g<=4; g++){
        var gy = Y(maxY*g/4);
        x.beginPath(); x.moveTo(padL,gy); x.lineTo(W-padR,gy); x.stroke();
        x.fillText((maxY*g/4).toFixed(2), 8, gy+4);
      }
      for (var gx=0; gx<=YEARS; gx+=2){
        x.fillText(gx+"y", X(gx)-6, H-12);
      }
      x.fillText("QTC / block", 8, 14);
      // area
      var grad = x.createLinearGradient(0,padT,0,H-padB);
      grad.addColorStop(0,"rgba(245,185,66,.5)"); grad.addColorStop(1,"rgba(245,185,66,.02)");
      x.beginPath(); x.moveTo(X(0), Y(pts[0].y));
      pts.forEach(function(p){ x.lineTo(X(p.x), Y(p.y)); });
      x.lineTo(X(YEARS), H-padB); x.lineTo(X(0), H-padB); x.closePath();
      x.fillStyle = grad; x.fill();
      x.beginPath(); x.moveTo(X(0), Y(pts[0].y));
      pts.forEach(function(p){ x.lineTo(X(p.x), Y(p.y)); });
      x.strokeStyle = "#f5b942"; x.lineWidth = 2.5; x.stroke();
      // today marker
      var nowYrs = (Date.now() - CHAIN.MAINNET_T0) / (365.25*86400*1000);
      if (nowYrs >= 0 && nowYrs <= YEARS){
        x.strokeStyle = "rgba(255,107,53,.8)"; x.setLineDash([5,4]); x.lineWidth = 1.5;
        x.beginPath(); x.moveTo(X(nowYrs), padT); x.lineTo(X(nowYrs), H-padB); x.stroke();
        x.setLineDash([]);
        x.fillStyle = "#ff8a5c"; x.fillText("today", X(nowYrs)-14, padT+2);
      }
    }
    draw();
  })();

  // Chain stats strip under the chart.
  (function(){
    var s = chainState(Date.now());
    $("s-reward").textContent = fmtQTC(s.reward) + " QTC";
    $("s-supply").textContent = fmtNum(s.supply, 2) + " QTC";
    $("s-daily").textContent = fmtNum(s.reward * s.blocksPerDay, 0) + " QTC";
  })();

  // Donation address click-to-copy.
  document.querySelectorAll(".addr").forEach(function(b){
    b.addEventListener("click", function(){
      var done = function(){ var t=b.textContent; b.textContent="Copied!"; setTimeout(function(){ b.textContent=t; },1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(done, done);
      else done();
    });
  });

  recalc();
}

if (typeof document !== "undefined" && typeof window !== "undefined"){
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

/* Node test hook */
if (typeof module !== "undefined" && module.exports){
  module.exports = { CHAIN: CHAIN, chainState: chainState, estimate: estimate,
                     fmtNum: fmtNum, fmtQTC: fmtQTC, fmtMoney: fmtMoney, fmtDuration: fmtDuration };
}
})();
