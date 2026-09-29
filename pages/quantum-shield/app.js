/* Quantum Shield — interactive post-quantum explainer for Quantus.
 * Figures verified 2026-09-29 against NIST FIPS 204, the FIPS-204-derived
 * parameter tables, and the Quantus architecture docs (docs/architecture.md).
 *   ML-DSA-44: pk 1,312 B / sig 2,420 B / Category 2
 *   ML-DSA-65: pk 1,952 B / sig 3,309 B / Category 3
 *   ML-DSA-87: pk 2,592 B / sig 4,627 B / Category 5 (used on-chain by Quantus)
 *   ECDSA (secp256k1) sig ≈ 65 B; Ed25519/Schnorr ≈ 64 B
 *   Block packing (design figures from testing, 12s blocks, 3.75 MB/block):
 *   transparent ≈ 510 tx/block (≈43 QTPS); aggregated ≈ 5,200 tx/block (≈430 QTPS)
 */
(function(){
"use strict";

var PARAMS = {
  "44": { pk: 1312, sig: 2420, cat: 2, equiv: "\u2248 SHA-256/SHA3-256 collision effort" },
  "65": { pk: 1952, sig: 3309, cat: 3, equiv: "\u2248 AES-192 key search" },
  "87": { pk: 2592, sig: 4627, cat: 5, equiv: "\u2248 AES-256 key search" }
};
var SIG_MAX = PARAMS["87"].sig;
var ECDSA_SIG = 65;
var EDDSA_SIG = 64;
var BLOCK_TIME_S = 12;
var PER_BLOCK = { transparent: 510, aggregated: 5200 };

/* ---------------- pure helpers (Node-testable) ---------------- */

function fmtBytes(n){
  if (n === null || n === undefined || isNaN(n) || n < 0) return "—";
  if (n < 1024) return Math.floor(n) + " B";
  return (n / 1024).toFixed(1) + " KB";
}

/* how many whole ECDSA signatures fit inside one ML-DSA signature */
function ecdsaFit(sigBytes){
  if (!sigBytes || sigBytes <= 0) return 0;
  return Math.floor(sigBytes / ECDSA_SIG);
}

/* bar width in % against the fixed max scale (ML-DSA-87), honest comparisons */
function barPct(sigBytes){
  if (!sigBytes || sigBytes <= 0) return 0;
  return Math.min(100, sigBytes / SIG_MAX * 100);
}

function packBlocks(txCount, perBlock){
  txCount = Math.max(0, Math.floor(txCount || 0));
  if (!perBlock || perBlock <= 0) return 0;
  return Math.ceil(txCount / perBlock);
}

/* 12s blocks -> human duration; always labeled approximate by the caller */
function blocksToHuman(blocks){
  var s = Math.max(0, blocks) * BLOCK_TIME_S;
  if (s < 60) return "~" + Math.round(s) + " s";
  var m = s / 60;
  if (m < 60) return "~" + (Math.round(m * 10) / 10) + " min";
  var h = m / 60;
  return "~" + (Math.round(h * 10) / 10) + " h";
}

/* ratio text for "about Nx larger" */
function ratioText(sigBytes){
  var r = sigBytes / ECDSA_SIG;
  var shown = r >= 100 ? Math.round(r) : Math.round(r * 10) / 10;
  return "about " + shown + "\u00D7 larger";
}

var EXPOSURE = {
  spent: {
    risk: "risk-high",
    verdict: "HIGH RISK — public key already harvested",
    why: "This address already broadcast a transaction, so its public key is permanently on-chain. Anyone can archive it today and derive the private key the moment a cryptographically relevant quantum computer exists — 'harvest now, forge later.' Blockchain history can't be un-published.",
    fix: "What helps: move funds to a fresh address (key still hidden) — but on a classical chain the new key becomes exposed the next time you spend. A chain with ML-DSA signatures from genesis (like Quantus) never opens this window at all."
  },
  taproot: {
    risk: "risk-high",
    verdict: "HIGH RISK — public key visible in the address itself",
    why: "Taproot outputs and bare public-key (P2PK) addresses embed the full public key — there is no hash hiding it. Harvesting doesn't even require the owner to spend; the key is exposed from the moment the address is funded.",
    fix: "What helps: hashed addresses (P2WPKH-style) at least hide the key until first spend. Long-term, only post-quantum signatures remove the risk."
  },
  fresh: {
    risk: "risk-low",
    verdict: "LOW RISK today — but only until first spend",
    why: "The public key is still hidden behind a hash, so there is nothing to harvest yet. Widely repeated guidance: never reuse addresses, and treat the first spend as the moment exposure begins.",
    fix: "What helps: spend once, then move change to a new fresh address — and plan a migration path to post-quantum signatures before spending from old holdings."
  },
  mldsa: {
    risk: "risk-none",
    verdict: "DESIGNED SAFE — Shor-resistant signatures",
    why: "ML-DSA rests on lattice problems (MLWE/MSIS) with no known quantum shortcut — Shor's algorithm doesn't apply. Because Quantus used ML-DSA-87 from the genesis block, there is no pre-quantum signature history to harvest. The exposure window never opened.",
    fix: "Still good hygiene: keep keys offline, and verify you are running the real chain software — quantum-safe math doesn't help if the binary is fake."
  }
};

function exposureInfo(kind){
  return EXPOSURE[kind] || null;
}

var API = { PARAMS: PARAMS, ECDSA_SIG: ECDSA_SIG, EDDSA_SIG: EDDSA_SIG,
  fmtBytes: fmtBytes, ecdsaFit: ecdsaFit, barPct: barPct,
  packBlocks: packBlocks, blocksToHuman: blocksToHuman,
  ratioText: ratioText, exposureInfo: exposureInfo, PER_BLOCK: PER_BLOCK };
if (typeof module !== "undefined" && module.exports) module.exports = API;

/* ---------------- DOM wiring (browser only) ---------------- */

if (typeof document === "undefined") return;

function $(id){ return document.getElementById(id); }

function setBars(set){
  var p = PARAMS[set];
  $("barPq").style.width = barPct(p.sig) + "%";
  $("barCl1").style.width = barPct(ECDSA_SIG) + "%";
  $("barCl2").style.width = barPct(EDDSA_SIG) + "%";
  $("barCl3").style.width = barPct(EDDSA_SIG) + "%";
  $("valPq").textContent = fmtBytes(p.sig);
  $("ratioLine").textContent = ratioText(p.sig);
  $("msCat").textContent = p.cat;
  $("msCatFoot").textContent = p.equiv;
  $("msPk").textContent = fmtBytes(p.pk);
  $("msFit").textContent = "\u2248" + ecdsaFit(p.sig);
  var tabs = document.querySelectorAll(".ptab");
  for (var i = 0; i < tabs.length; i++){
    var on = tabs[i].getAttribute("data-set") === set;
    tabs[i].classList.toggle("active", on);
    tabs[i].setAttribute("aria-selected", on ? "true" : "false");
  }
}

function updateSim(){
  var n = parseInt($("txSlider").value, 10) || 0;
  $("txCountOut").textContent = n.toLocaleString("en-US");
  var bt = packBlocks(n, PER_BLOCK.transparent);
  var ba = packBlocks(n, PER_BLOCK.aggregated);
  $("simBlocksT").textContent = bt.toLocaleString("en-US");
  $("simTimeT").textContent = blocksToHuman(bt);
  $("simBlocksA").textContent = ba.toLocaleString("en-US");
  $("simTimeA").textContent = blocksToHuman(ba);
}

function selectExposure(kind, el){
  var info = exposureInfo(kind);
  if (!info) return;
  var cards = document.querySelectorAll(".expo-card");
  for (var i = 0; i < cards.length; i++) cards[i].classList.remove("selected");
  el.classList.add("selected");
  var d = $("expoDetail");
  d.hidden = false;
  d.className = "expo-detail " + info.risk;
  $("expoVerdict").textContent = info.verdict;
  $("expoWhy").textContent = info.why;
  var fix = $("expoFix");
  fix.innerHTML = "";
  var b = document.createElement("b");
  b.textContent = info.fix.split(":")[0] + ":";
  fix.appendChild(b);
  fix.appendChild(document.createTextNode(" " + info.fix.split(":").slice(1).join(":").trim()));
}

document.addEventListener("DOMContentLoaded", function(){
  setBars("87");
  updateSim();
  var tabs = document.querySelectorAll(".ptab");
  for (var i = 0; i < tabs.length; i++){
    tabs[i].addEventListener("click", function(){ setBars(this.getAttribute("data-set")); });
  }
  $("txSlider").addEventListener("input", updateSim);
  var cards = document.querySelectorAll(".expo-card");
  for (var j = 0; j < cards.length; j++){
    (function(el){
      el.addEventListener("click", function(){ selectExposure(el.getAttribute("data-kind"), el); });
    })(cards[j]);
  }
  var copy = $("donateCopy");
  if (copy){
    copy.addEventListener("click", function(){
      var addr = copy.textContent.trim();
      function done(){ var t = copy.textContent; copy.textContent = "copied \u2713"; setTimeout(function(){ copy.textContent = t; }, 1600); }
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(addr).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = addr; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch(e){}
        document.body.removeChild(ta); done();
      }
    });
  }
});
})();
