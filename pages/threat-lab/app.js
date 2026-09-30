/* QTC Threat Lab — Q-Day countdown + exposure simulator + chain readiness.
   Verified facts (Sept 29, 2026): NIST FIPS 204 (ML-DSA) finalized Aug 2024;
   ML-DSA-65 pk 1952 B / sig 3309 B; ML-DSA-87 pk 2592 B / sig 4627 B;
   Quantus mainnet Sept 9, 2026 with ML-DSA-65/87 from genesis. */
(function(){
"use strict";

/* ---------- Q-Day scenarios (sourced estimates, never predictions) ---------- */
var SCENARIOS = [
  { id:"aggressive", name:"Aggressive · 2028", date: Date.UTC(2028,11,31),
    who:"IonQ",
    claim:"IonQ targets a cryptographically-relevant quantum computer by 2028 — the most aggressive public claim in the industry.",
    src:"Industry roadmap table (verified Aug 2026)" },
  { id:"benchmark", name:"Benchmark · 2029", date: Date.UTC(2029,11,31), def:true,
    who:"Google + Microsoft + IBM",
    claim:"Google expects a CRQC could compromise most existing encryption by 2029; Microsoft targets a scalable commercial quantum computer by 2029 (Majorana 2); IBM targets Starling (200 logical qubits) in 2029.",
    src:"Google Q-Day analysis; Microsoft Majorana 2 announcement; IBM roadmap" },
  { id:"cautious", name:"Cautious · 2032", date: Date.UTC(2032,11,31),
    who:"Justin Drake + Google paper",
    claim:"Justin Drake: ≥10% chance a quantum system recovers a private key from an exposed public key by 2032. Google's paper found <500k physical qubits could suffice — a ~20× reduction from earlier estimates.",
    src:"Google on-spend-attack paper; Drake (Ethereum Foundation)" }
];

/* ---------- Chains + wallet states for the exposure simulator ---------- */
var CHAINS = [
  { id:"btc", name:"Bitcoin", icon:"₿", unit:"BTC",
    sigs:"ECDSA + Schnorr (secp256k1)",
    status:"Vulnerable", statusClass:"st-bad",
    plan:"BIP-361 (draft, Apr 2026) would sunset legacy signatures over ~5 years. Not activated — today there is no production migration path.",
    wallets:[
      { id:"btc-p2pk", name:"P2PK output (early 2009–2010 coins, incl. Satoshi-era)",
        exposure:"exposed",
        why:"The public key sits in the output script itself — exposed since the coin was created. BIP-361 estimates >34% of all BTC sits at pubkey-exposed addresses; CryptoQuant puts it near 6.9M BTC.",
        action:"If BIP-361 activates, these coins must move to PQ scripts in Phase A or face freezing in Phase B. There is no safe parking." },
      { id:"btc-reused", name:"Reused address (has sent at least once)",
        exposure:"exposed",
        why:"Spending revealed the public key on-chain. Any coins left at — or later sent to — this address are exposed, and the exposure never expires.",
        action:"Sweep remaining coins to a fresh never-spent address; never reuse an address again. Watch BIP-361 for the migration window." },
      { id:"btc-p2tr", name:"Taproot (P2TR) address",
        exposure:"exposed",
        why:"A Taproot address IS the tweaked public key in bech32m — no hash layer in front. Exposed at creation, before any spend.",
        action:"Taproot coins are the most exposed on Bitcoin. Consolidate to a fresh P2WPKH address (hashed, never spent) until a PQ path exists." },
      { id:"btc-fresh", name:"Never-spent P2PKH / P2WPKH address",
        exposure:"safe-today",
        why:"Only the hash of the public key is on-chain. The key itself is revealed only when you spend — so this is quantum-safe today.",
        action:"Stay here. Do not spend from it until a post-quantum migration (e.g. BIP-361) is live — the first spend starts the exposure clock." }
    ] },
  { id:"eth", name:"Ethereum", icon:"Ξ", unit:"ETH",
    sigs:"ECDSA (secp256k1)",
    status:"Vulnerable · migrating", statusClass:"st-warn",
    plan:"EF Protocol cluster (Sept 2026): base-layer quantum resistance deadline December 2029 — non-negotiable until a Jan 2027 reassessment. Q-Day planned for as early as 2030 as a cautious estimate.",
    wallets:[
      { id:"eth-spent", name:"EOA that has sent a transaction",
        exposure:"exposed",
        why:"Every Ethereum spend reveals the EOA's public key on-chain, and contracts you interacted with keep the history forever.",
        action:"Follow the EF's PQ migration plan; the Dec 2029 deadline is the horizon to watch. Avoid long-term cold storage in a spent EOA." },
      { id:"eth-fresh", name:"Fresh EOA (funded, never sent)",
        exposure:"safe-today",
        why:"The address is a hash of the public key, and no spend has revealed it yet — the same hash-layer protection as Bitcoin's P2PKH.",
        action:"Safe until the first spend. Plan the migration with the EF's Dec 2029 base-layer deadline in mind." }
    ] },
  { id:"sol", name:"Solana", icon:"◎", unit:"SOL",
    sigs:"Ed25519 (base layer)",
    status:"Partial", statusClass:"st-warn",
    plan:"Base layer still Ed25519. Opt-in Winternitz Vault (Jan 3, 2025, Dean Little): hash-based WOTS + Keccak256, fresh keys per transaction — not a network-wide upgrade.",
    wallets:[
      { id:"sol-standard", name:"Standard wallet (Phantom etc.)",
        exposure:"exposed",
        why:"Base-layer Solana uses Ed25519; every signature exposes the public key. No production network-wide PQ upgrade exists.",
        action:"For long-term holdings, consider the Winternitz Vault (opt-in, Jan 2025) — fresh one-time keys per transaction, Keccak256 hash-based." },
      { id:"sol-vault", name:"Winternitz Vault (opt-in)",
        exposure:"partial",
        why:"The vault uses hash-based Winternitz one-time signatures with fresh keys per transaction — quantum-resistant internally — but it is opt-in and the surrounding network is still Ed25519.",
        action:"You did the right thing opting in. Keep vault funds separate from standard wallets and track any network-wide upgrade." }
    ] },
  { id:"ada", name:"Cardano", icon:"₳", unit:"ADA",
    sigs:"Ed25519 (EdDSA)",
    status:"Research", statusClass:"st-warn",
    plan:"IO Research PQ proposal (May 2026, governance vote); CIP-0197 post-quantum ZK signatures for HD wallets in review. No production PQ signatures.",
    wallets:[
      { id:"ada-spent", name:"Wallet that has sent transactions",
        exposure:"exposed",
        why:"Cardano uses Ed25519 throughout; spending reveals the public key, and the PQ migration is still in research/governance.",
        action:"Track the IO Research proposal and CIP-0197. The hard-fork cadence makes migration tractable once a standard is chosen — but it isn't yet." },
      { id:"ada-fresh", name:"Fresh wallet (funded, never sent)",
        exposure:"safe-today",
        why:"Address is a hash of the key; no spend has revealed it. Same hash-layer rule as Bitcoin and Ethereum.",
        action:"Safe until the first spend. Hold the migration decision until Cardano ships production PQ signatures." }
    ] },
  { id:"qtc", name:"Quantus", icon:"◈", unit:"QTC",
    sigs:"ML-DSA-65 / ML-DSA-87 (NIST FIPS 204)",
    status:"Quantum-safe", statusClass:"st-safe",
    plan:"Live now: ML-DSA-65/87 from the genesis block (mainnet Sept 9, 2026). No migration needed — no known quantum algorithm breaks Module-LWE.",
    wallets:[
      { id:"qtc-any", name:"Any QTC address",
        exposure:"pq-safe",
        why:"Every Quantus signature is ML-DSA-65 (pk 1,952 B / sig 3,309 B) or ML-DSA-87 (pk 2,592 B / sig 4,627 B), standardized as NIST FIPS 204 in Aug 2024. Shor's algorithm does not apply to lattice problems.",
        action:"Nothing to migrate. This is what post-Q-Day money looks like — the countdown above is for everyone else." }
    ] }
];

/* ---------- Milestone timeline ---------- */
var TIMELINE = [
  { y:2019, t:"Google claims quantum supremacy", d:"Sycamore performs a computation billed as beyond classical reach — the starting gun for the Q-Day conversation." },
  { y:2024, m:8, t:"NIST finalizes FIPS 203 / 204 / 205", d:"ML-KEM, ML-DSA and SLH-DSA become final federal standards (Aug 2024). The PQ toolbox goes from research to regulation-grade." },
  { y:2024, m:12, t:"Google Willow: 105 qubits, below-threshold error correction", d:"The first demonstration that error rates fall as qubits scale — the engineering path to fault tolerance gets credible." },
  { y:2025, m:1, t:"Solana Winternitz Vault (opt-in)", d:"Dean Little ships a hash-based, fresh-keys-per-tx vault — quantum-resistant internally, but users must opt in; the base layer stays Ed25519." },
  { y:2025, m:3, t:"HQC selected as backup KEM", d:"NIST selects the code-based HQC for standardization (draft expected 2026, final ~2026–2027) as insurance against a lattice break." },
  { y:2026, m:4, t:"BIP-361 published (Bitcoin PQ migration draft)", d:"Jameson Lopp's 'Post Quantum Migration and Legacy Signature Sunset': ~3-year Phase A, then legacy signatures invalidated. Draft — not activated." },
  { y:2026, m:9, t:"Quantus mainnet: ML-DSA from the genesis block", d:"The first major chain to launch with post-quantum signatures (ML-DSA-65/87) for every account from block one. No migration needed." },
  { y:2026, m:9, t:"Ethereum Foundation: base-layer PQ deadline Dec 2029", d:"The Protocol cluster sets a self-imposed, non-negotiable-until-Jan-2027 deadline for quantum resistance across execution, consensus and data layers." },
  { y:2028, t:"IonQ target: cryptographically-relevant machine", d:"The most aggressive public claim in the industry. If met, exposed keys anywhere start falling." },
  { y:2029, t:"Google / Microsoft / IBM benchmark window", d:"Google's Q-Day analysis, Microsoft's scalable-machine target (Majorana 2) and IBM's Starling (200 logical qubits) all converge here." },
  { y:2030, t:"EU DORA high-risk deadline · NSA CNSA 2.0 window", d:"The EU's post-quantum roadmap sets 2030 for high-risk use cases; NSA's CNSA 2.0 requires exclusive PQ use 2030–2033." },
  { y:2032, t:"Drake: ≥10% chance of exposed-key recovery", d:"Justin Drake's cautious call: even a one-in-ten shot at private-key recovery from exposed pubkeys by 2032 changes the game." },
  { y:2033, t:"IBM Blue Jay: 2,000 logical qubits (target)", d:"IBM's post-Starling roadmap target — the scale where 'maybe never' stops being the safe bet." }
];

/* ---------- Sources (verbatim URLs from verified search results) ---------- */
var SOURCES = [
  { u:"https://www.kfcipher.net/pqc-standards-tracker.jsp", t:"NIST PQC standards tracker — FIPS 203/204/205 final Aug 2024, HQC selected Mar 2025", d:"Sept 29, 2026" },
  { u:"https://github.com/conchaestradamiguelangel-droid/aegis/blob/HEAD/docs/blog/ml-dsa-87-post-quantum-ids.md", t:"ML-DSA parameter sizes — ML-DSA-65: pk 1,952 B / sig 3,309 B; ML-DSA-87: pk 2,592 B / sig 4,627 B", d:"Sept 29, 2026" },
  { u:"https://www.barrons.com/articles/google-issues-q-day-warning-quantum-510b44d1", t:"Google Q-Day analysis — on-spend attack (9–12 min), <500k physical qubits, Q-Day possibly by 2029", d:"Sept 29, 2026" },
  { u:"https://www.tampabay28.com/scripps-news-investigates/q-day-americas-quantum-computing-blindspot/the-coming-q-day-us-states-largely-unprepared-as-quantum-computing-threats-loom", t:"Microsoft Majorana 2 → scalable quantum by 2029; IBM Starling 2029; QuEra/AWS 2028", d:"Sept 29, 2026" },
  { u:"https://github.com/shlok926/novocrypt/blob/HEAD/q-day-global-timeline-data.md", t:"Industry roadmap table — IonQ 2028 CRQC target, IBM/Starling/Blue Jay, Quantinuum, PsiQuantum", d:"Sept 29, 2026" },
  { u:"https://github.com/treib-holdings/learnbitcoin-content/blob/HEAD/glossary/bip-361.md", t:"BIP-361 — >34% of BTC pubkey-exposed; P2PK / reuse / Taproot exposure rules", d:"Sept 29, 2026" },
  { u:"https://github.com/nickmonad/bips.dev/blob/HEAD/web/content/361/index.md", t:"BIP-361 specification — Phase A (160,000 blocks, ~3 yrs), Phase B (2 yrs later), published Apr 15, 2026", d:"Sept 29, 2026" },
  { u:"https://en.spaziocrypto.com/bitcoin/bip-361-freeze-satoshi-bitcoin-quantum/", t:"BIP-361 debate — Satoshi's ~1M P2PK coins frozen under Phase B unless moved", d:"Sept 29, 2026" },
  { u:"https://github.com/treib-holdings/learnbitcoin-content/blob/HEAD/rabbit-holes/quantum-and-bitcoin.mdx", t:"Shor vs Grover — signatures are the weak link; 21M cap survives; hashed addresses survive", d:"Sept 29, 2026" },
  { u:"https://www.europesays.com/europe/146843/", t:"EU quantum warning — CryptoQuant: ~6.89M BTC exposed (1.91M P2PK + ~4.98M reused); EU PQ roadmap 2030", d:"Sept 29, 2026" },
  { u:"https://www.bitget.fit/news/detail/12560605803616", t:"Ethereum Foundation — base-layer quantum-resistance deadline December 2029 (Sept 2026)", d:"Sept 29, 2026" },
  { u:"https://CoinTelegraph.com/news/solana-is-now-quantum-resistant-solana-dev-claims", t:"Solana Winternitz Vault (Jan 3, 2025) — opt-in, hash-based, not network-wide", d:"Sept 29, 2026" },
  { u:"https://getblock.io/blog/cn/what-is-solana-winternitz-vault-full-guide/", t:"Winternitz Vault mechanics — WOTS + Keccak256, fresh keys per transaction", d:"Sept 29, 2026" },
  { u:"https://cryptonews.com/news/cardano-quantum-safe-roadmap-ada-price-stagnant/", t:"Cardano PQ roadmap — IO Research proposal, lattice-based migration, phased model", d:"Sept 29, 2026" },
  { u:"https://www.coingabbar.com/en/crypto-currency-news/cardano-upgrade-2026-new-cips-target-quantum-security", t:"CIP-0197 — post-quantum ZK signatures for HD wallets (in review, 2026)", d:"Sept 29, 2026" },
  { u:"https://github.com/adatainment/cardano-org/blob/HEAD/blog/2026-06-19-cardano-vision-2026/index.md", t:"Cardano Vision 2026 — bottom-up PQC framework research program", d:"Sept 29, 2026" },
  { u:"https://u.today/cardano-begins-building-quantum-resistant-future-with-security-initiative?from=article-links", t:"IO Research PQ proposal (May 2026) — governance vote for post-quantum hardening", d:"Sept 29, 2026" }
];

/* ---------- pure, node-testable logic ---------- */

function countdownParts(targetMs, nowMs){
  var diff = targetMs - nowMs, past = diff <= 0;
  if (past) diff = 0;
  var s = Math.floor(diff / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600),
           m: Math.floor(s % 3600 / 60), s: s % 60, past: past };
}

function getChain(id){
  for (var i = 0; i < CHAINS.length; i++) if (CHAINS[i].id === id) return CHAINS[i];
  return null;
}
function getWallet(chain, wid){
  for (var i = 0; i < chain.wallets.length; i++) if (chain.wallets[i].id === wid) return chain.wallets[i];
  return chain.wallets[0];
}

var VERDICTS = {
  "exposed":   { label:"EXPOSED",   cls:"v-exposed",
    crack:"If Q-Day arrived today: on Google's analysis, a fast-clock machine derives the key in ~9–12 minutes. Keys exposed years ago have no time limit at all.",
    risk: function(a, u){ return fmtAmount(a) + " " + u + " at risk"; } },
  "safe-today":{ label:"SAFE TODAY", cls:"v-safetoday",
    crack:"The hash layer holds: Grover's algorithm only halves SHA-256 to an effective 128-bit — still the standard security floor. Exposure begins the moment you spend.",
    risk: function(){ return "0 at risk — until the first spend"; } },
  "partial":   { label:"PARTIALLY SHIELDED", cls:"v-partial",
    crack:"The vault's hash-based one-time keys resist Shor, but the surrounding chain still runs Ed25519 — the shield is only as wide as the vault.",
    risk: function(a, u){ return "Vault portion shielded · " + fmtAmount(a) + " " + u + " in vault"; } },
  "pq-safe":   { label:"QUANTUM-SAFE", cls:"v-pqsafe",
    crack:"No known quantum algorithm breaks Module-LWE. ML-DSA is a final NIST standard (FIPS 204, Aug 2024) — the same primitive the US government now mandates.",
    risk: function(){ return "0 at risk — by design"; } }
};

function fmtAmount(a){
  if (!isFinite(a) || a < 0) a = 0;
  return a.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

/* assess(chainId, walletId, amount) -> verdict object */
function assess(chainId, walletId, amount){
  var chain = getChain(chainId) || CHAINS[0];
  var w = getWallet(chain, walletId);
  var v = VERDICTS[w.exposure];
  var amt = parseFloat(amount); if (!isFinite(amt) || amt < 0) amt = 0;
  return {
    chain: chain.name, unit: chain.unit, wallet: w.name,
    exposure: w.exposure, label: v.label, cls: v.cls,
    risk: v.risk(amt, chain.unit), why: w.why, crack: v.crack, action: w.action,
    plan: chain.plan
  };
}

/* ---------- browser rendering ---------- */

function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function pad(n){ return (n < 10 ? "0" : "") + n; }

var activeScenario = null;

function renderScenarioTabs(){
  var el = document.getElementById("scenario-tabs");
  el.innerHTML = SCENARIOS.map(function(s){
    return '<button role="tab" class="scen-tab' + (s.def ? " active" : "") + '" data-id="' + s.id + '">' +
      '<span class="st-name">' + esc(s.name) + '</span><span class="st-who">' + esc(s.who) + '</span></button>';
  }).join("");
  el.querySelectorAll(".scen-tab").forEach(function(b){
    b.addEventListener("click", function(){
      el.querySelectorAll(".scen-tab").forEach(function(x){ x.classList.remove("active"); });
      b.classList.add("active");
      setScenario(b.getAttribute("data-id"));
    });
  });
  var def = SCENARIOS.filter(function(s){ return s.def; })[0] || SCENARIOS[0];
  setScenario(def.id);
}
function setScenario(id){
  activeScenario = SCENARIOS.filter(function(s){ return s.id === id; })[0] || SCENARIOS[0];
  document.getElementById("scenario-note").innerHTML =
    '<div class="sn-who">' + esc(activeScenario.who) + '</div><div>' + esc(activeScenario.claim) + '</div>' +
    '<div class="sn-src">Source: ' + esc(activeScenario.src) + ' · verified Sept 29, 2026</div>';
  tickClock();
}
function tickClock(){
  if (!activeScenario) return;
  var p = countdownParts(activeScenario.date, Date.now());
  document.getElementById("cd-d").textContent = p.d.toLocaleString("en-US");
  document.getElementById("cd-h").textContent = pad(p.h);
  document.getElementById("cd-m").textContent = pad(p.m);
  document.getElementById("cd-s").textContent = pad(p.s);
}

function renderChainPicker(){
  var el = document.getElementById("chain-picker");
  el.innerHTML = CHAINS.map(function(c, i){
    return '<button role="radio" aria-checked="' + (i === 0 ? "true" : "false") + '" class="chain-btn' + (i === 0 ? " active" : "") + '" data-id="' + c.id + '">' +
      '<span class="cb-ico">' + c.icon + '</span><span class="cb-name">' + esc(c.name) + '</span></button>';
  }).join("");
  el.querySelectorAll(".chain-btn").forEach(function(b){
    b.addEventListener("click", function(){ selectChain(b.getAttribute("data-id")); });
  });
  selectChain(CHAINS[0].id);
}
function currentChainId(){
  var b = document.querySelector("#chain-picker .chain-btn.active");
  return b ? b.getAttribute("data-id") : CHAINS[0].id;
}
function selectChain(id){
  document.querySelectorAll("#chain-picker .chain-btn").forEach(function(b){
    var on = b.getAttribute("data-id") === id;
    b.classList.toggle("active", on); b.setAttribute("aria-checked", on ? "true" : "false");
  });
  var chain = getChain(id), sel = document.getElementById("wallet-select");
  sel.innerHTML = chain.wallets.map(function(w, i){
    return '<option value="' + w.id + '"' + (i === 0 ? " selected" : "") + '>' + esc(w.name) + '</option>';
  }).join("");
  document.getElementById("sim-unit").textContent = chain.unit;
  runSim();
}
function runSim(){
  var r = assess(currentChainId(), document.getElementById("wallet-select").value,
                 document.getElementById("sim-amount").value);
  document.getElementById("verdict-badge").className = "badge " + r.cls;
  document.getElementById("verdict-badge").textContent = r.label;
  document.getElementById("verdict-title").textContent = r.chain + " · " + r.wallet;
  document.getElementById("verdict-risk").textContent = r.risk;
  document.getElementById("verdict-why").textContent = r.why;
  document.getElementById("verdict-crack").textContent = r.crack;
  document.getElementById("verdict-do").textContent = r.action;
}

function renderReadiness(){
  var tb = document.querySelector("#ready-table tbody");
  tb.innerHTML = CHAINS.map(function(c){
    return "<tr><td><span class='rc-ico'>" + c.icon + "</span> <strong>" + esc(c.name) + "</strong></td>" +
      "<td class='mono'>" + esc(c.sigs) + "</td>" +
      "<td><span class='badge " + c.statusClass + "'>" + esc(c.status) + "</span></td>" +
      "<td>" + esc(c.plan) + "</td></tr>";
  }).join("");
}

function renderTimeline(){
  var el = document.getElementById("tl");
  el.innerHTML = TIMELINE.map(function(e){
    var date = e.m ? e.y + " · " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][e.m-1]
                   : String(e.y) + (e.y >= 2028 ? " · target" : "");
    var future = e.y >= 2028;
    return '<div class="tl-row' + (future ? " tl-future" : "") + '"><div class="tl-date">' + esc(date) + '</div>' +
      '<div class="tl-body"><strong>' + esc(e.t) + '</strong><p>' + esc(e.d) + '</p></div></div>';
  }).join("");
}

function renderSources(){
  var el = document.getElementById("source-list");
  el.innerHTML = SOURCES.map(function(s){
    return '<li><a href="' + esc(s.u) + '" target="_blank" rel="noopener">' + esc(s.t) + '</a> <span class="sdate">— verified ' + esc(s.d) + '</span></li>';
  }).join("");
}

/* Signature-glyph rain canvas (decorative, respects reduced motion). */
function initRain(){
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var cv = document.getElementById("sigrain"); if (!cv) return;
  var ctx = cv.getContext("2d"), W, H, parts = [];
  function size(){ W = cv.width = innerWidth; H = cv.height = innerHeight; }
  size(); addEventListener("resize", size);
  var glyphs = "01⌁∑λψΩΔ⚛";
  for (var i = 0; i < 55; i++) parts.push({ x: Math.random(), y: Math.random(), s: 0.0003 + Math.random()*0.001, g: glyphs[Math.floor(Math.random()*glyphs.length)], o: 0.04 + Math.random()*0.10, fs: 10 + Math.random()*15 });
  (function tick(){
    ctx.clearRect(0,0,W,H);
    for (var k = 0; k < parts.length; k++){
      var p = parts[k];
      p.y += p.s; if (p.y > 1.02){ p.y = -0.02; p.x = Math.random(); }
      ctx.globalAlpha = p.o; ctx.fillStyle = "#ff5470";
      ctx.font = p.fs + "px monospace";
      ctx.fillText(p.g, p.x*W, p.y*H);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  })();
}

function init(){
  renderScenarioTabs();
  renderChainPicker();
  renderReadiness();
  renderTimeline();
  renderSources();
  document.getElementById("wallet-select").addEventListener("change", runSim);
  document.getElementById("sim-amount").addEventListener("input", runSim);
  document.getElementById("sim-run").addEventListener("click", runSim);
  setInterval(tickClock, 1000);
  initRain();
  runSim();
}

if (typeof document !== "undefined") init();

/* ---- node-testable exports ---- */
if (typeof module !== "undefined" && module.exports){
  module.exports = {
    SCENARIOS: SCENARIOS, CHAINS: CHAINS, TIMELINE: TIMELINE, SOURCES: SOURCES,
    countdownParts: countdownParts, assess: assess, fmtAmount: fmtAmount,
    getChain: getChain, getWallet: getWallet
  };
}
})();
