/* QTC Exposure Lab — UI layer: audit orchestration, chain-data clients, rendering.
 * Pure analysis lives in js/exposure-core.js (window.ExposureCore).
 * Chain data: mempool.space (BTC), BlockCypher w/ Blockscout fallback (ETH),
 * CoinGecko simple/price (USD). Everything degrades to an honest "unknown"
 * verdict when a lookup fails — never a guessed verdict.
 */
(function(){
"use strict";
var C = window.ExposureCore;
var $ = function(id){ return document.getElementById(id); };

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
function fmtUsd(n){ return usdFmt.format(n || 0); }
function shortAddr(a){
  a = String(a);
  return a.length > 26 ? a.slice(0, 12) + "…" + a.slice(-8) : a;
}

/* ---------------- chain-data clients ---------------- */
async function fetchJSON(url, timeoutMs){
  var ctrl = new AbortController();
  var to = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 15000);
  try {
    var r = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

/* BTC via mempool.space. Returns normalized api object or {offline:true}. */
async function fetchBTC(addr, validation){
  try {
    var info = await fetchJSON("https://mempool.space/api/address/" + encodeURIComponent(addr));
    if (!info || typeof info !== "object" || Array.isArray(info))
      return { offline: true, error: "malformed mempool.space answer" };
    // Identity (round 2): the answer must be FOR the address asked — a
    // response naming any other address anchors nothing here.
    if (typeof info.address !== "string" || info.address !== addr)
      return { offline: true, error: "mempool.space answer for a different address" };
    var cs = info.chain_stats || {}, ms = info.mempool_stats || {};
    if (typeof cs !== "object" || Array.isArray(cs) || typeof ms !== "object" || Array.isArray(ms))
      return { offline: true, error: "malformed mempool.space stats" };
    // Every stat crosses the boundary validated BEFORE any arithmetic:
    // a string count must never string-concatenate ("3"+"2" = "32"), and
    // a fractional/negative/object stat makes the whole answer
    // malformed — read as offline (honest unknown), never as fact.
    var stat = function(obj, key){
      var val = obj[key];
      if (val === undefined || val === null) return 0;
      return C.nonNegInt(val);
    };
    var fields = ["spent_txo_count", "funded_txo_count", "tx_count", "funded_txo_sum", "spent_txo_sum"];
    for (var fi = 0; fi < fields.length; fi++){
      if (stat(cs, fields[fi]) === null || stat(ms, fields[fi]) === null)
        return { offline: true, error: "malformed mempool.space stat: " + fields[fi] };
    }
    var api = {
      spent_txo_count: stat(cs, "spent_txo_count") + stat(ms, "spent_txo_count"),
      funded_txo_count: stat(cs, "funded_txo_count") + stat(ms, "funded_txo_count"),
      tx_count: stat(cs, "tx_count") + stat(ms, "tx_count"),
      // A balance cannot be negative on-chain; a negative here is a
      // mempool double-count artifact — floor at 0 (verdict rides on
      // the counts above, not on this figure).
      balance_sats: Math.max(0,
        (stat(cs, "funded_txo_sum") - stat(cs, "spent_txo_sum")) +
        (stat(ms, "funded_txo_sum") - stat(ms, "spent_txo_sum"))),
      p2pk_observed: false, p2tr_funded: validation && validation.detail === "taproot-key-in-output"
    };
    // Scan the first page of history (25 txs) for P2PK / P2TR outputs paying this
    // address — those embed the public key without any spend. Honest limit:
    // deeper history is not scanned; the spent-output signal covers the rest.
    try {
      var txs = await fetchJSON("https://mempool.space/api/address/" + encodeURIComponent(addr) + "/txs");
      if (Array.isArray(txs)){
        for (var i = 0; i < txs.length; i++){
          if (!txs[i] || typeof txs[i] !== "object") continue;
          var vouts = Array.isArray(txs[i].vout) ? txs[i].vout : [];
          for (var j = 0; j < vouts.length; j++){
            var vo = vouts[j];
            if (!vo || typeof vo !== "object") continue;
            if (vo.scriptpubkey_address !== addr) continue;
            var t = String(vo.scriptpubkey_type || "").toLowerCase();
            if (t === "p2pk") api.p2pk_observed = true;
            if (t.indexOf("p2tr") >= 0) api.p2tr_funded = true;
          }
        }
      }
      api.scanned_note = "First page of history scanned for key-revealing output types.";
    } catch (e){ api.scanned_note = "Output-type scan unavailable; verdict rests on spent-output counts."; }
    return api;
  } catch (e){ return { offline: true, error: String(e && e.message || e) }; }
}

/* ETH via BlockCypher, Blockscout v2 as fallback. */
async function fetchETH(addr){
  try {
    var b = await fetchJSON("https://api.blockcypher.com/v1/eth/main/addrs/" + encodeURIComponent(addr));
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("malformed BlockCypher answer");
    if (typeof b.address !== "string" || b.address.toLowerCase() !== addr.toLowerCase())
      throw new Error("BlockCypher answer for a different address");
    // Validate before normalizing: a garbage wei total or count must
    // not be String()-coerced into the analysis ("[object Object] wei"
    // was rendered as evidence pre-fix). Malformed primary data falls
    // through to the Blockscout fallback like any other failure.
    var clean = C.sanitizeEthApi({
      n_tx: (b.n_tx === undefined || b.n_tx === null) ? 0 : b.n_tx,
      total_sent_wei: b.total_sent,
      total_received_wei: b.total_received,
      balance_wei: b.final_balance !== undefined ? b.final_balance : b.balance
    });
    if (!clean) throw new Error("malformed BlockCypher payload");
    clean.source = "blockcypher";
    return clean;
  } catch (e1){
    try {
      var a = await fetchJSON("https://eth.blockscout.com/api/v2/addresses/" + encodeURIComponent(addr));
      var out = await fetchJSON("https://eth.blockscout.com/api/v2/addresses/" +
                                encodeURIComponent(addr) + "/transactions?filter=from");
      if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("malformed Blockscout answer");
      if (typeof a.hash !== "string" || a.hash.toLowerCase() !== addr.toLowerCase())
        throw new Error("Blockscout answer for a different address");
      if (!out || typeof out !== "object" || !Array.isArray(out.items)) throw new Error("malformed Blockscout tx list");
      var bal = (a.coin_balance === undefined || a.coin_balance === null) ? "0" : C.validPlancks(a.coin_balance);
      if (bal === null) throw new Error("malformed Blockscout balance");
      // A listed item proves a send only if its sender IS this address —
      // an unverifiable or foreign sender proves nothing (round 2).
      var sent = false;
      for (var ti = 0; ti < out.items.length; ti++){
        var fh = out.items[ti] && out.items[ti].from_address && out.items[ti].from_address.hash;
        if (typeof fh !== "string") throw new Error("malformed Blockscout tx item");
        if (fh.toLowerCase() === addr.toLowerCase()) sent = true;
      }
      return {
        n_tx: null,
        total_sent_wei: sent ? "1" : "0", // boolean signal only on the fallback path
        sent_signal: sent,
        total_received_wei: "0",
        balance_wei: bal,
        source: "blockscout",
        is_contract: a.is_contract === true,
        fallback_note: "BlockCypher unreachable — Blockscout fallback: sent/not-sent signal only, no totals."
      };
    } catch (e2){ return { offline: true, error: String(e2 && e2.message || e2) }; }
  }
}

var priceCache = null;
async function fetchPrices(){
  if (priceCache) return priceCache;
  try {
    var p = await fetchJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd", 12000);
    // A price anchors USD-at-risk figures: only a finite, positive
    // number counts — a string/object/negative price is no estimate.
    var price = function(x){
      var n = (x && typeof x.usd === "number") ? x.usd : NaN;
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    priceCache = { btc: price(p && p.bitcoin), eth: price(p && p.ethereum) };
  } catch (e){ priceCache = { btc: 0, eth: 0, offline: true }; }
  return priceCache;
}

/* ---------------- rendering ---------------- */
var VERDICT_META = {
  exposed: { cls: "v-exposed", label: "EXPOSED", icon: "☢" },
  latent:  { cls: "v-latent",  label: "LATENT",  icon: "⚠" },
  clean:   { cls: "v-clean",   label: "CLEAN",   icon: "○" },
  safe:    { cls: "v-safe",    label: "SAFE",    icon: "⬢" },
  unknown: { cls: "v-unknown", label: "UNKNOWN", icon: "?" },
  invalid: { cls: "v-invalid", label: "INVALID", icon: "✕" }
};
var CHAIN_META = {
  btc: "Bitcoin", eth: "Ethereum", qtc: "Quantus", substrate: "Substrate (other)", unknown: "Unknown"
};

function renderCard(entry){
  var m = VERDICT_META[entry.analysis.verdict] || VERDICT_META.unknown;
  var chainName = CHAIN_META[entry.v.chain] || entry.v.chain;
  var ev = entry.analysis.evidence.map(function(e){ return "<li>" + esc(e) + "</li>"; }).join("");
  var sampleBadge = entry.isSample ? '<span class="sample-badge">SAMPLE DATA</span>' : "";
  var usdLine = "";
  if (entry.usd > 0 && (entry.analysis.verdict === "exposed" || entry.analysis.verdict === "latent")){
    usdLine = '<div class="risk-line">≈ <strong>' + esc(fmtUsd(entry.usd)) + "</strong> at risk at current prices</div>";
  } else if (entry.priceOffline && (entry.analysis.verdict === "exposed" || entry.analysis.verdict === "latent")){
    usdLine = '<div class="risk-line dim">USD estimate unavailable (price feed offline)</div>';
  }
  return '<article class="result-card ' + m.cls + '">' +
    '<div class="rc-head"><span class="verdict-tag">' + m.icon + " " + m.label + "</span>" +
    '<span class="chain-tag">' + esc(chainName) + "</span>" + sampleBadge + "</div>" +
    '<div class="rc-addr" title="' + esc(entry.address) + '">' + esc(shortAddr(entry.address)) + "</div>" +
    (entry.label ? '<div class="rc-label">' + esc(entry.label) + "</div>" : "") +
    '<div class="rc-title">' + esc(entry.analysis.title) + "</div>" +
    '<ul class="rc-evidence">' + ev + "</ul>" + usdLine +
    (entry.analysis.recommendation
      ? '<div class="rc-rec"><span class="rc-rec-h">Recommended</span>' + esc(entry.analysis.recommendation) + "</div>"
      : "") +
    "</article>";
}

function renderSummary(sum){
  var el = $("summaryPanel");
  if (!sum || sum.n === 0){ el.innerHTML = ""; el.style.display = "none"; return; }
  el.style.display = "";
  var c = sum.counts;
  var scoreTxt = sum.score === null ? "—" : sum.score + "%";
  var scoreCls = sum.score === null ? "" : (sum.score >= 80 ? "good" : (sum.score >= 40 ? "mid" : "bad"));
  var deg = sum.score === null ? 0 : Math.round(sum.score * 3.6);
  el.innerHTML =
    '<div class="sum-grid">' +
      '<div class="sum-score"><div class="ring" style="--p:' + deg + 'deg"><span class="' + scoreCls + '">' + scoreTxt + '</span></div>' +
      '<div class="sum-cap">Q-Day readiness score<br><span>share of value not harvestable today</span></div></div>' +
      '<div class="sum-stats">' +
        '<div class="stat"><span class="n">' + sum.n + '</span><span class="l">addresses audited</span></div>' +
        '<div class="stat bad"><span class="n">' + c.exposed + '</span><span class="l">exposed</span></div>' +
        '<div class="stat mid"><span class="n">' + c.latent + '</span><span class="l">latent</span></div>' +
        '<div class="stat good"><span class="n">' + (c.safe + c.clean) + '</span><span class="l">safe / clean</span></div>' +
        '<div class="stat"><span class="n">' + esc(fmtUsd(sum.atRiskUsd)) + '</span><span class="l">value at risk' +
          (sum.priceOffline ? ' <em>(prices offline)</em>' : '') + '</span></div>' +
      "</div>" +
    "</div>" +
    (c.exposed + c.latent > 0
      ? '<p class="sum-warn">⚠ ' + (c.exposed + c.latent) + ' address(es) hold harvestable keys. Work the migration playbook below before Q-Day — not after.</p>'
      : '<p class="sum-ok">⬢ Nothing harvestable in this set. Keep it that way: never spend from cold addresses on ECDSA chains.</p>');
}

/* ---------------- audit orchestration ---------------- */
var running = false;
/* Audit generation token: Clear (or a newer audit) bumps it, and every
 * continuation of an older audit checks it before rendering — a superseded
 * audit discards its late results silently instead of resurrecting them
 * over state the user has already cleared. */
var auditSeq = 0;

function parseInput(text){
  var seen = {}, out = [];
  text.split(/[\s,;]+/).forEach(function(line){
    var a = line.trim();
    if (!a || seen[a]) return;
    seen[a] = 1; out.push(a);
  });
  return out;
}

function sampleByAddress(addr){
  for (var i = 0; i < C.SAMPLES.length; i++)
    if (C.SAMPLES[i].address === addr) return C.SAMPLES[i];
  return null;
}

async function runAudit(addresses, useSamples){
  if (running) return;
  running = true;
  var mySeq = ++auditSeq;
  var isCurrent = function(){ return mySeq === auditSeq; };
  var btn = $("runBtn");
  btn.classList.add("scanning"); btn.disabled = true;
  $("statusLine").textContent = "Validating " + addresses.length + " address(es)…";
  $("resultsGrid").innerHTML = "";
  renderSummary(null);

  try {
    var prices = await fetchPrices();
    if (!isCurrent()) return;
    var entries = [];

    // Validate everything first (fast, local), then fetch in small batches.
    var jobs = [];
    for (var i = 0; i < addresses.length; i++){
      var addr = addresses[i];
      var sample = useSamples ? sampleByAddress(addr) : null;
      var v = await C.detectChain(addr);
      if (!isCurrent()) return;
      jobs.push({ address: addr, v: v, sample: sample });
    }

    var BATCH = 4;
    for (var b = 0; b < jobs.length; b += BATCH){
      var slice = jobs.slice(b, b + BATCH);
      $("statusLine").textContent = "Scanning chain history… " + Math.min(b + BATCH, jobs.length) + "/" + jobs.length;
      var results = await Promise.all(slice.map(async function(job){
        var api = null;
        if (job.sample){ api = job.sample.api; }
        else if (job.v.ok && job.v.chain === "btc"){ api = await fetchBTC(job.address, job.v); }
        else if (job.v.ok && job.v.chain === "eth"){ api = await fetchETH(job.address); }
        var analysis = C.analyze(job.v, api);
        var usd = 0, priceOffline = !!prices.offline;
        if (!priceOffline && api && !api.offline){
          if (job.v.chain === "btc" && prices.btc) usd = (api.balance_sats || 0) / 1e8 * prices.btc;
          if (job.v.chain === "eth" && prices.eth){
            try { usd = Number(BigInt(api.balance_wei || "0")) / 1e18 * prices.eth; }
            catch (e){ usd = 0; }
          }
        }
        return { address: job.address, v: job.v, analysis: analysis, usd: usd,
                 priceOffline: priceOffline, isSample: !!job.sample,
                 label: job.sample ? job.sample.label : "" };
      }));
      // Superseded while this batch was in flight (Clear, or a newer
      // audit): render nothing — the results belong to discarded input.
      if (!isCurrent()) return;
      results.forEach(function(entry){
        entries.push(entry);
        $("resultsGrid").insertAdjacentHTML("beforeend", renderCard(entry));
      });
    }

    var sum = C.summarize(entries);
    sum.priceOffline = !!prices.offline;
    renderSummary(sum);
    var problems = entries.filter(function(e){
      return e.analysis.verdict === "exposed" || e.analysis.verdict === "latent" ||
             e.analysis.verdict === "unknown" || e.analysis.verdict === "invalid";
    }).length;
    $("statusLine").textContent = "Audit complete: " + entries.length + " address(es), " +
      problems + " need attention." + (prices.offline ? " (Price feed offline — USD estimates skipped.)" : "");
  } catch (e) {
    // A current audit that throws (e.g. detectChain rejecting when
    // SubtleCrypto is unavailable) reports honestly instead of wedging;
    // a superseded audit's failure stays silent.
    if (isCurrent())
      $("statusLine").textContent = "Audit failed: " + String(e && e.message || e) + " — nothing was rendered; try again.";
  } finally {
    // Only the current audit owns the button/lock: a superseded audit
    // must not re-enable Run over a newer audit, nor leave it disabled.
    if (isCurrent()){
      btn.classList.remove("scanning"); btn.disabled = false;
      running = false;
    }
  }
}

function init(){
  $("runBtn").addEventListener("click", function(){
    var addrs = parseInput($("addrInput").value);
    if (!addrs.length){
      $("statusLine").textContent = "Paste at least one address first — or try the sample set.";
      return;
    }
    if (addrs.length > 25){
      $("statusLine").textContent = "Capped at 25 addresses per audit (API courtesy). Auditing the first 25.";
      addrs = addrs.slice(0, 25);
    }
    runAudit(addrs, false);
  });
  $("sampleBtn").addEventListener("click", function(){
    if (running) return; // an audit is already in flight; don't swap its input
    $("addrInput").value = C.SAMPLES.map(function(s){ return s.address; }).join("\n");
    runAudit(C.SAMPLES.map(function(s){ return s.address; }), true);
  });
  $("clearBtn").addEventListener("click", function(){
    // Invalidate any in-flight audit FIRST: its late batches must not
    // resurrect results over the cleared state, and the Run lock is
    // released here (the superseded audit's finally will not touch it).
    auditSeq++;
    if (running){
      running = false;
      var btn = $("runBtn");
      btn.classList.remove("scanning"); btn.disabled = false;
    }
    $("addrInput").value = ""; $("resultsGrid").innerHTML = "";
    renderSummary(null); $("statusLine").textContent = "";
  });
  $("addrInput").addEventListener("keydown", function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("runBtn").click();
  });
  // Expose for the QA harness.
  window.ExposureLab = { runAudit: runAudit, parseInput: parseInput, C: C };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
})();
