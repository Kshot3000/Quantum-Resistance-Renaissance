/* QTC Energy Observatory — app.js
 * Live snapshot read → honest efficiency band → interactive labs.
 * Plain script (no modules). Fails loudly: if the snapshots are unreachable,
 * the page says so instead of inventing numbers.
 */
(function () {
"use strict";
var E = EnergyCore;

/* ---------- constants ---------- */
var FALLBACK = {
  difficulty: "526423768244737",
  height: 203005,
  // total supply in plancks (free + reserved + frozen), balances aggregate @ block
  // 203,005, fetched 2026-10-11 — the SAME capture as the difficulty above
  // (@ block 203,005, fetched 1 seconds apart; never mix snapshot dates in one bundle).
  // This is total_issuance for the emission formula, NOT mined rewards alone
  // (genesis endowments count toward issuance).
  totalSupplyPlancks: "5802268242575807651",
  fetchedAt: null,
  txRate: null,
  txRateSub: null,
};

var effMax = E.presetEfficiency(E.presetById("rtx4090-pr100")); // 2.337 MH/J (measured cap)
var effMin = E.presetEfficiency(E.presetById("rtx3060ti"));     // 0.340 MH/J (TDP)

var state = {
  difficulty: FALLBACK.difficulty,
  height: FALLBACK.height,
  netHs: E.hashrateHs(FALLBACK.difficulty),
  rewardQtc: E.blockRewardQtc(FALLBACK.totalSupplyPlancks),
  fetchedAt: null,
  snapshotOk: false,
  txRate: null,
  txRateSub: "",
  trend: [],
};

/* ---------- tiny dom ---------- */
function $(id) { return document.getElementById(id); }
function setText(id, s) { var el = $(id); if (el) el.textContent = s; }

/* ---------- data ---------- */

/* ---- snapshot-boundary validation (fleet-standard strict shapes: the
 * mining-studio / mining-calculator intField pattern, applied fleet-wide).
 * The fetch scripts emit integer strings for plancks/difficulty/hashrate
 * and integer numbers for heights/counts/timestamps — anything else
 * (scientific notation, fractions, markup) is not a measurement and must
 * not anchor a figure. Every helper is a total function: null, never a
 * throw, so one malformed field cannot kill its neighbours' figures. */
function intField(v) {
  if (typeof v === "string") {
    if (!/^\d+$/.test(v.trim())) return null;
    var n = Number(v.trim());
    return isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  return null;
}
function validPlancks(v) {
  if (typeof v === "string") return /^\d+$/.test(v.trim()) ? v.trim() : null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  return null;
}
function validHeight(v) {
  var h = intField(v);
  return (h != null && h >= 1 && h <= 10000000) ? h : null;
}
function validFetchedAt(v) {
  if (typeof v !== "string" || !v) return null;
  return isFinite(Date.parse(v)) ? v : null;
}

/* Total supply in plancks from a supply snapshot: the first-class
 * total_supply_plancks field when present (fetch-supply-data.mjs), else the
 * balances aggregate (free + reserved + frozen) = Currency::total_issuance().
 * The fetch script DEFINES the total as that aggregate, so when both are
 * present they must agree exactly: a total that contradicts its own
 * itemization is tamper/truncation evidence and neither side is trusted
 * (null). Null when neither is usable. Never throws on malformed balances. */
function totalSupplyOf(sup) {
  if (!sup) return null;
  var total = validPlancks(sup.total_supply_plancks);
  var b = sup.balances_plancks, sum = null;
  if (b) {
    var f = validPlancks(b.free), r = validPlancks(b.reserved), z = validPlancks(b.frozen);
    if (f != null && r != null && z != null) sum = BigInt(f) + BigInt(r) + BigInt(z);
  }
  if (total != null && sum != null && BigInt(total) !== sum) return null;
  if (total != null) return total;
  return sum != null ? sum.toString() : null;
}

/* Trend points [height, tsMs, difficulty] for the history chart: drop
 * poisoned points individually (a garbage timestamp otherwise buckets
 * into a "NaN-aN-aN" day and a scientific-notation difficulty inflates
 * that day's energy) instead of losing — or faking — the whole history. */
function cleanTrend(trend) {
  if (!Array.isArray(trend)) return [];
  var out = [];
  for (var i = 0; i < trend.length; i++) {
    var p = trend[i];
    if (!Array.isArray(p)) continue;
    var h = validHeight(p[0]);
    var ts = (typeof p[1] === "number" && Number.isInteger(p[1]) && p[1] > 0) ? p[1] : null;
    var d = validPlancks(p[2]);
    if (h == null || ts == null || d == null || BigInt(d) <= 0n) continue;
    out.push([h, ts, d]);
  }
  return out;
}

/* Derive the page's chain state from the three snapshots. Every payload
 * is validated at this boundary before it anchors a figure: strict
 * integer shapes, the fetch scripts' own exact cross-checks
 * (est_hashrate_hs == difficulty/12; total == free+reserved+frozen), the
 * 21M cap on total issuance, a parseable fetched_at as provenance for
 * anything called "live", and the one-capture rule (payloads more than
 * 100 blocks apart are different captures — never mixed). Fields that
 * fail validation stay null and the caller keeps the dated FALLBACK for
 * them; payloads fail independently, never together. */
function deriveSnapshotState(con, sup, liv) {
  var out = { difficulty: null, height: null, netHs: null, rewardQtc: null,
              fetchedAt: null, snapshotOk: false, txRate: null, txRateSub: null, trend: null };

  // Consensus: difficulty anchors every energy figure on the page, so
  // the payload anchors as a unit — strict difficulty, a valid height
  // (current.height and head are two reads of the same tip; a
  // disagreement is not one capture), parseable provenance, and the
  // exact difficulty cross-check when est_hashrate_hs is present.
  var consAt = validFetchedAt(con && con.fetched_at);
  var consHeight = null;
  if (con && consAt && con.current) {
    var diff = validPlancks(con.current.difficulty);
    var hh = validHeight(con.current.height), hd = validHeight(con.head);
    if (hh != null && hd != null && hh !== hd) hh = null;
    consHeight = hh;
    if (diff != null && con.current.est_hashrate_hs != null) {
      var eh = intField(con.current.est_hashrate_hs);
      if (eh == null || BigInt(eh) !== BigInt(diff) / 12n) diff = null;
    }
    if (diff != null && BigInt(diff) > 0n && hh != null) {
      out.difficulty = diff;
      out.height = hh;
      out.netHs = E.hashrateHs(diff);
      out.fetchedAt = consAt;
      out.snapshotOk = true;
      out.trend = cleanTrend(con.trend);
    }
  }

  // Supply: the emission reward, from a dated, cross-checked,
  // under-cap total in the same capture as the consensus payload.
  var supAt = validFetchedAt(sup && sup.fetched_at);
  if (sup && supAt) {
    var tp = totalSupplyOf(sup);
    // Total issuance can never exceed the 21M cap; beyond it the
    // emission formula would mint a negative reward out of a poison.
    if (tp != null && BigInt(tp) <= 21000000n * 1000000000000n) {
      var supHeight = validHeight(sup.block_height);
      if (!(consHeight != null && supHeight != null && Math.abs(supHeight - consHeight) > 100)) {
        out.rewardQtc = E.blockRewardQtc(tp);
        if (!out.fetchedAt) out.fetchedAt = supAt;
      }
    }
  }

  // Live: the per-transfer rate, from the first daily row that is a
  // measurement (strict integer counts, a real calendar date) in a
  // dated payload — poisoned rows drop, never anchor a NaN rate.
  var livAt = validFetchedAt(liv && liv.fetched_at);
  if (liv && livAt && liv.data && Array.isArray(liv.data.daily)) {
    for (var i = 0; i < liv.data.daily.length; i++) {
      var row = liv.data.daily[i];
      if (!row) continue;
      var tx = intField(row.tx_count), bc = intField(row.blocks_count);
      var date = (typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.date) &&
                  isFinite(Date.parse(row.date))) ? row.date : null;
      if (tx == null || tx < 0 || bc == null || bc <= 0 || date == null) continue;
      out.txRate = tx / (bc * 12);
      out.txRateSub = E.fmtNum(tx) + " transfers across " + E.fmtNum(bc) +
        " blocks · " + date.slice(0, 10);
      break;
    }
  }
  return out;
}

/* Abort a fetch that never settles: a hung request must fall through to
 * the app's error/fallback path, not strand the page on "Loading…" forever. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, ms);
  return ctl.signal;
}

function fetchJson(url) {
  // QA hook: qa-energy-browser.mjs injects real snapshot payloads before
  // navigation because file:// fetch is blocked in headless Chromium.
  var mock = typeof window !== "undefined" ? window.__qtcenergy_mock : null;
  if (mock) {
    for (var k in mock) {
      if (url.indexOf(k) >= 0) return Promise.resolve(mock[k]);
    }
  }
  return fetch(url, { cache: "no-store", signal: timeoutSignal(9000) }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

function loadSnapshots() {
  return Promise.allSettled([
    fetchJson("../../data/consensus.json"),
    fetchJson("../../data/supply.json"),
    fetchJson("../../data/live.json"),
  ]).then(function (res) {
    var con = res[0].status === "fulfilled" ? res[0].value : null;
    var sup = res[1].status === "fulfilled" ? res[1].value : null;
    var liv = res[2].status === "fulfilled" ? res[2].value : null;

    var d = deriveSnapshotState(con, sup, liv);
    if (d.snapshotOk) {
      state.difficulty = d.difficulty;
      state.height = d.height;
      state.netHs = d.netHs;
      state.trend = d.trend;
      state.snapshotOk = true;
    }
    if (d.rewardQtc != null) state.rewardQtc = d.rewardQtc;
    if (d.fetchedAt) state.fetchedAt = d.fetchedAt;
    if (d.txRate != null) {
      state.txRate = d.txRate;
      state.txRateSub = d.txRateSub;
    }
    return d;
  });
}

/* ---------- hero ---------- */
function renderHero() {
  var hs = state.netHs;
  var pLo = E.powerW(hs, effMax), pHi = E.powerW(hs, effMin); // watts: efficient→low W
  setText("pHash", E.fmtHashrate(hs));
  setText("pDiff", "difficulty " + E.fmtNum(Number(state.difficulty)) + " @ block " + E.fmtNum(state.height));
  setText("pPower", E.fmtPowerMW(pLo / 1e6) + " – " + E.fmtPowerMW(pHi / 1e6));
  setText("pAnnual", E.fmtKwh(E.annualMWh(pLo / 1e6) * 1e3) + " – " + E.fmtKwh(E.annualMWh(pHi / 1e6) * 1e3));
  setText("pBlock", E.fmtKwh(E.perBlockEnergyKWh(pLo)) + " – " + E.fmtKwh(E.perBlockEnergyKWh(pHi)));

  var pill = $("snapPill"), note = $("provenanceNote");
  if (state.snapshotOk && state.fetchedAt) {
    var age = Math.max(0, Math.round((Date.now() - new Date(state.fetchedAt).getTime()) / 3600000));
    pill.textContent = "snapshot " + age + "h old · block " + E.fmtNum(state.height);
    note.innerHTML = "Chain state from the builder's snapshots (<span class=\"mono\">data/consensus.json</span> + <span class=\"mono\">data/supply.json</span>, fetched <span class=\"mono\">" +
      new Date(state.fetchedAt).toISOString().replace("T", " ").slice(0, 19) + "Z</span>, block " + E.fmtNum(state.height) +
      "). Implied network hashrate <span class=\"mono\">" + E.fmtHashrate(hs) + "</span>; current block reward <span class=\"mono\">" +
      state.rewardQtc.toFixed(4) + " QTC</span> (emission model, exact to the planck).";
  } else {
    pill.textContent = "no snapshot — using fallback figures";
    pill.classList.add("warn");
    note.textContent = "The chain snapshots could not be loaded, so this page is showing fallback figures from the last verified capture (Oct 11, 2026) instead of inventing chain state.";
  }
}

/* ---------- band lab ---------- */
function bandDerived(eff) {
  var w = E.powerW(state.netHs, eff);
  var mw = w / 1e6;
  return { w: w, mw: mw, twh: E.annualTWh(mw), blockKwh: E.perBlockEnergyKWh(w) };
}
function renderBand() {
  var eff = parseFloat($("effSlider").value);
  if (!(eff > 0)) eff = 1.2;
  setText("effVal", eff.toFixed(2));
  var d = bandDerived(eff);
  var rate = parseFloat($("rateInput").value) || 0;
  var ci = parseFloat($("ciInput").value);
  if (!(ci >= 0)) ci = 0.42;
  setText("bPower", E.fmtPowerMW(d.mw));
  setText("bAnnual", E.fmtKwh(d.twh * 1e9));
  setText("bCost", E.fmtMoney(d.twh * 1e9 * rate) + "/yr");
  setText("bCo2", E.fmtNum(E.co2Tonnes(d.twh * 1e9, ci), 0) + " t/yr");
}
function renderEffPins() {
  var host = $("effPins");
  host.innerHTML = "";
  var pins = [
    { id: "rtx4090-pr100", label: "4090 @ 350 W" },
    { id: "rtx3080ti-pr100", label: "3080 Ti @ 330 W" },
    { id: "rtx5060ti", label: "5060 Ti (TDP)" },
    { id: "rtx3060ti", label: "3060 Ti (TDP)" },
  ];
  pins.forEach(function (p) {
    var pr = E.presetById(p.id);
    var b = document.createElement("button");
    b.className = "pin";
    b.type = "button";
    b.textContent = p.label + " · " + E.presetEfficiency(pr).toFixed(2) + " MH/J";
    b.title = pr.hashrateNote + " — " + pr.powerNote;
    b.addEventListener("click", function () {
      $("effSlider").value = Math.min(3.2, Math.max(0.2, E.presetEfficiency(pr)));
      renderBand();
    });
    host.appendChild(b);
  });
}

/* ---------- fleet mixer ---------- */
var fleetRowSeq = 0;
function addFleetRow(presetId, count) {
  var host = $("fleetRows");
  var row = document.createElement("div");
  row.className = "fleet-row";
  var sel = document.createElement("select");
  E.HARDWARE_PRESETS.forEach(function (p) {
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + " — " + p.hashrateMHs + " MH/s @ " + p.powerW + " W (" + E.presetEfficiency(p).toFixed(2) + " MH/J)";
    if (p.id === presetId) o.selected = true;
    sel.appendChild(o);
  });
  var n = document.createElement("input");
  n.type = "number"; n.min = "0"; n.max = "100000"; n.step = "1"; n.value = count == null ? 1 : count;
  n.className = "n"; n.setAttribute("aria-label", "GPU count");
  var eff = document.createElement("span");
  eff.className = "row-eff";
  var rm = document.createElement("button");
  rm.type = "button"; rm.className = "rm"; rm.textContent = "×"; rm.title = "Remove row";
  rm.addEventListener("click", function () { row.remove(); renderFleet(); });
  row.appendChild(sel); row.appendChild(n); row.appendChild(eff); row.appendChild(rm);
  host.appendChild(row);
  fleetRowSeq++;
  sel.addEventListener("change", renderFleet);
  n.addEventListener("input", renderFleet);
  return { sel: sel, n: n };
}
function fleetShares() {
  var rows = document.querySelectorAll("#fleetRows .fleet-row");
  var parts = [], totalHs = 0;
  rows.forEach(function (row) {
    var sel = row.querySelector("select"), n = row.querySelector("input");
    var p = E.presetById(sel.value);
    var c = Math.max(0, Math.floor(parseFloat(n.value) || 0));
    row.querySelector(".row-eff").textContent = p ? E.presetEfficiency(p).toFixed(2) + " MH/J" : "";
    if (!p || c <= 0) return;
    var hs = p.hashrateMHs * 1e6 * c;
    parts.push({ part: { id: p.id, mhPerJ: E.presetEfficiency(p) }, hs: hs, count: c });
    totalHs += hs;
  });
  var mix = parts.map(function (x) {
    return { share: totalHs > 0 ? x.hs / totalHs : 0, mhPerJ: x.part.mhPerJ };
  });
  return { mix: mix, totalHs: totalHs, gpus: parts.reduce(function (a, x) { return a + x.count; }, 0) };
}
function renderFleet() {
  var s = fleetShares();
  if (!s.mix.length || !(s.totalHs > 0)) {
    setText("fEff", "—"); setText("fSize", "—"); setText("fPower", "—"); setText("fAnnual", "—");
    return;
  }
  var eff = E.mixEfficiency(s.mix);
  var mw = E.powerMW(state.netHs, eff);
  setText("fEff", eff.toFixed(2) + " MH/J");
  setText("fSize", E.fmtNum(s.gpus) + " GPUs · " + E.fmtHashrate(s.totalHs));
  setText("fPower", E.fmtPowerMW(mw));
  setText("fAnnual", E.fmtKwh(E.annualTWh(mw) * 1e9));
}
function setFleetScenario(presetId, count) {
  $("fleetRows").innerHTML = "";
  addFleetRow(presetId, count);
  renderFleet();
}

/* ---------- bench table ---------- */
function renderBench() {
  var tb = document.querySelector("#benchTable tbody");
  tb.innerHTML = "";
  var rows = E.HARDWARE_PRESETS.slice().sort(function (a, b) {
    return E.presetEfficiency(b) - E.presetEfficiency(a);
  });
  rows.forEach(function (p) {
    var tr = document.createElement("tr");
    // measured = measured nvidia-smi cap; the "NOT a measured cap" TDP notes
    // contain the word "measured" too, so exclude them explicitly.
    var measured = /measured/i.test(p.powerNote) && !/NOT a measured/i.test(p.powerNote);
    var badge = measured ? '<span class="badge meas">measured cap</span>' : '<span class="badge tdp">board TDP</span>';
    tr.innerHTML =
      '<td><span class="mono">' + esc(p.name) + '</span><small>' + esc(p.engine) + '</small></td>' +
      '<td>' + esc(p.id.indexOf("wgsl") >= 0 ? "WGSL" : "CUDA") + '</td>' +
      '<td><span class="mono">' + p.hashrateMHs.toFixed(2) + ' MH/s</span><small>' + esc(p.hashrateNote) + '</small></td>' +
      '<td><span class="mono">' + p.powerW + ' W</span><br>' + badge + '<small>' + esc(p.powerNote) + '</small></td>' +
      '<td><span class="mono">' + E.presetEfficiency(p).toFixed(2) + ' MH/J</span></td>' +
      '<td class="mono">' + esc(p.date) + '</td>' +
      '<td><a class="src-link" href="' + esc(p.sourceUrl) + '" target="_blank" rel="noopener">' + esc(p.source.split("/").pop()) + '</a><small>' + esc(p.conditions) + '</small></td>';
    tb.appendChild(tr);
  });
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- rig builder ---------- */
function renderRigPresets() {
  var sel = $("rigPreset");
  sel.innerHTML = "";
  E.HARDWARE_PRESETS.forEach(function (p) {
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + " — " + p.hashrateMHs + " MH/s @ " + p.powerW + " W";
    sel.appendChild(o);
  });
  sel.value = "rtx4090-pr100";
}
function renderRig() {
  var p = E.presetById($("rigPreset").value);
  var count = Math.max(1, Math.floor(parseFloat($("rigCount").value) || 1));
  var rate = parseFloat($("rigRate").value) || 0;
  if (!p) return;
  var rigHs = p.hashrateMHs * 1e6 * count;
  var qtcDay = E.rigExpectedQtcPerDay(rigHs, state.netHs, state.rewardQtc);
  var kwh = E.dailyKwh(p.powerW * count);
  var cost = E.electricityCostUsd(kwh, rate);
  setText("rHs", E.fmtHashrate(rigHs));
  setText("rQtc", qtcDay >= 0.01 ? qtcDay.toFixed(3) : qtcDay.toFixed(5));
  setText("rQtcSub", "share of network " + (100 * rigHs / state.netHs).toFixed(6) + "% · reward " + state.rewardQtc.toFixed(4) + " QTC/block");
  setText("rKwh", kwh.toFixed(1) + " kWh/day");
  setText("rCost", E.fmtMoney(cost) + "/day");
  setText("rBe", qtcDay > 0 ? "$" + (cost / qtcDay).toFixed(2) : "—");
}

/* ---------- canvas helpers ---------- */
function fitCanvas(cv, heightCss) {
  var dpr = window.devicePixelRatio || 1;
  var w = cv.clientWidth || cv.parentElement.clientWidth || 800;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(heightCss * dpr);
  var ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: heightCss };
}
function theme() {
  return { grn: "#7df09a", lime: "#c8f04b", amber: "#ffb454", dim: "#a9bda4", faint: "#6f8569", line: "#223324" };
}

/* ---------- history chart (log-scale band) ---------- */
function renderHistory() {
  var cv = $("histChart");
  if (!state.trend.length) {
    $("histNote").textContent = "No trend data in the snapshot — the history chart needs data/consensus.json.";
    return;
  }
  var hi = E.dailyEnergyHistory(state.trend, effMax); // efficient bound → lower energy
  var lo = E.dailyEnergyHistory(state.trend, effMin); // conservative bound → higher energy
  var days = lo.map(function (d, i) { return { date: d.date, loMwh: hi[i] ? hi[i].mwh : 0, hiMwh: d.mwh }; });
  var maxV = 0;
  days.forEach(function (d) { if (d.hiMwh > maxV) maxV = d.hiMwh; });
  var H = 240, pad = { l: 64, r: 16, t: 14, b: 30 };
  var g = fitCanvas(cv, H), ctx = g.ctx, T = theme();
  var W = g.w - pad.l - pad.r, Hh = H - pad.t - pad.b;
  var logMin = Math.log10(Math.max(1e-6, days[0].loMwh)), logMax = Math.log10(maxV * 1.15);
  function x(i) { return pad.l + (W * i) / Math.max(1, days.length - 1); }
  function y(v) { return pad.t + Hh * (1 - (Math.log10(Math.max(1e-6, v)) - logMin) / (logMax - logMin)); }

  ctx.strokeStyle = T.line; ctx.lineWidth = 1;
  ctx.fillStyle = T.faint; ctx.font = "11px JetBrains Mono, monospace";
  var ticks = ["kWh", "MWh", "GWh"];
  var tickVals = [1 / 1e3, 1, 1e3]; // MWh units
  tickVals.forEach(function (v, i) {
    if (v <= 0 || Math.log10(v) < logMin - 0.2 || Math.log10(v) > logMax + 0.2) return;
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(g.w - pad.r, y(v)); ctx.stroke();
    ctx.fillText(ticks[i], 8, y(v) + 4);
  });

  // band fill
  ctx.beginPath();
  days.forEach(function (d, i) { var px = x(i), py = y(d.hiMwh); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  for (var i = days.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(days[i].loMwh));
  ctx.closePath();
  ctx.fillStyle = "rgba(125,240,154,0.12)";
  ctx.fill();
  // upper edge
  ctx.beginPath();
  days.forEach(function (d, j) { var px = x(j), py = y(d.hiMwh); j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.strokeStyle = T.amber; ctx.lineWidth = 1.6; ctx.stroke();
  // lower edge
  ctx.beginPath();
  days.forEach(function (d, j) { var px = x(j), py = y(d.loMwh); j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.strokeStyle = T.grn; ctx.lineWidth = 1.6; ctx.stroke();

  // date labels
  ctx.fillStyle = T.faint;
  var step = Math.ceil(days.length / 6);
  for (var k = 0; k < days.length; k += step) ctx.fillText(days[k].date.slice(5), x(k) - 12, H - 10);

  ctx.fillStyle = T.grn; ctx.fillText("— efficient bound (2.34 MH/J)", pad.l + 6, pad.t + 14);
  ctx.fillStyle = T.amber; ctx.fillText("— conservative bound (0.34 MH/J)", pad.l + 200, pad.t + 14);

  $("histNote").textContent = days.length + " days from " + days[0].date + " to " + days[days.length - 1].date +
    " · log scale · latest day: " + E.fmtKwh(days[days.length - 1].loMwh * 1e3) + " – " + E.fmtKwh(days[days.length - 1].hiMwh * 1e3) + ".";
}

/* ---------- per-transfer chart (honest bands at both efficiency bounds) ---------- */
function renderPerTx() {
  var wEff = E.powerW(state.netHs, effMax); // efficient fleet → lower bound
  var wCons = E.powerW(state.netHs, effMin); // conservative fleet → upper bound
  var rate = state.txRate;
  var rows = [];
  if (rate && rate > 0) {
    rows.push({ label: "Per transfer, actual rate (" + rate.toFixed(3) + " tx/s) — efficient bound", v: E.perTxEnergyKWh(wEff, rate), color: theme().amber });
    rows.push({ label: "Per transfer, actual rate — conservative bound", v: E.perTxEnergyKWh(wCons, rate), color: theme().amber });
    setText("tRate", rate.toFixed(3) + " tx/s");
    setText("tRateSub", state.txRateSub || "");
    setText("tActual", E.fmtKwh(E.perTxEnergyKWh(wEff, rate)) + " – " + E.fmtKwh(E.perTxEnergyKWh(wCons, rate)));
    setText("tFactor", E.fmtNum(430 / rate, 0) + "×");
  } else {
    setText("tActual", "—");
    setText("tRateSub", "no transfer-rate data");
  }
  rows.push({ label: "Per transfer at 430 QTPS design — efficient bound", v: E.perTxEnergyKWh(wEff, 430), color: theme().grn });
  rows.push({ label: "Per transfer at 430 QTPS design — conservative bound", v: E.perTxEnergyKWh(wCons, 430), color: theme().grn });
  setText("tDesign", E.fmtKwh(E.perTxEnergyKWh(wEff, 430)) + " – " + E.fmtKwh(E.perTxEnergyKWh(wCons, 430)));
  drawLogBars($("txChart"), rows, "kWh");
}

/* ---------- generic log bar chart ---------- */
function drawLogBars(cv, rows, unit) {
  var H = rows.length * 64 + 52;
  var pad = { l: 16, r: 120, t: 14, b: 14 };
  var g = fitCanvas(cv, H), ctx = g.ctx, T = theme();
  cv.style.height = H + "px";
  var W = g.w - pad.l - pad.r;
  var maxV = 0;
  rows.forEach(function (r) { if (r.v > maxV) maxV = r.v; });
  var logMin = Math.floor(Math.log10(Math.max(1e-9, maxV)) ) - rows.length - 2;
  // anchor the scale at the smallest bar instead
  var minV = maxV;
  rows.forEach(function (r) { if (r.v < minV && r.v > 0) minV = r.v; });
  logMin = Math.log10(minV) - 0.6;
  var logMax = Math.log10(maxV * 1.25);
  function x(v) { return pad.l + W * (Math.log10(Math.max(1e-12, v)) - logMin) / (logMax - logMin); }

  ctx.font = "12px JetBrains Mono, monospace";
  rows.forEach(function (r, i) {
    var yy = pad.t + i * 64 + 8, bh = 26;
    ctx.fillStyle = T.dim;
    ctx.fillText(r.label, pad.l, yy - 6);
    var wdt = Math.max(2, x(r.v) - pad.l);
    var grad = ctx.createLinearGradient(pad.l, 0, pad.l + wdt, 0);
    grad.addColorStop(0, r.color + "33"); grad.addColorStop(1, r.color);
    ctx.fillStyle = grad;
    ctx.fillRect(pad.l, yy, wdt, bh);
    ctx.fillStyle = "#fff";
    ctx.fillText(fmtUnit(r.v, unit), pad.l + wdt + 10, yy + 18);
  });
  // scale ticks
  ctx.fillStyle = T.faint; ctx.font = "10px JetBrains Mono, monospace";
  for (var e = Math.ceil(logMin); e <= logMax; e++) {
    var tx = x(Math.pow(10, e));
    ctx.strokeStyle = T.line;
    ctx.beginPath(); ctx.moveTo(tx, pad.t); ctx.lineTo(tx, H - pad.b); ctx.stroke();
    ctx.fillText(fmtUnit(Math.pow(10, e), unit), tx - 20, H - 4);
  }
}
function fmtUnit(v, unit) {
  if (unit === "kWh") return E.fmtKwh(v);
  if (unit === "TWh") return v >= 1 ? v.toFixed(1) + " TWh" : (v * 1e3).toFixed(0) + " GWh";
  return String(v);
}

/* ---------- comparisons ---------- */
function renderCompare() {
  var effMid = (effMax + effMin) / 2;
  var qtLo = E.annualTWh(E.powerMW(state.netHs, effMax));
  var qtHi = E.annualTWh(E.powerMW(state.netHs, effMin));
  var X = E.EXTERNAL;
  var rows = [
    { label: "Quantus network (conservative bound)", v: qtHi, color: "#ffb454" },
    { label: "Bitcoin — Digiconomist, Sep 2026", v: X.bitcoin_annual_twh_digiconomist.value, color: "#f47171" },
    { label: "Bitcoin — Cambridge CCAF, Sep 2026", v: X.bitcoin_annual_twh_ccaf.value, color: "#f47171" },
    { label: "Global data centers, 2024 (IEA)", v: X.global_datacenters_twh_2024.value, color: "#7dd3fc" },
    { label: "Quantus network (efficient bound)", v: qtLo, color: "#7df09a" },
    { label: "Ethereum post-merge (upper bound)", v: X.ethereum_annual_twh_upper.value, color: "#a78bfa" },
  ];
  drawLogBars($("cmpChart"), rows, "TWh");
  var host = $("srcTable");
  host.innerHTML = "";
  [
    X.bitcoin_annual_twh_ccaf, X.bitcoin_annual_twh_digiconomist,
    X.bitcoin_sustainable_share_pct, X.ethereum_annual_twh_upper,
    X.global_datacenters_twh_2024, X.us_home_kwh_2022,
  ].forEach(function (ex) {
    var d = document.createElement("div");
    d.className = "src-row";
    d.innerHTML = '<span class="lab">' + esc(ex.label) + '</span>' +
      '<span class="val">' + ex.value + " " + esc(ex.unit) + "</span>" +
      '<p><a href="' + esc(ex.sourceUrl) + '" target="_blank" rel="noopener">' + esc(ex.source) + "</a> · " + esc(ex.date) + ". " + esc(ex.note) + "</p>";
    host.appendChild(d);
  });
  var btcTwh = X.bitcoin_annual_twh_ccaf.value;
  setText("cVsBtc", (100 * (qtLo + qtHi) / 2 / btcTwh).toFixed(2) + "%");
}

/* ---------- carbon desk ---------- */
function renderCarbon() {
  var ci = parseFloat($("cCiInput").value);
  if (!(ci >= 0)) ci = 0.42;
  var effMid = (effMax + effMin) / 2;
  var qtLo = E.annualTWh(E.powerMW(state.netHs, effMax));
  var qtHi = E.annualTWh(E.powerMW(state.netHs, effMin));
  var tLo = E.co2Tonnes(qtLo * 1e9, ci), tHi = E.co2Tonnes(qtHi * 1e9, ci);
  setText("cTonne", E.fmtNum(tLo, 0) + " – " + E.fmtNum(tHi, 0) + " t/yr");
  var homes = ((qtLo + qtHi) / 2 * 1e9) / E.EXTERNAL.us_home_kwh_2022.value;
  setText("cHomes", E.fmtNum(Math.round(homes)));
}

/* ---------- events ---------- */
function wire() {
  $("effSlider").addEventListener("input", renderBand);
  $("rateInput").addEventListener("input", renderBand);
  $("ciInput").addEventListener("input", renderBand);
  $("fleetAdd").addEventListener("click", function () { addFleetRow("rtx4090-pr100", 1); renderFleet(); });
  $("fleetAll4090").addEventListener("click", function () { setFleetScenario("rtx4090-pr100", 1); });
  $("fleetAll3060").addEventListener("click", function () { setFleetScenario("rtx3060ti", 1); });
  $("rigPreset").addEventListener("change", renderRig);
  $("rigCount").addEventListener("input", renderRig);
  $("rigRate").addEventListener("input", renderRig);
  $("cCiInput").addEventListener("input", renderCarbon);
  var rt;
  window.addEventListener("resize", function () {
    clearTimeout(rt);
    rt = setTimeout(function () { renderHistory(); renderPerTx(); renderCompare(); }, 250);
  });
}

/* ---------- boot ---------- */
function boot() {
  renderEffPins();
  renderBench();
  renderRigPresets();
  wire();
  setFleetScenario("rtx4090-pr100", 2);
  addFleetRow("rtx3060ti", 3);
  renderFleet();
  loadSnapshots().catch(function () { /* fallbacks already in place */ }).then(function () {
    renderHero();
    renderBand();
    renderFleet();
    renderRig();
    renderHistory();
    renderPerTx();
    renderCompare();
    renderCarbon();
  });
  // paint immediately with fallbacks so the page is never blank
  renderHero();
  renderBand();
  renderRig();
  renderCarbon();
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}

/* Node test hook */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { deriveSnapshotState: deriveSnapshotState, totalSupplyOf: totalSupplyOf,
                     cleanTrend: cleanTrend, intField: intField, validPlancks: validPlancks,
                     validHeight: validHeight, validFetchedAt: validFetchedAt, FALLBACK: FALLBACK };
}
})();
