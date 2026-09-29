/* QTC Benchmark Lab — head-to-head chain comparator.
 * Data: every cell is {v: display, n: optional note, b: badge, s: source url}.
 * Badges: measured | claimed | approx | unverified.
 * Figures re-verified Sept 29, 2026. Pure helpers are exported for node tests.
 */
(function(){
"use strict";

/* ---- Evidence badge labels ---- */
var BADGE_LABEL = { measured:"measured", claimed:"claimed", approx:"approx", unverified:"unverified" };

/* ---- Chains ---- */
var CHAINS = [
  { id:"qtc", sym:"QTC", name:"Quantus",   color:"#34ff88", tag:"the quantum-era chain" },
  { id:"btc", sym:"BTC", name:"Bitcoin",   color:"#f5b942", tag:"digital gold" },
  { id:"eth", sym:"ETH", name:"Ethereum",  color:"#818cf8", tag:"world computer" },
  { id:"sol", sym:"SOL", name:"Solana",    color:"#22d3ee", tag:"speed layer" },
  { id:"erg", sym:"ERG", name:"Ergo",      color:"#f472b6", tag:"the researchers' PoW" }
];

/* ---- Matrix data. Quantus cells verified 2026-09-29 against chain repo/docs.
 * Comparator cells: filled from research, each with source + badge. ---- */
var METRICS = [
  { id:"consensus", label:"Consensus",
    rows:{
      qtc:{ v:"PoW · QPoW (Poseidon2-based)", n:"ASIC-resistant design; CPU/GPU friendly at launch.", b:"measured", s:"https://github.com/Quantus-Network" },
      btc:{ v:"PoW · SHA-256d, longest-chain rule", n:"Difficulty retargets every 2,016 blocks.", b:"measured", s:"https://github.com/cypher256/bitcoinarchive/blob/HEAD/src/data/entries/en/design/2009-01-03-bitcoin-consensus-design.md" },
      eth:{ v:"PoS · Gasper (LMD-GHOST + Casper FFG) since The Merge (Sept 2022)", n:"Validator attestations use BLS signatures.", b:"measured", s:"https://github.com/d3servelabs/namefi-resources/blob/HEAD/content/blog/en/blockchain-cryptographic-primitives.md" },
      sol:{ v:"PoH (SHA-256 hash-chain clock) + PoS", b:"measured", s:"https://blockchainreporter.net/web3/solana-review-the-high-performance-blockchain-built-for-mass-adoption/" },
      erg:{ v:"PoW · Autolykos v2 (memory-hard, ~2 GB search)", n:"Verification is light (~2 KB); ASIC-resistance by design.", b:"measured", s:"https://storage.googleapis.com/ergo-cms-media/docs/ErgoPow.pdf" } } },
  { id:"signatures", label:"Signature scheme",
    rows:{
      qtc:{ v:"ML-DSA-65 / ML-DSA-87 (NIST FIPS 204)", n:"Post-quantum from the genesis block — no migration cliff.", b:"measured", s:"https://github.com/Quantus-Network/chain" },
      btc:{ v:"ECDSA (secp256k1) · Schnorr (BIP-340) for Taproot", b:"measured", s:"https://tekingame.com/blog/quantum-threat-bitcoin-ethereum-en" },
      eth:{ v:"ECDSA (secp256k1)", n:"PQ migration is research-stage (EIP-8141 draft); no mainnet timeline.", b:"measured", s:"https://github.com/w3hc/w3pk/blob/HEAD/docs/POST_QUANTUM.md" },
      sol:{ v:"Ed25519", n:"Winternitz Vault live (one-time hash sigs); Dilithium demoed at ~3k TPS on testnet (Dec 2025).", b:"measured", s:"https://github.com/isslashy/protocol-01/blob/HEAD/docs/quantum-resistance.md" },
      erg:{ v:"Schnorr via Sigma protocols (secp256k1)", n:"No official PQC work found.", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/crypto.md" } } },
  { id:"qsafe", label:"Quantum-safe by default",
    rows:{
      qtc:{ v:"Yes — all signatures ML-DSA", b:"measured", s:"https://github.com/Quantus-Network/chain" },
      btc:{ v:"No — ECDSA/Schnorr fall to Shor's algorithm", n:"Only a draft PQ proposal (BIP-360) exists; not deployed.", b:"measured", s:"https://tekingame.com/blog/quantum-threat-bitcoin-ethereum-en" },
      eth:{ v:"No — PQ roadmap is research-stage", b:"measured", s:"https://github.com/w3hc/w3pk/blob/HEAD/docs/POST_QUANTUM.md" },
      sol:{ v:"No by default — PQ work is experimental, not consensus", b:"measured", s:"https://github.com/isslashy/protocol-01/blob/HEAD/docs/quantum-resistance.md" },
      erg:{ v:"No — quantum-vulnerable by default", n:"No official PQC work found.", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/crypto.md" } } },
  { id:"sigsize", label:"Signature size",
    rows:{
      qtc:{ v:"≈ 3,309 B (ML-DSA-65) · ≈ 4,627 B (ML-DSA-87)", n:"From NIST FIPS 204 parameter tables.", b:"measured", s:"https://csrc.nist.gov/pubs/fips/204/final" },
      btc:{ v:"64 B class (Schnorr 64 B · DER ECDSA ~71–73 B)", b:"measured", s:"https://github.com/encryptorium/book-of-pqc-code/blob/HEAD/exercises/ch37-l1-signature-migration/README.md" },
      eth:{ v:"65 B (r, s + recovery id v)", b:"measured", s:"https://github.com/dvdmtw98/notes/blob/HEAD/notes-vault/blockchain/ethereum/ethereum-tranasactions.md" },
      sol:{ v:"64 B (Ed25519)", b:"measured", s:"https://github.com/isslashy/protocol-01/blob/HEAD/docs/quantum-resistance.md" },
      erg:{ v:"64 B class (Schnorr)", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/crypto.md" } } },
  { id:"txsize", label:"Typical transfer size",
    rows:{
      qtc:{ v:"≈ 7 KB raw · far less after native aggregation", n:"Big signatures; aggregation batches transfers into one envelope.", b:"claimed", s:"https://docs.quantus.com" },
      btc:{ v:"≈ 600 B average (trailing 6 months)", b:"measured", s:"https://github.com/alephium/www/blob/HEAD/src/content/news/transactions-per-second-tps-f13217a49e39/index.md" },
      eth:{ v:"≈ 110–115 B for a simple transfer", n:"Estimated from the RLP envelope layout; no network-wide average published. Two measured examples: 114–115 B.", b:"approx", s:"https://medium.com/@giathidaniel252/echoes-in-the-curve-598ae7dec713" },
      sol:{ v:"Simple transfer well under 200 B · protocol max 4,096 B (Transaction V1, Sept 15, 2026)", n:"Simple-transfer figure is an estimate (RedDuck Academy); the 4,096 B cap is measured from activation coverage.", b:"approx", s:"https://www.mexc.com/crypto-pulse/article/solana-activates-transaction-v1-159190" },
      erg:{ v:"No published typical size · protocol max 96 KiB per tx", n:"Checked ergodocs + node config Sept 29, 2026; no typical/average figure found.", b:"approx", s:"https://github.com/arkadianet/ergo/blob/HEAD/docs/configuration.md" } } },
  { id:"blocktime", label:"Block / slot time",
    rows:{
      qtc:{ v:"≈ 12 s", n:"~7,200 blocks/day; observed ~14 s on early mainnet.", b:"measured", s:"https://explorer.quantus.com" },
      btc:{ v:"10 min (target)", b:"measured", s:"https://en.wikipedia.org/wiki/Bitcoin_scalability" },
      eth:{ v:"12 s slots", b:"measured", s:"https://coin360.com/news/vitalik-buterin-ethereum-hegota-roadmap" },
      sol:{ v:"≈ 400 ms", b:"measured", s:"https://blockchainreporter.net/web3/solana-review-the-high-performance-blockchain-built-for-mass-adoption/" },
      erg:{ v:"≈ 2 min (average)", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/fud-faq.md" } } },
  { id:"tps", label:"Throughput (TPS)",
    rows:{
      qtc:{ v:"~430 design target (aggregated)", n:"Project-claimed design figure; mainnet load is far below it.", b:"claimed", s:"https://docs.quantus.com" },
      btc:{ v:"≈ 3–7 TPS base layer (typically 2–4 measured)", n:"Measured on-chain typically 2–4 TPS (Blockchair via Alephium research).", b:"measured", s:"https://en.wikipedia.org/wiki/Bitcoin_scalability" },
      eth:{ v:"≈ 12–30 TPS measured on L1", b:"measured", s:"https://mirror.xyz/0x7b4e288286887374A7E4E6F3d75D4617758c9bE4/1VS0yLDMCPDBJ_fKiAFkwEnZicutEFWah-ZexOI-HNU" },
      sol:{ v:"≈ 2–3k TPS typical · 65k sustained claimed · 100k+ peak claimed", n:"Typical figure measured; 65k/100k+ are ecosystem claims.", b:"measured", s:"https://blockchainreporter.net/web3/solana-review-the-high-performance-blockchain-built-for-mass-adoption/" },
      erg:{ v:"No TPS figure published in official docs", n:"Checked ergodocs + papers Sept 29, 2026; the \u2018weak blocks\u2019 scaling proposal is paper-only.", b:"unverified", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/faq.md" } } },
  { id:"mkcap", label:"Price & market cap (Sept 29, 2026)",
    rows:{
      qtc:{ v:"No public price — pre-listing", n:"NEAR Intents announced as first venue; no listing date as of Sept 29, 2026.", b:"measured", s:"https://docs.quantus.com" },
      btc:{ v:"≈ $84.5K · ≈ $1.67T mcap (~57% dominance)", b:"measured", s:"https://www.tradingview.com/news/DJN_DN20260929004943:0/" },
      eth:{ v:"≈ $2.7K · ≈ $328B mcap", b:"measured", s:"https://cryptoonic.com/market-cap-comparison-2026-bitcoin-vs-ethereum-vs-solana-7-powerful-insights/" },
      sol:{ v:"≈ $120 · ≈ $63–72B mcap (varies by source/day)", b:"measured", s:"https://www.americanbankingnews.com/2026/09/29/solana-24-hour-trading-volume-tops-3-41-billion-sol.html" },
      erg:{ v:"≈ $0.33 · ≈ $27.6M mcap (self-reported supply)", n:"Supply figure is self-reported; the source flags it unverified.", b:"measured", s:"https://www.marketbeat.com/cryptocurrencies/ergo/" } } },
  { id:"supply", label:"Supply cap & issuance",
    rows:{
      qtc:{ v:"21M QTC · 27% genesis vesting · 73% miner tail", n:"No halvings; reward = (21M − supply) / 50M per block.", b:"measured", s:"https://github.com/Quantus-Network/chain" },
      btc:{ v:"21M hard cap · ≈ 19.9M circulating · last coins ~2140", b:"measured", s:"https://cryptoonic.com/market-cap-comparison-2026-bitcoin-vs-ethereum-vs-solana-7-powerful-insights/" },
      eth:{ v:"No hard cap · ≈ 122M circulating", b:"measured", s:"https://cryptoonic.com/market-cap-comparison-2026-bitcoin-vs-ethereum-vs-solana-7-powerful-insights/" },
      sol:{ v:"No hard cap (inflationary) · ≈ 588M circulating · ~4.7% → 1.5% by ~2031", b:"measured", s:"https://cryptoonic.com/market-cap-comparison-2026-bitcoin-vs-ethereum-vs-solana-7-powerful-insights/" },
      erg:{ v:"97,739,924.5 ERG max · ≈ 83.45M circulating (self-reported)", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/faq.md" } } },
  { id:"launch", label:"Launch & fairness",
    rows:{
      qtc:{ v:"Mainnet Sept 9, 2026 · open mining, no team hash advantage", n:"27% genesis allocation to grants/treasury (vested); no dev tax on blocks.", b:"measured", s:"https://github.com/Quantus-Network/chain" },
      btc:{ v:"Jan 3, 2009 genesis · no premine, no ICO — mining only from block 1", b:"measured", s:"https://github.com/cypher256/bitcoinarchive/blob/HEAD/src/data/entries/en/design/2009-01-03-bitcoin-consensus-design.md" },
      eth:{ v:"July 30, 2015 · 2014 ICO sold ~60M ETH (~83% of initial 72M); 12M to contributors/EF", b:"measured", s:"https://coincodex.com/ico/ethereum/" },
      sol:{ v:"Mainnet beta Mar 2020 · all 500M initial SOL pre-allocated (team, foundation, private sales)", n:"Public CoinList auction was only 8M tokens.", b:"measured", s:"https://www.coinbase.com/zh-tw/institutional/research-insights/research/tokenomics-review/solana-sol-native-scalability" },
      erg:{ v:"July 1, 2019 · fair launch: no premine, no ICO · 4.43% to treasury from block rewards over 2.5 yrs", b:"measured", s:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/start-here/why-ergo.md" } } }
];

/* ---- TPS lab: per-chain block capacity (bytes per block) & block time (s). ---- */
var TPS_PARAMS = {
  qtc:{ mode:"bytes", capBytes: 430*7000*12, blockS:12,  note:"capacity implied by ~430 TPS design target at ~7 KB raw txs" },
  btc:{ mode:"bytes", capBytes: 4000000,      blockS:600, note:"~4M weight units per ~10 min" },
  eth:{ mode:"ref", refTps:20,   refLabel:"≈ 20 TPS typical", refNote:"12–30 TPS measured on L1; gas-metered, so byte math does not apply." },
  sol:{ mode:"ref", refTps:2500, refLabel:"≈ 2.5k TPS typical", refNote:"2–3k typical measured; 65k sustained is a project claim. Compute-unit metered." },
  erg:{ mode:"ref", refTps:null, refLabel:"no published figure", refNote:"No TPS figure in official docs; weak-blocks scaling is paper-only." }
};
/* Simple ceiling model: tps = (capBytes / txSize) / blockS. */
function tpsCeiling(capBytes, blockS, txSize){
  if (!capBytes || !blockS || !txSize || txSize <= 0) return null;
  return (capBytes / txSize) / blockS;
}
function fmtTps(t){
  if (t === null || t === undefined || !isFinite(t)) return "n/a";
  if (t >= 1000) return (t/1000).toFixed(1).replace(/\.0$/,"") + "k";
  if (t >= 100) return Math.round(t).toString();
  if (t >= 10) return t.toFixed(1);
  return t.toFixed(2);
}
function fmtBytes(b){
  if (b >= 1048576) return (b/1048576).toFixed(b % 1048576 ? 1 : 0) + " MB";
  if (b >= 1024) return (b/1024).toFixed(b % 1024 ? 1 : 0) + " KB";
  return b + " B";
}

/* ---- Signature showdown bars ---- */
var SIGS = [
  { name:"ECDSA (secp256k1)", sub:"Bitcoin · Ethereum", bytes:64,    color:"#f5b942" },
  { name:"Ed25519",           sub:"Solana",             bytes:64,    color:"#22d3ee" },
  { name:"Schnorr",           sub:"Ergo (Sigma protocols)", bytes:64,color:"#f472b6" },
  { name:"ML-DSA-65",         sub:"Quantus option · FIPS 204", bytes:3309, color:"#34ff88" },
  { name:"ML-DSA-87",         sub:"Quantus mainnet · FIPS 204", bytes:4627, color:"#c084fc" }
];

/* ---- Fairness cards ---- */
var FAIRNESS = [
  { id:"qtc", rows:[["Premine / genesis","27% (5.67M QTC), vested 1–4 yrs"],["Dev tax on blocks","0% — miners keep 100%"],["Public sale","Private rounds only (no ICO)"],["Team mining edge","None by design"]] },
  { id:"btc", rows:[["Premine / genesis","0 — no premine, no ICO"],["Dev tax on blocks","0%"],["Public sale","None — mining from block 1"],["Team mining edge","None"]] },
  { id:"eth", rows:[["Premine / genesis","~72M ETH at genesis (60M ICO + 12M contributors/EF)"],["Dev tax on blocks","0% (no block-subsidy tax)"],["Public sale","2014 ICO raised ~$18M"],["Team mining edge","N/A (PoS since 2022)"]] },
  { id:"sol", rows:[["Premine / genesis","500M SOL pre-allocated before public launch"],["Dev tax on blocks","0%"],["Public sale","Seed/private rounds ($25M+); 8M CoinList auction"],["Team mining edge","N/A (PoS)"]] },
  { id:"erg", rows:[["Premine / genesis","0 — no premine, no ICO"],["Dev tax on blocks","0% — treasury took 4.43% of supply from block rewards over 2.5 yrs"],["Public sale","None (EFYT Waves tokens swapped post-mainnet)"],["Team mining edge","None"]] }
];

/* ---- Verdicts ---- */
var VERDICTS = [
  { id:"qtc", pro:"Only chain here with post-quantum signatures live from genesis; fair open mining with zero block tax.", con:"Brand-new mainnet: thin liquidity, unproven aggregation at scale, and the ~430 TPS figure is a design claim, not a measurement." },
  { id:"btc", pro:"The hardest money in crypto: 21M cap, no premine, 17 years of uptime, ~$1.67T of Lindy effect.", con:"Quantum-exposed signatures, ~7 TPS on the base layer, and every upgrade is a multi-year political campaign." },
  { id:"eth", pro:"The deepest app ecosystem on earth — if it can be built on-chain, it was built here first.", con:"No supply cap, a heavy ICO-premine history, quantum-vulnerable signatures, and L1 fees that still spike." },
  { id:"sol", pro:"The speed king: thousands of TPS at sub-cent fees with a relentless shipping culture.", con:"Fully pre-allocated launch, inflationary supply, a history of outages, and PQ signatures still experimental." },
  { id:"erg", pro:"The thinking miner's PoW: fair launch, no premine, research-grade design (Sigma protocols, Autolykos).", con:"Tiny liquidity (~$28M mcap), no published TPS story, and quantum-vulnerable like the rest." }
];

/* ---- Sources ---- */
var SOURCES = [
  { t:"Quantus chain repo (Quantus-Network/chain) — emission, vesting, wormhole fees", u:"https://github.com/Quantus-Network/chain", d:"Sept 29, 2026" },
  { t:"Quantus docs — aggregation, throughput design, mining guides", u:"https://docs.quantus.com", d:"Sept 29, 2026" },
  { t:"Quantus explorer — block times, live chain data", u:"https://explorer.quantus.com", d:"Sept 29, 2026" },
  { t:"NIST FIPS 204 — ML-DSA signature parameter sizes", u:"https://csrc.nist.gov/pubs/fips/204/final", d:"Sept 29, 2026" },
  { t:"BitcoinArchive — Bitcoin consensus design (SHA-256d, 2016-block retarget)", u:"https://github.com/cypher256/bitcoinarchive/blob/HEAD/src/data/entries/en/design/2009-01-03-bitcoin-consensus-design.md", d:"Sept 29, 2026" },
  { t:"Wikipedia — Bitcoin scalability (block time, TPS range)", u:"https://en.wikipedia.org/wiki/Bitcoin_scalability", d:"Sept 29, 2026" },
  { t:"Tekingame — quantum threat matrix (BTC/ETH signature exposure, BIP-360 draft)", u:"https://tekingame.com/blog/quantum-threat-bitcoin-ethereum-en", d:"Sept 29, 2026" },
  { t:"Encryptorium book-of-pqc-code — L1 signature migration (signature sizes)", u:"https://github.com/encryptorium/book-of-pqc-code/blob/HEAD/exercises/ch37-l1-signature-migration/README.md", d:"Sept 29, 2026" },
  { t:"w3pk POST_QUANTUM.md — Ethereum PQ roadmap status", u:"https://github.com/w3hc/w3pk/blob/HEAD/docs/POST_QUANTUM.md", d:"Sept 29, 2026" },
  { t:"dvdmtw98 notes — Ethereum transaction structure (v, r, s fields)", u:"https://github.com/dvdmtw98/notes/blob/HEAD/notes-vault/blockchain/ethereum/ethereum-tranasactions.md", d:"Sept 29, 2026" },
  { t:"Medium (Daniel) — measured 114–115 B simple Ethereum transfers", u:"https://medium.com/@giathidaniel252/echoes-in-the-curve-598ae7dec713", d:"Sept 29, 2026" },
  { t:"Coin360 — Vitalik roadmap table (12 s Ethereum slots)", u:"https://coin360.com/news/vitalik-buterin-ethereum-hegota-roadmap", d:"Sept 29, 2026" },
  { t:"CoinCodex — Ethereum ICO details (60M ETH, $18M)", u:"https://coincodex.com/ico/ethereum/", d:"Sept 29, 2026" },
  { t:"Mirror (cookies-research) — measured L1 TPS for ETH/SOL", u:"https://mirror.xyz/0x7b4e288286887374A7E4E6F3d75D4617758c9bE4/1VS0yLDMCPDBJ_fKiAFkwEnZicutEFWah-ZexOI-HNU", d:"Sept 29, 2026" },
  { t:"BlockchainReporter — Solana review (PoH+PoS, 400 ms, TPS claims, supply)", u:"https://blockchainreporter.net/web3/solana-review-the-high-performance-blockchain-built-for-mass-adoption/", d:"Sept 29, 2026" },
  { t:"isslashy protocol-01 — Solana quantum-resistance doc (Ed25519, Winternitz, Dilithium demo)", u:"https://github.com/isslashy/protocol-01/blob/HEAD/docs/quantum-resistance.md", d:"Sept 29, 2026" },
  { t:"MEXC — Solana Transaction V1 activation (4,096 B, Sept 15, 2026)", u:"https://www.mexc.com/crypto-pulse/article/solana-activates-transaction-v1-159190", d:"Sept 29, 2026" },
  { t:"RedDuck Academy — Solana versioned transactions (simple-transfer size estimate)", u:"https://github.com/redduckteam/redduck-academy/blob/HEAD/content/development-on-solana/working-with-other-programs/versioned-transactions-and-address-lookup-tables.md", d:"Sept 29, 2026" },
  { t:"Coinbase Institutional — Solana tokenomics review (500M pre-allocation, inflation)", u:"https://www.coinbase.com/zh-tw/institutional/research-insights/research/tokenomics-review/solana-sol-native-scalability", d:"Sept 29, 2026" },
  { t:"ErgoDocs FAQ — max supply 97,739,924.5 ERG", u:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/faq.md", d:"Sept 29, 2026" },
  { t:"ErgoDocs why-ergo — fair launch, treasury from block rewards", u:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/start-here/why-ergo.md", d:"Sept 29, 2026" },
  { t:"ErgoDocs crypto.md — Schnorr/Sigma-protocol signatures", u:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/crypto.md", d:"Sept 29, 2026" },
  { t:"ErgoDocs fud-faq — 2-minute average block time", u:"https://github.com/ergoplatform/ergodocs/blob/HEAD/docs/fud-faq.md", d:"Sept 29, 2026" },
  { t:"ErgoPow.pdf — Autolykos v2 memory-hard PoW", u:"https://storage.googleapis.com/ergo-cms-media/docs/ErgoPow.pdf", d:"Sept 29, 2026" },
  { t:"Arkadianet ergo node config — max tx size 96 KiB", u:"https://github.com/arkadianet/ergo/blob/HEAD/docs/configuration.md", d:"Sept 29, 2026" },
  { t:"Cryptoonic — market-cap comparison Sept 2026 (BTC/ETH/SOL supply + prices)", u:"https://cryptoonic.com/market-cap-comparison-2026-bitcoin-vs-ethereum-vs-solana-7-powerful-insights/", d:"Sept 29, 2026" },
  { t:"TradingView/DJN — BTC price Sept 29, 2026", u:"https://www.tradingview.com/news/DJN_DN20260929004943:0/", d:"Sept 29, 2026" },
  { t:"AmericanBankingNews — SOL price/mcap Sept 29, 2026", u:"https://www.americanbankingnews.com/2026/09/29/solana-24-hour-trading-volume-tops-3-41-billion-sol.html", d:"Sept 29, 2026" },
  { t:"MarketBeat — ERG price/mcap Sept 29, 2026", u:"https://www.marketbeat.com/cryptocurrencies/ergo/", d:"Sept 29, 2026" },
  { t:"Alephium research — BTC avg tx size ~600 B, measured TPS", u:"https://github.com/alephium/www/blob/HEAD/src/content/news/transactions-per-second-tps-f13217a49e39/index.md", d:"Sept 29, 2026" },
  { t:"Namefi resources — blockchain cryptographic primitives (consensus/sig overview)", u:"https://github.com/d3servelabs/namefi-resources/blob/HEAD/content/blog/en/blockchain-cryptographic-primitives.md", d:"Sept 29, 2026" }
];

var chainById = {};
CHAINS.forEach(function(c){ chainById[c.id] = c; });
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

/* ---------------- rendering (browser only) ---------------- */
var highlight = "qtc";

function renderPicker(){
  var el = document.getElementById("chain-picker");
  el.innerHTML = CHAINS.map(function(c){
    return '<button class="chain-chip' + (c.id===highlight?" active":"") + '" data-chain="' + c.id + '" style="--c:' + c.color + '" aria-pressed="' + (c.id===highlight) + '">' +
      '<span class="dot"></span>' + esc(c.name) + ' <span style="opacity:.6;font-weight:600">' + esc(c.sym) + '</span></button>';
  }).join("");
  el.querySelectorAll(".chain-chip").forEach(function(b){
    b.addEventListener("click", function(){
      highlight = b.getAttribute("data-chain");
      renderPicker(); renderMatrix();
    });
  });
}

function badge(b){
  return '<span class="badge b-' + b + '">' + (BADGE_LABEL[b] || b) + '</span>';
}

function renderMatrix(){
  var w = document.getElementById("matrix-wrap");
  var head = "<thead><tr><th>Metric</th>" + CHAINS.map(function(c){
    return '<th data-col="' + c.id + '" class="' + (c.id===highlight?"hl":"") + '" style="--c:' + c.color + '"><span class="cname"><span class="dot"></span>' + esc(c.name) + '</span><br><span class="csym">' + esc(c.sym) + ' · ' + esc(c.tag) + '</span></th>';
  }).join("") + "</tr></thead>";
  var body = "<tbody>" + METRICS.map(function(m){
    var tds = CHAINS.map(function(c){
      var cell = m.rows[c.id] || { v:"—", b:"unverified", s:"" };
      var v = esc(cell.v);
      if (cell.s) v += ' <a class="src-link" href="' + esc(cell.s) + '" target="_blank" rel="noopener">source</a>';
      var n = cell.n ? '<span class="cell-n">' + esc(cell.n) + '</span>' : "";
      return '<td data-col="' + c.id + '" class="' + (c.id===highlight?"hl":"") + '" style="--c:' + c.color + '"><span class="cell-v">' + v + badge(cell.b) + '</span>' + n + '</td>';
    }).join("");
    return "<tr><th scope='row'>" + esc(m.label) + "</th>" + tds + "</tr>";
  }).join("") + "</tbody>";
  w.innerHTML = '<table class="matrix">' + head + body + "</table>";
}

function renderTps(txSize){
  var el = document.getElementById("tps-bars");
  var rows = CHAINS.map(function(c){
    var p = TPS_PARAMS[c.id];
    if (p.mode === "bytes") return { c:c, t:tpsCeiling(p.capBytes, p.blockS, txSize), label:null, refNote:null };
    return { c:c, t:p.refTps, label:p.refLabel, refNote:p.refNote };
  });
  var max = Math.max.apply(null, rows.map(function(r){ return r.t || 0; }).concat([1]));
  el.innerHTML = rows.map(function(r){
    var pct = r.t ? Math.max(2, (r.t / max) * 100) : 0;
    var val = r.t === null ? "n/a" : fmtTps(r.t) + (r.label ? "" : " TPS");
    var sub = r.label ? '<div style="font-size:11px;color:#8f7fb8;margin-top:2px">' + esc(r.refNote) + '</div>' : "";
    var lab = r.label ? esc(r.label) : esc(val);
    return '<div class="tps-bar-row"><span class="nm" style="--c:' + r.c.color + '"><span class="dot"></span>' + esc(r.c.name) + '</span>' +
      '<div class="tps-track"><div class="tps-fill" style="--c:' + r.c.color + ';width:' + pct.toFixed(1) + '%"></div></div>' +
      '<span class="tps-val">' + lab + '</span></div>' + sub;
  }).join("");
}

function renderSigs(){
  var el = document.getElementById("sig-bars");
  var max = Math.max.apply(null, SIGS.map(function(s){ return s.bytes; }));
  el.innerHTML = SIGS.map(function(s){
    var pct = Math.max(1.5, (s.bytes / max) * 100);
    return '<div class="sig-bar-row"><span class="nm">' + esc(s.name) + '<small>' + esc(s.sub) + '</small></span>' +
      '<div class="sig-track"><div class="sig-fill" style="width:' + pct.toFixed(1) + '%;background:linear-gradient(90deg,' + s.color + '55,' + s.color + ')"></div></div>' +
      '<span class="sig-val">' + fmtBytes(s.bytes) + '</span></div>';
  }).join("");
}

function renderFairness(){
  var el = document.getElementById("fair-grid");
  el.innerHTML = FAIRNESS.map(function(f){
    var c = chainById[f.id];
    var rows = f.rows.map(function(r){
      return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>";
    }).join("");
    return '<div class="fair-card" style="--c:' + c.color + '"><div class="fh"><span class="dot"></span>' + esc(c.name) + '</div><dl>' + rows + "</dl></div>";
  }).join("");
}

function renderVerdicts(){
  var el = document.getElementById("verdict-grid");
  el.innerHTML = VERDICTS.map(function(vd){
    var c = chainById[vd.id];
    return '<div class="verdict" style="--c:' + c.color + '"><div class="vh"><span class="dot"></span>' + esc(c.name) + ' <span style="opacity:.55;font-weight:600">' + esc(c.sym) + '</span></div>' +
      '<div class="vtag">' + esc(c.tag) + '</div>' +
      '<div class="pl pro">Genuinely best at</div><p>' + esc(vd.pro) + '</p>' +
      '<div class="pl con">The catch</div><p>' + esc(vd.con) + '</p></div>';
  }).join("");
}

function renderSources(){
  var el = document.getElementById("source-list");
  el.innerHTML = SOURCES.map(function(s){
    return '<li><a href="' + esc(s.u) + '" target="_blank" rel="noopener">' + esc(s.t) + '</a> <span class="sdate">— verified ' + esc(s.d) + '</span></li>';
  }).join("");
}

/* Signature-rain canvas (decorative, respects reduced motion). */
function initRain(){
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var cv = document.getElementById("sigrain"), ctx = cv.getContext("2d"), W, H, parts = [];
  function size(){ W = cv.width = innerWidth; H = cv.height = innerHeight; }
  size(); addEventListener("resize", size);
  var glyphs = "01⌁∑λψΩΔ";
  for (var i = 0; i < 60; i++) parts.push({ x: Math.random(), y: Math.random(), s: 0.0004 + Math.random()*0.0012, g: glyphs[Math.floor(Math.random()*glyphs.length)], o: 0.05 + Math.random()*0.12, fs: 10 + Math.random()*16 });
  (function tick(){
    ctx.clearRect(0,0,W,H);
    for (var k = 0; k < parts.length; k++){
      var p = parts[k];
      p.y += p.s; if (p.y > 1.02){ p.y = -0.02; p.x = Math.random(); }
      ctx.globalAlpha = p.o; ctx.fillStyle = "#c084fc";
      ctx.font = p.fs + "px monospace";
      ctx.fillText(p.g, p.x*W, p.y*H);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  })();
}

function init(){
  renderPicker(); renderMatrix(); renderSigs(); renderFairness(); renderVerdicts(); renderSources();
  var slider = document.getElementById("txsize"), out = document.getElementById("txsize-out");
  function upd(){
    var v = parseInt(slider.value, 10);
    out.textContent = fmtBytes(v);
    renderTps(v);
  }
  slider.addEventListener("input", upd); upd();
  document.querySelectorAll(".tps-presets button").forEach(function(b){
    b.addEventListener("click", function(){ slider.value = b.getAttribute("data-size"); upd(); });
  });
  document.getElementById("fact-metrics").textContent = METRICS.length;
  var cited = 0;
  METRICS.forEach(function(m){ CHAINS.forEach(function(c){ var cell = m.rows[c.id]; if (cell && cell.b !== "unverified" && cell.s) cited++; }); });
  document.getElementById("fact-cited").textContent = cited;
  initRain();
  /* copy-address helper */
  document.querySelectorAll("[data-copy]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var v = btn.getAttribute("data-copy");
      function done(){ var t = btn.textContent; btn.textContent = "copied ✓"; setTimeout(function(){ btn.textContent = t; }, 1500); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done);
      else done();
    });
  });
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);

/* ---- node-testable exports ---- */
if (typeof module !== "undefined" && module.exports){
  module.exports = { CHAINS: CHAINS, METRICS: METRICS, TPS_PARAMS: TPS_PARAMS, SIGS: SIGS,
    FAIRNESS: FAIRNESS, VERDICTS: VERDICTS, SOURCES: SOURCES,
    tpsCeiling: tpsCeiling, fmtTps: fmtTps, fmtBytes: fmtBytes, BADGE_LABEL: BADGE_LABEL };
}
})();
