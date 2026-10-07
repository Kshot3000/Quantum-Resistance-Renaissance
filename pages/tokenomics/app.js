/* QTC Tokenomics Explorer — the 21M QTC traced from genesis.
 * All chain figures verified 2026-09-29 against the chain repo (Quantus-Network/chain):
 *   mainnet_vesting.rs: GENESIS_ALLOCATION = 5,670,000 QTC (27%); FINALIZED = true;
 *     48 vesting rows; compile-time assert sum(VESTING) + 20*SEED == 5,670,000.
 *     grants 4,957,502 (incl. 42,000 intents grant) · liquidity 210,000/16d ·
 *     treasury remainder 502,438 · seeds 3 QTC x 20 = 60 · cliff 365d, linear to 1460d.
 *   configs/mod.rs: EmissionDivisor = 50_000_000; reward = (21M - supply)/50M.
 *   pallets/wormhole tests: volume_fee_bps = 4 (0.04% on exits, ceil to whole quanta).
 *   docs tokenomics.md (draft upstream): fee split rules, TGE definition, funding rounds.
 * TGE is modeled as 2026-09-09T00:00:00Z (mainnet launch); the docs define TGE as the
 * first non-zero block timestamp, so real unlock dates may shift by hours.
 */
(function(){
"use strict";

var CHAIN = {
  MAX_SUPPLY: 21000000,
  GENESIS_MINT: 5670000,
  MINER_TAIL: 15330000,
  EMISSION_DIVISOR: 50000000,
  BLOCK_TIME_S: 12,
  DAY_MS: 86400000,
  TGE_MS: Date.parse("2026-09-09T00:00:00Z")
};
CHAIN.BLOCKS_PER_DAY = 86400 / CHAIN.BLOCK_TIME_S; // 7200

/* Genesis vesting buckets: linear unlock from TGE, cliff == start (days). */
var GENESIS_BUCKETS = [
  { id:"grants",    name:"Spreadsheet grants",  amount:4915502, start:365, end:1460,
    color:"#5eead4", term:"1-year lock from TGE, then linear over 3 years" },
  { id:"intents",   name:"Intents grant",       amount:42000,   start:0,   end:365,
    color:"#7fd6c0", term:"Linear from TGE over 365 days — no lockup" },
  { id:"liquidity", name:"Treasury liquidity",  amount:210000,  start:0,   end:16,
    color:"#f0c060", term:"Linear over 16 days from TGE — no lockup (fully unlocked now)" },
  { id:"treasury",  name:"Treasury remainder",  amount:502438,  start:365, end:1460,
    color:"#e8a94a", term:"Same 1-yr + 3-yr grant clock · held by 6-of-10 multisig" },
  { id:"seeds",     name:"Governance seeds",    amount:60,      start:0,   end:0,
    color:"#9db8ac", term:"3 QTC liquid each to 10 treasurers + 10 tech-collective members" }
];
var MINER_BUCKET = { id:"miners", name:"Miner tail", amount:15330000, color:"#2ea078",
  term:"73% earned via PoW — smooth exponential decay, no halvings, no dev tax" };

var FUNDING = [
  { name:"Private Round 1", raised:1650000, equity:20000000, token:40000000, lead:"—" },
  { name:"Private Round 2", raised:770000,  equity:50000000, token:100000000, lead:"Balaji Srinivasan" }
];

/* ---------------- pure helpers (Node-testable) ---------------- */

function fmtInt(n){
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtQTC(n, digits){
  if (n === null || n === undefined || !isFinite(n)) return "—";
  var d = (digits == null ? 2 : digits);
  return fmtInt(Math.floor(n)) + (n % 1 !== 0 ? "." + (Math.round((n % 1) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).slice(2) : "");
}
function fmtDate(ms){
  var d = new Date(ms);
  var M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return M[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}
function daysSinceTGE(atMs){
  return (atMs - CHAIN.TGE_MS) / CHAIN.DAY_MS;
}

/* Linear vesting: fully locked before start, linear to end, fully unlocked after. */
function unlockedAt(bucket, days){
  if (bucket.end === 0) return days >= 0 ? bucket.amount : 0; // instant schedule (seeds: liquid at TGE)
  if (days <= bucket.start) return 0;
  if (days >= bucket.end) return bucket.amount;
  return bucket.amount * (days - bucket.start) / (bucket.end - bucket.start);
}
function genesisUnlocked(days){
  var total = 0, i;
  for (i = 0; i < GENESIS_BUCKETS.length; i++) total += unlockedAt(GENESIS_BUCKETS[i], days);
  return total;
}

/* Emission model (continuous form of the per-block formula). */
function supplyAtBlocks(blocks){
  var remaining = CHAIN.MINER_TAIL * Math.exp(-Math.max(0, blocks) / CHAIN.EMISSION_DIVISOR);
  return CHAIN.MAX_SUPPLY - remaining;
}
function blockRewardAtBlocks(blocks){
  var remaining = CHAIN.MAX_SUPPLY - supplyAtBlocks(blocks);
  return Math.max(0, remaining) / CHAIN.EMISSION_DIVISOR;
}
function rewardAtDays(days){
  return blockRewardAtBlocks(Math.max(0, days) * CHAIN.BLOCKS_PER_DAY);
}
/* First day (since TGE) at which modeled supply reaches target QTC. -1 if never. */
function milestoneDay(targetQTC){
  if (targetQTC <= CHAIN.GENESIS_MINT) return 0;
  if (targetQTC >= CHAIN.MAX_SUPPLY) return -1;
  var lo = 0, hi = 365.25 * 400, i;
  for (i = 0; i < 80; i++){
    var mid = (lo + hi) / 2;
    if (supplyAtBlocks(mid * CHAIN.BLOCKS_PER_DAY) < targetQTC) lo = mid; else hi = mid;
  }
  return hi;
}

/* Exact decimal -> plancks (BigInt, half-up past 12 dp, exponent forms OK).
 * Same parser the Fee & Throughput Lab standardized on — no float ever
 * touches a fee figure on this page. */
function qtcToPlancksExact(value){
  if (typeof value === "bigint") return value > 0n ? value * 1000000000000n : 0n;
  var s = String(value == null ? "" : value).trim();
  var m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) return 0n;
  var raw = (m[2] || "") + (m[3] || "");
  var lead = raw.length - raw.replace(/^0+/, "").length;
  var digits = raw.replace(/^0+/, "") || "0";
  var point = (m[2] || "").length - lead + (m[4] ? parseInt(m[4], 10) : 0);
  if (m[1] === "-") return 0n;
  var scale = point + 12;
  var kept, roundUp = false;
  if (scale <= 0){
    kept = "0";
    roundUp = scale === 0 && digits[0] >= "5";
    if (scale < 0) roundUp = false;
  } else if (digits.length > scale){
    kept = digits.slice(0, scale);
    roundUp = digits[scale] >= "5";
  } else {
    kept = digits + "0".repeat(scale - digits.length);
  }
  var out = BigInt(kept);
  if (roundUp) out += 1n;
  return out;
}

var QUANTUM_PLANCKS = 10000000000n; // wormhole SCALE_DOWN_FACTOR: 1 quantum = 0.01 QTC

/* Wormhole exit fee, exact BigInt — mirrors pallets/wormhole
 * volume_fee_for_exit as proven in the Fee & Throughput Lab:
 * fee_quanta = ceil(amount_plancks * 4 / (10000 * quantum)), minimum
 * 1 quantum for any positive amount; split in whole quanta —
 * burn bucket = ceil(fee/2) (Permill mul_ceil), miner keeps the rest;
 * public batches redirect floor(burn bucket/2) to the aggregator.
 * The amount itself is NEVER rounded: sub-quantum inputs keep their
 * exact plancks (the old float version silently ceiled the displayed
 * exit volume up to whole quanta). */
function wormholeFee(qtc){
  var amountP = qtcToPlancksExact(qtc);
  if (amountP <= 0n)
    return { amountPlancks: 0n, feeQuanta: 0n, burnQuanta: 0n, minerQuanta: 0n, aggQuanta: 0n };
  var feeQuanta = (amountP * 4n + (10000n * QUANTUM_PLANCKS - 1n)) / (10000n * QUANTUM_PLANCKS);
  var burnBucket = (feeQuanta + 1n) / 2n;
  var minerQuanta = feeQuanta - burnBucket;
  var aggQuanta = burnBucket / 2n;
  return { amountPlancks: amountP, feeQuanta: feeQuanta,
           burnQuanta: burnBucket - aggQuanta, minerQuanta: minerQuanta, aggQuanta: aggQuanta };
}
/* High-security fee: the reversible-transfers pallet charges
 * Permill(1%) * amount, floored to the planck, fully burned. */
function hsFee(qtc){
  var amountP = qtcToPlancksExact(qtc);
  if (amountP <= 0n) return { amountPlancks: 0n, feePlancks: 0n, netPlancks: 0n };
  var feeP = amountP / 100n;
  return { amountPlancks: amountP, feePlancks: feeP, netPlancks: amountP - feeP };
}
/* Exact plancks -> grouped QTC string, fraction trimmed (max 12 dp). */
function fmtPlancksExact(plancks){
  var p = BigInt(plancks);
  var neg = p < 0n; if (neg) p = -p;
  var whole = (p / 1000000000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  var frac = (p % 1000000000000n).toString().padStart(12, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
/* Whole quanta -> exact QTC string (quanta are hundredths, always 2 dp). */
function fmtQuanta(quanta){
  var q = BigInt(quanta);
  var whole = (q / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return whole + "." + (q % 100n).toString().padStart(2, "0");
}
function q2qtc(q){ return Number(q) / 100; } // legacy helper, display-only

/* SVG builders (pure, testable). */
function vestChartSVG(daysMax, step){
  var W = 900, H = 340, P = { l: 64, r: 16, t: 14, b: 30 };
  var iw = W - P.l - P.r, ih = H - P.t - P.b;
  var X = function(d){ return P.l + iw * d / daysMax; };
  var Y = function(v){ return P.t + ih * (1 - v / CHAIN.GENESIS_MINT); };
  var pts = [];
  for (var d = 0; d <= daysMax; d += step) pts.push(d);
  if (pts[pts.length - 1] !== daysMax) pts.push(daysMax);
  function lineOf(idx){ // cumulative unlocked through bucket idx
    return pts.map(function(d){
      var c = 0, i;
      for (i = 0; i <= idx; i++) c += unlockedAt(GENESIS_BUCKETS[i], d);
      return X(d).toFixed(1) + "," + Y(c).toFixed(1);
    }).join(" ");
  }
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Genesis unlock curve">';
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>';
  // gridlines + labels
  var y;
  for (y = 0; y <= 5670000; y += 1890000){
    s += '<line x1="' + P.l + '" y1="' + Y(y).toFixed(1) + '" x2="' + (W - P.r) + '" y2="' + Y(y).toFixed(1) +
         '" stroke="rgba(157,184,172,.18)"/><text x="' + (P.l - 8) + '" y="' + (Y(y) + 4).toFixed(1) +
         '" text-anchor="end" font-size="11" fill="#6b8578">' + (y / 1e6).toFixed(1) + 'M</text>';
  }
  for (var yr = 2026; yr <= 2036; yr++){
    var dd = (Date.parse(yr + "-01-01T00:00:00Z") - CHAIN.TGE_MS) / CHAIN.DAY_MS;
    if (dd < 0 || dd > daysMax) continue;
    s += '<text x="' + X(dd).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="#6b8578">' + yr + '</text>';
  }
  // stacked unlocked areas (bottom-up)
  var prev = null, i;
  for (i = 0; i < GENESIS_BUCKETS.length; i++){
    var top = lineOf(i);
    var bot = prev ? prev : pts.map(function(d){ return X(d).toFixed(1) + "," + Y(0).toFixed(1); }).join(" ");
    s += '<polygon points="' + top + ' ' + bot.split(" ").reverse().join(" ") +
         '" fill="' + GENESIS_BUCKETS[i].color + '" opacity="0.55" data-bucket="' + GENESIS_BUCKETS[i].id + '"/>';
    prev = top;
  }
  // locked remainder on top
  var totalTop = lineOf(GENESIS_BUCKETS.length - 1);
  var lockedBot = pts.map(function(d){ return X(d).toFixed(1) + "," + Y(CHAIN.GENESIS_MINT).toFixed(1); }).join(" ");
  s += '<polygon points="' + totalTop + ' ' + lockedBot.split(" ").reverse().join(" ") +
       '" fill="rgba(20,40,32,.9)" stroke="rgba(157,184,172,.35)" stroke-dasharray="5 4" data-bucket="locked"/>';
  s += "</svg>";
  return s;
}

function emitChartSVG(years){
  var W = 900, H = 340, P = { l: 64, r: 16, t: 14, b: 30 };
  var iw = W - P.l - P.r, ih = H - P.t - P.b;
  var X = function(y){ return P.l + iw * y / years; };
  var Y = function(v){ return P.t + ih * (1 - v / CHAIN.MAX_SUPPLY); };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Supply trajectory">';
  var y, i, N = 160, pts = [];
  for (i = 0; i <= N; i++){
    var days = i / N * years * 365.25;
    pts.push(X(days / 365.25).toFixed(1) + "," + Y(supplyAtBlocks(days * CHAIN.BLOCKS_PER_DAY)).toFixed(1));
  }
  s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#5eead4" stroke-width="2.5"/>';
  var ms = [10000000, 15000000, 20000000];
  for (i = 0; i < ms.length; i++){
    var dd = milestoneDay(ms[i]);
    var x = X(dd / 365.25), yy = Y(supplyAtBlocks(dd * CHAIN.BLOCKS_PER_DAY));
    s += '<circle cx="' + x.toFixed(1) + '" cy="' + yy.toFixed(1) + '" r="5" fill="#f0c060" data-milestone="' + ms[i] + '"/>';
    s += '<text x="' + (x + 9).toFixed(1) + '" y="' + (yy - 8).toFixed(1) + '" font-size="11" fill="#f0c060">' +
         (ms[i] / 1e6) + 'M · ' + fmtDate(CHAIN.TGE_MS + dd * CHAIN.DAY_MS) + '</text>';
  }
  for (y = 0; y <= years; y += Math.max(5, Math.round(years / 6))){
    s += '<text x="' + X(y).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="#6b8578">' + (2026 + y) + '</text>';
  }
  for (var sv = 0; sv <= 21000000; sv += 7000000){
    s += '<text x="' + (P.l - 8) + '" y="' + (Y(sv) + 4).toFixed(1) +
         '" text-anchor="end" font-size="11" fill="#6b8578">' + (sv / 1e6) + 'M</text>';
  }
  s += '<line x1="' + P.l + '" y1="' + Y(CHAIN.MAX_SUPPLY).toFixed(1) + '" x2="' + (W - P.r) + '" y2="' + Y(CHAIN.MAX_SUPPLY).toFixed(1) +
       '" stroke="rgba(240,192,96,.4)" stroke-dasharray="6 4"/>';
  s += '<text x="' + (W - P.r) + '" y="' + (Y(CHAIN.MAX_SUPPLY) - 6).toFixed(1) +
       '" text-anchor="end" font-size="11" fill="#f0c060">21M cap</text>';
  s += "</svg>";
  return s;
}

var API = { CHAIN: CHAIN, GENESIS_BUCKETS: GENESIS_BUCKETS, MINER_BUCKET: MINER_BUCKET,
  FUNDING: FUNDING, fmtInt: fmtInt, fmtQTC: fmtQTC, fmtDate: fmtDate,
  daysSinceTGE: daysSinceTGE, unlockedAt: unlockedAt, genesisUnlocked: genesisUnlocked,
  supplyAtBlocks: supplyAtBlocks, blockRewardAtBlocks: blockRewardAtBlocks,
  rewardAtDays: rewardAtDays, milestoneDay: milestoneDay,
  wormholeFee: wormholeFee, hsFee: hsFee, q2qtc: q2qtc,
  qtcToPlancksExact: qtcToPlancksExact, fmtPlancksExact: fmtPlancksExact, fmtQuanta: fmtQuanta,
  vestChartSVG: vestChartSVG, emitChartSVG: emitChartSVG };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- DOM wiring (browser only) ---------------- */

if (typeof document === "undefined") return;

function $(id){ return document.getElementById(id); }

/* Planck-dust canvas: slow-falling mint/gold squares. */
(function(){
  var c = $("dust"); if (!c) return;
  var x = c.getContext("2d"), ps = [];
  function size(){
    c.width = innerWidth; c.height = innerHeight; ps = [];
    var n = Math.floor(innerWidth / 34);
    for (var i = 0; i < n; i++) ps.push({
      x: Math.random() * c.width, y: Math.random() * c.height,
      s: 1 + Math.random() * 2.4, v: .18 + Math.random() * .5,
      mint: Math.random() < .72, o: .12 + Math.random() * .3
    });
  }
  size(); addEventListener("resize", size);
  var REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function tick(){
    x.clearRect(0, 0, c.width, c.height);
    for (var i = 0; i < ps.length; i++){ var p = ps[i];
      x.fillStyle = p.mint ? "rgba(94,234,212," + p.o + ")" : "rgba(240,192,96," + p.o + ")";
      x.fillRect(p.x, p.y, p.s, p.s);
      p.y += p.v; if (p.y > c.height + 6){ p.y = -6; p.x = Math.random() * c.width; }
    }
    if (!REDUCE_MOTION) requestAnimationFrame(tick);
  })();
})();

/* Allocation cards + stacked bar. */
(function(){
  var grid = $("allocGrid"), bar = $("allocBar"), legend = $("allocLegend");
  var all = GENESIS_BUCKETS.concat([MINER_BUCKET]);
  var gh = "";
  all.forEach(function(b){
    var pct = (b.amount / CHAIN.MAX_SUPPLY * 100);
    gh += '<div class="alloc-card' + (b.id === "liquidity" || b.id === "treasury" ? " gold" : "") + '">' +
      '<h3>' + b.name + '</h3><div class="amt">' + fmtInt(b.amount) + ' QTC</div>' +
      '<div class="shr">' + pct.toFixed(2) + '% of max supply</div>' +
      '<p class="term">' + b.term + '</p></div>';
  });
  grid.innerHTML = gh;
  bar.innerHTML = all.map(function(b){
    return '<span style="width:' + (b.amount / CHAIN.MAX_SUPPLY * 100).toFixed(3) +
           '%;background:' + b.color + '" title="' + b.name + '"></span>';
  }).join("");
  legend.innerHTML = all.map(function(b){
    return '<span><i style="background:' + b.color + '"></i>' + b.name + '</span>';
  }).join("");
})();

/* Vesting clock. */
var SLIDER_MAX = 1460;
function renderClock(days){
  days = Math.max(0, Math.min(SLIDER_MAX, days));
  var atMs = CHAIN.TGE_MS + days * CHAIN.DAY_MS;
  $("clockDate").textContent = fmtDate(atMs);
  var unlocked = genesisUnlocked(days);
  $("clockPct").textContent = fmtInt(unlocked) + " / 5,670,000 unlocked (" +
    (unlocked / CHAIN.GENESIS_MINT * 100).toFixed(2) + "%)";
  var gh = "";
  GENESIS_BUCKETS.forEach(function(b){
    var u = unlockedAt(b, days), p = u / b.amount * 100;
    gh += '<div class="clock-cell"><div class="n">' + b.name + '</div>' +
      '<div class="u">' + fmtInt(u) + ' <span style="font-size:.85rem;color:var(--faint)">/ ' +
      fmtInt(b.amount) + '</span></div>' +
      '<div class="p">' + p.toFixed(1) + '% unlocked</div>' +
      '<div class="ubar"><i style="width:' + p.toFixed(1) + '%"></i></div></div>';
  });
  $("clockGrid").innerHTML = gh;
}
$("dateSlider").addEventListener("input", function(e){ renderClock(parseFloat(e.target.value)); });
(function initClock(){
  renderClock(daysSinceTGE(Date.now()));
  $("dateSlider").value = Math.round(Math.max(0, Math.min(SLIDER_MAX, daysSinceTGE(Date.now()))));
  $("vestChart").innerHTML = vestChartSVG(3650, 10);
  var ms = [
    { t: "Liquidity fully unlocked", d: 16, note: "210,000 QTC" },
    { t: "Intents grant fully vested", d: 365, note: "42,000 QTC" },
    { t: "Grant cliff ends", d: 365, note: "5.42M QTC start linear unlock" },
    { t: "All genesis schedules complete", d: 1460, note: "~Sept 2030" }
  ];
  $("vestMilestones").innerHTML = ms.map(function(m){
    return '<div class="ms"><b>' + m.t + '</b><div class="d">' + fmtDate(CHAIN.TGE_MS + m.d * CHAIN.DAY_MS) +
           ' · day ' + m.d + ' · ' + m.note + '</div></div>';
  }).join("");
})();

/* Emission section. */
(function(){
  $("emitChart").innerHTML = emitChartSVG(30);
  var rows = [10000000, 15000000, 20000000];
  var rh = rows.map(function(t){
    var d = milestoneDay(t);
    return '<div class="mrow"><span>' + fmtInt(t) + ' QTC supply</span>' +
      '<span class="mv">' + fmtDate(CHAIN.TGE_MS + d * CHAIN.DAY_MS) + '</span></div>';
  }).join("");
  var halfDays = Math.log(2) * CHAIN.EMISSION_DIVISOR / CHAIN.BLOCKS_PER_DAY;
  rh += '<div class="mrow"><span>Reward halves (~0.153 QTC)</span><span class="mv">' +
    fmtDate(CHAIN.TGE_MS + halfDays * CHAIN.DAY_MS) + ' · ~' + (halfDays / 365.25).toFixed(1) + ' yrs</span></div>';
  $("milestoneTable").innerHTML = rh;
  function yrUpdate(){
    var yr = parseInt($("yrInput").value, 10);
    if (!isFinite(yr) || yr < 2026 || yr > 2200){ $("yrOut").textContent = "Enter a year 2026–2200."; return; }
    var days = (Date.parse(yr + "-01-01T00:00:00Z") - CHAIN.TGE_MS) / CHAIN.DAY_MS;
    var sup = supplyAtBlocks(Math.max(0, days) * CHAIN.BLOCKS_PER_DAY);
    var rw = rewardAtDays(days);
    $("yrOut").innerHTML = '<span class="big">' + fmtInt(sup) + ' QTC</span>' +
      'modeled supply on Jan 1, ' + yr + '<br>block reward ≈ <b style="color:var(--mint)">' +
      rw.toFixed(4) + ' QTC</b> · ' + fmtInt(rw * CHAIN.BLOCKS_PER_DAY) + ' QTC/day to miners';
  }
  $("yrInput").addEventListener("input", yrUpdate); yrUpdate();
})();

/* Fee calculators. */
function renderFee(){
  var f = wormholeFee($("exitInput").value);
  if (f.amountPlancks <= 0n){ $("feeOut").innerHTML = "Enter an exit volume."; $("feeBar").innerHTML = ""; return; }
  var rows = [
    ["Exit volume", fmtPlancksExact(f.amountPlancks) + " QTC", ""],
    ["Fee (4 bps, ceil to quanta)", fmtQuanta(f.feeQuanta) + " QTC", "hl"],
    ["Burned", fmtQuanta(f.burnQuanta) + " QTC", ""],
    ["To miner", fmtQuanta(f.minerQuanta) + " QTC", ""],
    ["To aggregator (public batch)", fmtQuanta(f.aggQuanta) + " QTC", ""]
  ];
  $("feeOut").innerHTML = rows.map(function(r){
    return '<div class="frow' + (r[2] ? " " + r[2] : "") + '"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>';
  }).join("");
  var tot = f.feeQuanta > 0n ? f.feeQuanta : 1n;
  var pct = function(q){ return (Number(q * 10000n / tot) / 100).toString(); };
  $("feeBar").innerHTML =
    '<span style="width:' + pct(f.burnQuanta) + '%;background:#e8a94a" title="burned"></span>' +
    '<span style="width:' + pct(f.minerQuanta) + '%;background:#5eead4" title="miner"></span>' +
    '<span style="width:' + pct(f.aggQuanta) + '%;background:#7fd6c0" title="aggregator"></span>';
}
function renderHs(){
  var f = hsFee($("hsInput").value);
  if (f.amountPlancks <= 0n){ $("hsOut").innerHTML = "Enter a transfer volume."; return; }
  $("hsOut").innerHTML =
    '<div class="frow"><span>Volume</span><b>' + fmtPlancksExact(f.amountPlancks) + ' QTC</b></div>' +
    '<div class="frow hl"><span>Burned (1%)</span><b>' + fmtPlancksExact(f.feePlancks) + ' QTC</b></div>' +
    '<div class="frow"><span>Recipient receives</span><b>' + fmtPlancksExact(f.netPlancks) + ' QTC</b></div>';
}
$("exitInput").addEventListener("input", renderFee); renderFee();
$("hsInput").addEventListener("input", renderHs); renderHs();

/* Funding. */
(function(){
  var gh = '<div class="fund-row head"><span>Round</span><span>Raised</span><span>Valuations</span><span>Lead</span></div>';
  FUNDING.forEach(function(r){
    gh += '<div class="fund-row"><span><b>' + r.name + '</b></span>' +
      '<span class="fv">$' + (r.raised / 1e6).toFixed(2) + 'M</span>' +
      '<span>equity $' + (r.equity / 1e6).toFixed(0) + 'M · token $' + (r.token / 1e6).toFixed(0) + 'M</span>' +
      '<span class="lead">' + r.lead + '</span></div>';
  });
  $("fundTable").innerHTML = gh;
  var tot = FUNDING.reduce(function(a, r){ return a + r.raised; }, 0);
  $("fundImplied").innerHTML = 'Total raised: <b>$' + (tot / 1e6).toFixed(2) + 'M</b>. ' +
    'At the stated token valuations, 1 QTC implied ≈ <b>$' + (40000000 / CHAIN.MAX_SUPPLY).toFixed(2) +
    '</b> (round 1, $40M) and <b>$' + (100000000 / CHAIN.MAX_SUPPLY).toFixed(2) +
    '</b> (round 2, $100M) on a fully-diluted basis. The team took equity + token exposure; miners were not diluted by the raise — their 73% comes from emission, not the cap.';
})();

/* Live tiles: anchor the emission model to the real block height. */
(function(){
  function setTiles(height, live){
    var blocks = height > 0 ? height : Math.floor(daysSinceTGE(Date.now()) * CHAIN.BLOCKS_PER_DAY);
    var sup = supplyAtBlocks(blocks);
    var rw = blockRewardAtBlocks(blocks);
    var unl = genesisUnlocked(daysSinceTGE(Date.now()));
    $("ltHeight").textContent = height > 0 ? fmtInt(height) : "—";
    $("ltSupply").textContent = fmtInt(sup) + " QTC";
    $("ltUnlocked").textContent = fmtInt(unl) + " QTC";
    $("ltReward").textContent = rw.toFixed(4) + " QTC";
    $("ltHeightSrc").textContent = live ? "live · sqm.quantus.com" : "indexer unreachable — local model";
  }
  function local(){ setTiles(0, false); }
  try {
    function fromSnap(){
      return fetch("../../data/live.json?t=" + Math.floor(Date.now()/60000), { cache: "no-store", signal: (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(9000) : undefined })
        .then(function(r){ return r.json(); })
        .then(function(p){
          var h = p && p.data && p.data.status && p.data.status.block_height;
          if (h > 0){ setTiles(h, true); $("ltHeightSrc").textContent = "snapshot · sqm.quantus.com"; }
          else local();
        });
    }
    fetch("https://sqm.quantus.com/v1/graphql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: 'query { chain_stats_by_pk(id: "global") { block_height } }' }),
      signal: (typeof AbortSignal !== "undefined" && AbortSignal.timeout) ? AbortSignal.timeout(3500) : undefined
    }).then(function(r){ return r.json(); }).then(function(j){
      var h = j && j.data && j.data.chain_stats_by_pk && j.data.chain_stats_by_pk.block_height;
      if (h > 0) setTiles(h, true);
      else throw new Error("empty");
    }).catch(function(){ return fromSnap().catch(local); });
    setTimeout(function(){ if ($("ltHeight").textContent === "—") local(); }, 8000);
  } catch (e){ local(); }
})();

/* Donation copy. */
(function(){
  var copy = $("donateCopy"); if (!copy) return;
  copy.addEventListener("click", function(){
    var addr = copy.textContent.trim();
    function done(){ var t = copy.textContent; copy.textContent = "copied \u2713"; setTimeout(function(){ copy.textContent = t; }, 1600); }
    if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(addr).then(done, done); }
    else {
      var ta = document.createElement("textarea"); ta.value = addr;
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e){}
      document.body.removeChild(ta); done();
    }
  });
})();

})();
