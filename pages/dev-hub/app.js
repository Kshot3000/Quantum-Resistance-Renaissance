// QTC Developer Hub logic — pages/dev-hub/app.js
// Run in Node: node tests/devhub.test.js  |  In browser: DEVHUB.init() on DOMContentLoaded
(function(){
"use strict";

var UPSTREAM = "https://github.com/Quantus-Network/chain/blob/main/";

// --- Verified chain constants (chain_spec.rs + runtime/src/lib.rs, read 2026-09-30) ---
var CHAIN = {
  chainName: "Quantus",
  chainId: "mainnet",
  protocolId: "quantus",
  specName: "quantus-runtime",
  specVersion: 153,
  implVersion: 1,
  authoringVersion: 1,
  transactionVersion: 6,
  ss58Prefix: 189,
  tokenSymbol: "QTC",
  tokenDecimals: 12,
  unit: "1000000000000",          // plancks per QTC (UNIT = 10^12)
  existentialDeposit: "1000000000", // MILLI_UNIT plancks = 0.001 QTC
  blockTimeMs: 12000,
  targetBlockTimeSec: 12,
  blocksPerDay: 7200,
  lengthFeePlancksPerByte: "100000", // Fee & Throughput Lab: 100,000 plancks/byte (post 10x cut)
  signatureSchemes: "ML-DSA-65 / ML-DSA-87",
  keyPrimitive: "dilithium-crypto (primitives/dilithium-crypto)",
  consensus: "QPoW — proof of work (pallet_qpow)",
  sources: {
    chainSpec: UPSTREAM + "node/src/chain_spec.rs",
    runtime: UPSTREAM + "runtime/src/lib.rs"
  }
};

// --- Runtime pallet index map (runtime/src/lib.rs, #[frame_support::runtime]) ---
// "removed" entries are genuinely vacant indices — the runtime keeps them empty.
var PALLETS = [
  { i: 0,  name: "System", status: "active", calls: ["remark", "set_code (root)"], note: "Core block/execution state, account nonces." },
  { i: 1,  name: "Timestamp", status: "active", calls: ["set"], note: "Block timestamp — set by the block author (inherent)." },
  { i: 2,  name: "Balances", status: "active", calls: ["transfer_allow_death", "transfer_keep_alive", "force_transfer (root)"], note: "QTC balances. Prefer transfer_keep_alive — it refuses transfers that would kill your account below the 0.001 QTC ED." },
  { i: 3,  name: "TransactionPayment", status: "active", calls: ["(no user calls)"], note: "Fee engine: length fee 100,000 plancks/byte + weight fee. See the Fee & Throughput Lab." },
  { i: 4,  name: "— vacant —", status: "removed", calls: [], note: "Index 4 was pallet_sudo (removed). Kept vacant so downstream indices stay stable." },
  { i: 5,  name: "QPoW", status: "active", calls: ["(no user calls — mining API only)"], note: "Quantus proof-of-work consensus. Difficulty/nonce math exposed for miners; blocks commit via the mining API." },
  { i: 6,  name: "MiningRewards", status: "active", calls: ["collect_transaction_fees (internal)"], note: "Emission engine: R = (21,000,000 − S) / 50,000,000 per block. See the Emission Lab." },
  { i: 7,  name: "Preimage", status: "active", calls: ["note_preimage", "unnote_preimage", "request_preimage"], note: "On-chain preimage store — backs the Scheduler and governance proposals." },
  { i: 8,  name: "Scheduler", status: "restricted", calls: [], note: "Used internally for reversible transfers and governance. Its extrinsics are disabled for users — you cannot schedule arbitrary calls." },
  { i: 9,  name: "Utility", status: "active", calls: ["batch", "batch_all", "force_batch (root)", "as_derivative"], note: "batch_all executes every call or fails the whole lot — the atomic multi-call path." },
  { i: 10, name: "— vacant —", status: "removed", calls: [], note: "Index 10 was the community Referenda instance (removed with the public/token-weighted governance lane)." },
  { i: 11, name: "ReversibleTransfers", status: "active", calls: ["schedule_transfer", "schedule_transfer_with_delay", "execute_transfer", "cancel", "recover_funds", "set_high_security (root)"], note: "SafeSend: reversible QTC payments with an expiry delay. Sender can recover_funds if the receiver never claims. See the SafeSend Lab." },
  { i: 12, name: "— vacant —", status: "removed", calls: [], note: "Index 12 was ConvictionVoting (removed with the community lane)." },
  { i: 13, name: "TechCollective", status: "active", calls: ["propose", "vote", "execute"], note: "Ranked collective — the technical committee lane." },
  { i: 14, name: "TechReferenda", status: "active", calls: ["submit", "place_decision_deposit", "vote", "cancel"], note: "Governance referenda (Instance1) for the tech tracks — FastUpgrade origin and friends." },
  { i: 15, name: "TreasuryPallet", status: "active", calls: ["propose_spend", "approve_proposal (origin)", "reject_proposal (origin)"], note: "On-chain treasury spends." },
  { i: 16, name: "— vacant —", status: "removed", calls: [], note: "Index 16 was pallet_recovery (removed)." },
  { i: 17, name: "— vacant —", status: "removed", calls: [], note: "Index 17 was pallet_assets (removed)." },
  { i: 18, name: "— vacant —", status: "removed", calls: [], note: "Index 18 was pallet_assets_holder (removed with assets)." },
  { i: 19, name: "Multisig", status: "active", calls: ["as_multi_threshold_1", "as_multi", "approve_as_multi", "cancel_as_multi"], note: "k-of-n multisig. The address-toolkit + SafeSend labs cover account-side flows." },
  { i: 20, name: "Wormhole", status: "active", calls: ["from_public_batch", "verify_private_batch", "verify_public_batch", "record_transfer"], note: "Bridge-exit verification path — used by the 4 bps wormhole exit flow in the Fee Lab." },
  { i: 21, name: "ZkTree", status: "active", calls: ["(see pallet_zk_tree)"], note: "ZK-tree pallet (zk-friendly state structures)." },
  { i: 22, name: "Vesting", status: "active", calls: ["vested_transfer", "vest", "vest_other"], note: "Token vesting schedules — backs the genesis vesting tranches in the Tokenomics explorer." },
  { i: 23, name: "Origins", status: "active", calls: ["(custom origins only)"], note: "Custom governance origins (pallet_custom_origins) — e.g. FastUpgrade. No calls, no storage; dispatch origins for the tech-referenda tracks." }
];

var REPOS = [
  { name: "chain", desc: "The node + runtime. Source of every constant on this page: chain_spec.rs, runtime/src/lib.rs, pallets/.", pushed: "2026-09-21" },
  { name: "quantus-cli", desc: "CLI client — generate ML-DSA accounts, manage keys, submit transactions.", pushed: "2026-09-30" },
  { name: "quantus-miner", desc: "The reference QPoW miner.", pushed: "2026-09-18" },
  { name: "quantus-apps", desc: "The official wallet — merged two-way NEAR Intents swaps (PR #675, Sept 28).", pushed: "2026-09-28" },
  { name: "quantus-api-client", desc: "Library for connecting to the Substrate API over WebSockets.", pushed: "2025-08-04" },
  { name: "explorer", desc: "Custom blockchain explorer built on Subsquid.", pushed: "2026-09-29" },
  { name: "docs", desc: "Architecture docs, mining guides, and the repo map.", pushed: "2026-09-18" },
  { name: "qp-human-checkphrase", desc: "Human-readable address encoding — the checkphrase SafeSend verifies.", pushed: "2026-07-16" },
  { name: "qpow-benchmark", desc: "Benchmarks for the QPoW proof-of-work algorithm.", pushed: "2025-04-26" },
  { name: "improvement-proposals", desc: "Chain improvement proposals — where protocol changes are proposed.", pushed: "2026-08-10" }
];

// --- Pure logic --------------------------------------------------------------

var PLANCKS_PER_QTC = BigInt("1000000000000");

function qtcToPlancks(qtcStr){
  // exact decimal -> BigInt plancks; rejects >12 decimals, negatives, junk
  var s = String(qtcStr).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(s)) return null;
  var parts = s.split(".");
  var whole = BigInt(parts[0] === "" ? "0" : parts[0]);
  var frac = (parts[1] || "").padEnd(12, "0");
  return whole * PLANCKS_PER_QTC + BigInt(frac);
}

function plancksToQtc(pStr){
  var s = String(pStr).trim();
  if (!/^\d+$/.test(s)) return null;
  var p = BigInt(s);
  var whole = p / PLANCKS_PER_QTC;
  var frac = (p % PLANCKS_PER_QTC).toString().padStart(12, "0").replace(/0+$/, "");
  return whole.toString() + (frac ? "." + frac : "");
}

function groupDigits(s){ return s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function belowED(plancks){
  return plancks !== null && BigInt(plancks) < BigInt(CHAIN.existentialDeposit);
}

function lookupPallet(q){
  if (q === null || q === undefined) return null;
  if (typeof q === "number" || /^\d+$/.test(String(q).trim())){
    var i = parseInt(q, 10);
    for (var k = 0; k < PALLETS.length; k++) if (PALLETS[k].i === i) return PALLETS[k];
    return null;
  }
  var n = String(q).trim().toLowerCase();
  for (var j = 0; j < PALLETS.length; j++)
    if (PALLETS[j].name.toLowerCase().indexOf(n) === 0) return PALLETS[j];
  return null;
}

var RPC_PRESETS = {
  "chain_getBlockHash": { hint: "e.g. [137536] — leave [] for the latest block hash", params: [] },
  "state_getStorage": { hint: "storage key as 0x… — leave [] for the template", params: [] }
};

function buildJsonRpc(method, paramsJson){
  var params;
  try {
    params = JSON.parse(String(paramsJson).trim() === "" ? "[]" : paramsJson);
    if (!Array.isArray(params)) return { ok: false, error: "Params must be a JSON array, e.g. [137536]" };
  } catch (e){ return { ok: false, error: "Params are not valid JSON: " + e.message }; }
  return {
    ok: true,
    json: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }, null, 2),
    curl: "curl -s -H 'Content-Type: application/json' -d '" +
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) +
      "' http://localhost:9944"
  };
}

var RECIPES = {
  "r-js": {
    note: "Read-only first: connect, then read chain state. Use your own node's WebSocket endpoint.",
    code:
"// npm i @polkadot/api\n" +
"import { ApiPromise, WsProvider } from '@polkadot/api';\n" +
"\n" +
"// Point at YOUR node — no public RPC is published in the docs (Sept 2026)\n" +
"const ws = new WsProvider('ws://127.0.0.1:9945');\n" +
"const api = await ApiPromise.create({ provider: ws });\n" +
"\n" +
"const chain = await api.rpc.system.chain();        // 'Quantus'\n" +
"const [header, version] = await Promise.all([\n" +
"  api.rpc.chain.getHeader(),\n" +
"  api.rpc.system.version()\n" +
"]);\n" +
"console.log(chain.toString(), '#'+header.number.toNumber());\n" +
"\n" +
"// Balance of any SS58-189 address (read-only, no keys needed)\n" +
"const { data } = await api.query.system.account('qzYOUR_ADDRESS_HERE');\n" +
"const free = BigInt(data.free.toString());          // plancks (12 decimals)\n" +
"console.log('free:', (free / 10n**12n).toString() + ' QTC');\n" +
"\n" +
"await api.disconnect();"
  },
  "r-tx": {
    note: "Keys are ML-DSA — create them in the official wallet or quantus-cli, never in a polkadot-js sr25519 keyring. transferKeepAlive guards the 0.001 QTC ED.",
    code:
"// Build the extrinsic with polkadot-js; SIGN in the official wallet or quantus-cli\n" +
"import { ApiPromise, WsProvider } from '@polkadot/api';\n" +
"\n" +
"const api = await ApiPromise.create({\n" +
"  provider: new WsProvider('ws://127.0.0.1:9945')\n" +
"});\n" +
"\n" +
"const dest = 'qzRECEIVER_ADDRESS_HERE';\n" +
"const amountPlancks = 1_000_000_000_000n; // 1 QTC — always count in plancks (12 dp)\n" +
"\n" +
"// transferKeepAlive REFUSES transfers that would reap your account (< 0.001 QTC left)\n" +
"const tx = api.tx.balances.transferKeepAlive(dest, amountPlancks.toString());\n" +
"\n" +
"// fee preview (length fee ~100,000 plancks/byte — see the Fee Lab)\n" +
"const { partialFee } = await tx.paymentInfo('qzYOUR_ADDRESS_HERE');\n" +
"console.log('estimated fee:', partialFee.toHuman());\n" +
"\n" +
"// …then sign & submit via the official wallet / quantus-cli\n" +
"// const hash = await tx.signAndSend(signer);\n" +
"\n" +
"await api.disconnect();"
  },
  "r-batch": {
    note: "batchAll is all-or-nothing: if one call fails, every call in the batch is rolled back.",
    code:
"// Utility pallet (index 9): atomic multi-call\n" +
"const dest1 = 'qzALICE_HERE';\n" +
"const dest2 = 'qzBOB_HERE';\n" +
"\n" +
"const calls = [\n" +
"  api.tx.balances.transferKeepAlive(dest1, (2n * 10n**12n).toString()), // 2 QTC\n" +
"  api.tx.balances.transferKeepAlive(dest2, (3n * 10n**12n).toString()), // 3 QTC\n" +
"];\n" +
"\n" +
"// batchAll: every call succeeds or the whole batch fails\n" +
"const batch = api.tx.utility.batchAll(calls);\n" +
"\n" +
"// NOTE: reversible-transfer pallets hold funds on a delay — batching a\n" +
"// schedule_transfer with other calls only ATOMIZES the scheduling,\n" +
"// the transfer itself still settles after its delay window."
  },
  "r-gql": {
    note: "GraphQL works from servers/CLI. Browser calls only succeed from allowlisted official domains — community pages use the same-origin snapshot instead.",
    code:
"# Public indexer: https://sqm.quantus.com/v1/graphql\n" +
"# (server-side or curl — NOT from arbitrary browser origins)\n" +
"\n" +
"curl -s -H 'Content-Type: application/json' \\\n" +
"  -d '{\"query\": \"{ status { block_height total_accounts total_immediate_transfers } }\"}' \\\n" +
"  https://sqm.quantus.com/v1/graphql\n" +
"\n" +
"# Recent blocks with rewards (plancks) and timestamps:\n" +
"# { blocks(limit: 10, orderBy: { height: desc }) {\n" +
"#     height hash timestamp reward\n" +
"# } }"
  },
  "r-safesend": {
    note: "Reversible transfers: the sender can recover_funds if the receiver never claims. The SafeSend Lab walks the full flow.",
    code:
"// ReversibleTransfers pallet (index 11) — SafeSend flow\n" +
"const dest = 'qzRECEIVER_HERE';\n" +
"const amount = (5n * 10n**12n).toString();   // 5 QTC\n" +
"const delayBlocks = 7200;                    // ~24h at 12s blocks\n" +
"\n" +
"// 1. sender locks funds, receiver has `delayBlocks` to claim\n" +
"const schedule = api.tx.reversibleTransfers\n" +
"  .scheduleTransfer(dest, amount, delayBlocks);\n" +
"\n" +
"// 2. receiver claims within the window\n" +
"// const claim = api.tx.reversibleTransfers.executeTransfer(txHash);\n" +
"\n" +
"// 3. …or the sender takes it back after expiry\n" +
"// const recover = api.tx.reversibleTransfers.recover_funds(txHash);\n" +
"\n" +
"// 4. receiver can also refuse → funds return to sender\n" +
"// const cancel = api.tx.reversibleTransfers.cancel(txHash);"
  }
};

var DONATE_ADDR = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";

// --- Browser DOM -------------------------------------------------------------
function $(id){ return document.getElementById(id); }

function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

var CONST_ROWS = [
  ["Chain name", "Quantus", "chain_spec.rs · with_name(\"Quantus\")"],
  ["Chain ID", "mainnet", "chain_spec.rs · with_id(\"mainnet\")"],
  ["Protocol ID", "quantus", "chain_spec.rs · with_protocol_id(\"quantus\")"],
  ["Runtime spec name", "quantus-runtime", "runtime/src/lib.rs"],
  ["Spec version", "153", "runtime/src/lib.rs"],
  ["Transaction version", "6", "runtime/src/lib.rs"],
  ["Token", "QTC · 12 decimals", "chain_spec.rs · tokenSymbol/tokenDecimals"],
  ["SS58 prefix", "189 → addresses start qz…", "chain_spec.rs"],
  ["Block time", "12 seconds", "runtime/src/lib.rs · TARGET_BLOCK_TIME_MS = 12_000"],
  ["Blocks / day", "7,200", "derived from 12s blocks"],
  ["Planck", "10⁻¹² QTC", "runtime/src/lib.rs · UNIT = 10^12"],
  ["Existential deposit", "0.001 QTC", "runtime/src/lib.rs · EXISTENTIAL_DEPOSIT = MILLI_UNIT"],
  ["Length fee", "100,000 plancks / byte", "10x fee cut, spec 153 — see Fee Lab"],
  ["Signatures", "ML-DSA-65 / ML-DSA-87", "primitives/dilithium-crypto · from genesis"],
  ["Consensus", "QPoW (proof of work)", "pallet_qpow · index 5"]
];

function renderConstants(){
  var g = $("constGrid");
  g.innerHTML = CONST_ROWS.map(function(r){
    return '<div class="const-card"><div class="const-name">' + esc(r[0]) +
      '<button class="mini-copy" data-copy="' + esc(r[1]) + '" aria-label="Copy ' + esc(r[0]) + '">⧉</button></div>' +
      '<div class="const-val">' + esc(r[1]) + '</div>' +
      '<div class="const-src">' + esc(r[2]) + '</div></div>';
  }).join("");
}

function statusBadge(s){
  if (s === "active") return '<span class="badge ok">active</span>';
  if (s === "restricted") return '<span class="badge warn">restricted</span>';
  return '<span class="badge off">vacant</span>';
}

function renderPallets(filter){
  var tb = $("palletRows");
  var q = (filter || "").trim().toLowerCase();
  var rows = PALLETS.filter(function(p){
    return !q || p.name.toLowerCase().indexOf(q) >= 0 || String(p.i) === q || p.note.toLowerCase().indexOf(q) >= 0;
  });
  tb.innerHTML = rows.map(function(p){
    return '<tr data-i="' + p.i + '" tabindex="0"><td class="mono">' + p.i + '</td><td>' + esc(p.name) + '</td><td>' + statusBadge(p.status) + '</td></tr>';
  }).join("") || '<tr><td colspan="3" class="empty">No pallets match.</td></tr>';
}

function palletDetailHTML(p){
  var calls = p.calls.length
    ? '<ul class="calls">' + p.calls.map(function(c){ return '<li><code>' + esc(c) + '</code></li>'; }).join("") + '</ul>'
    : '<p class="dim">No callable extrinsics for users.</p>';
  var src = p.status === "removed"
    ? 'runtime/src/lib.rs — #[runtime::pallet_index(' + p.i + ')] (vacant)'
    : 'runtime/src/lib.rs — #[runtime::pallet_index(' + p.i + ')]';
  return '<div class="detail-head"><span class="mono idx">#' + p.i + '</span><h3>' + esc(p.name) + '</h3>' + statusBadge(p.status) + '</div>' +
    '<p>' + esc(p.note) + '</p>' +
    '<h4>Calls</h4>' + calls +
    '<div class="detail-src">Source: <a href="' + CHAIN.sources.runtime + '" target="_blank" rel="noopener">runtime/src/lib.rs</a><br><span class="mono dim">' + esc(src) + '</span></div>';
}

function selectPallet(i){
  var p = lookupPallet(i);
  if (!p) return;
  $("palletDetail").innerHTML = palletDetailHTML(p);
  var rows = document.querySelectorAll("#palletRows tr");
  for (var k = 0; k < rows.length; k++) rows[k].classList.toggle("sel", rows[k].getAttribute("data-i") === String(p.i));
}

function runConverter(){
  var v = $("convIn").value;
  var dir = $("convDir").getAttribute("data-dir") || "q2p";
  var out = null, sub = "";
  if (dir === "q2p"){ out = qtcToPlancks(v); sub = "plancks"; }
  else { out = plancksToQtc(v); sub = "QTC"; }
  if (out === null){
    $("convOut").textContent = "—";
    $("convSub").textContent = dir === "q2p" ? "plancks" : "QTC";
    $("convWarn").hidden = true;
    return;
  }
  var big = dir === "q2p" ? out : null;
  $("convOut").textContent = dir === "q2p" ? groupDigits(String(out)) : out;
  $("convSub").textContent = sub;
  $("convWarn").hidden = !(dir === "q2p" && belowED(out));
}

function renderRepos(){
  $("repoGrid").innerHTML = REPOS.map(function(r){
    return '<a class="repo-card" href="https://github.com/Quantus-Network/' + r.name + '" target="_blank" rel="noopener">' +
      '<div class="repo-name">' + esc(r.name) + '<span class="repo-date">' + esc(r.pushed) + '</span></div>' +
      '<p>' + esc(r.desc) + '</p></a>';
  }).join("");
}

var activeRecipe = "r-js";
function showRecipe(key){
  activeRecipe = key;
  $("recipeCode").textContent = RECIPES[key].code;
  $("recipeNote").textContent = RECIPES[key].note;
  var tabs = document.querySelectorAll('.tabs [role="tab"]');
  for (var k = 0; k < tabs.length; k++){
    var on = tabs[k].getAttribute("data-tab") === key;
    tabs[k].classList.toggle("on", on);
    tabs[k].setAttribute("aria-selected", on ? "true" : "false");
  }
}

function runRpc(){
  var method = $("rpcMethod").value;
  var preset = RPC_PRESETS[method];
  var paramsBox = $("rpcParams");
  if (preset && paramsBox.getAttribute("data-auto") !== "no" && paramsBox.value === "[]"){
    $("rpcNote").textContent = preset.hint;
  }
  var r = buildJsonRpc(method, paramsBox.value);
  if (!r.ok){
    $("rpcJson").textContent = "Error: " + r.error;
    $("rpcCurl").textContent = "";
    $("rpcNote").textContent = r.error;
    return;
  }
  $("rpcJson").textContent = r.json;
  $("rpcCurl").textContent = r.curl;
  if (!preset) $("rpcNote").textContent = "POST this to your node's HTTP-RPC (default http://localhost:9944).";
}

function copyText(t, btn){
  function done(){ var old = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(function(){ btn.textContent = old; }, 1200); }
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done, done);
  } else {
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); done();
  }
}

function init(){
  renderConstants();
  renderPallets("");
  selectPallet(11);
  renderRepos();
  showRecipe("r-js");
  runRpc();

  $("constGrid").addEventListener("click", function(e){
    var b = e.target.closest(".mini-copy");
    if (b) copyText(b.getAttribute("data-copy"), b);
  });
  $("palletSearch").addEventListener("input", function(e){ renderPallets(e.target.value); });
  $("palletLookup").addEventListener("change", function(e){
    var p = lookupPallet(e.target.value);
    if (p){ renderPallets(""); $("palletSearch").value = ""; selectPallet(p.i); }
  });
  $("palletRows").addEventListener("click", function(e){
    var tr = e.target.closest("tr[data-i]");
    if (tr) selectPallet(parseInt(tr.getAttribute("data-i"), 10));
  });
  $("palletRows").addEventListener("keydown", function(e){
    var tr = e.target.closest("tr[data-i]");
    if (tr && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); selectPallet(parseInt(tr.getAttribute("data-i"), 10)); }
  });
  $("convIn").addEventListener("input", runConverter);
  $("convFlip").addEventListener("click", function(){
    var d = $("convDir");
    var dir = d.getAttribute("data-dir") === "q2p" ? "p2q" : "q2p";
    d.setAttribute("data-dir", dir);
    d.textContent = dir === "q2p" ? "QTC → plancks" : "plancks → QTC";
    runConverter();
  });
  document.querySelectorAll(".conv-presets button").forEach(function(b){
    b.addEventListener("click", function(){
      var u = b.getAttribute("data-u");
      $("convDir").setAttribute("data-dir", u === "qtc" ? "q2p" : "p2q");
      $("convDir").textContent = u === "qtc" ? "QTC → plancks" : "plancks → QTC";
      $("convIn").value = b.getAttribute("data-v");
      runConverter();
    });
  });
  $("convCopy").addEventListener("click", function(){ copyText($("convOut").textContent, $("convCopy")); });
  document.querySelectorAll('.tabs [role="tab"]').forEach(function(t){
    t.addEventListener("click", function(){ showRecipe(t.getAttribute("data-tab")); });
  });
  $("recipeCopy").addEventListener("click", function(){ copyText(RECIPES[activeRecipe].code, $("recipeCopy")); });
  $("rpcMethod").addEventListener("change", runRpc);
  $("rpcParams").addEventListener("input", function(){ $("rpcParams").setAttribute("data-auto", "no"); runRpc(); });
  $("rpcCopy").addEventListener("click", function(){ copyText($("rpcJson").textContent, $("rpcCopy")); });
  $("donateCopy").addEventListener("click", function(){ copyText(DONATE_ADDR, $("donateCopy")); });

  // ambient grid canvas
  var cv = $("gridfield"), ctx = cv.getContext("2d"), pts = [];
  function size(){ cv.width = innerWidth; cv.height = innerHeight; }
  size(); addEventListener("resize", size);
  for (var i = 0; i < 60; i++) pts.push({ x: Math.random(), y: Math.random(), s: Math.random() * 1.6 + .4, v: Math.random() * .0004 + .0001 });
  (function tick(){
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "rgba(77,240,164,.5)";
    for (var k = 0; k < pts.length; k++){
      var p = pts[k]; p.y -= p.v; if (p.y < 0) p.y = 1;
      ctx.globalAlpha = .25 + p.s * .2;
      ctx.fillRect(p.x * cv.width, p.y * cv.height, p.s, p.s);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  })();
}

var api = {
  CHAIN: CHAIN, PALLETS: PALLETS, REPOS: REPOS, RECIPES: RECIPES,
  DONATE_ADDR: DONATE_ADDR,
  qtcToPlancks: qtcToPlancks, plancksToQtc: plancksToQtc,
  groupDigits: groupDigits, belowED: belowED,
  lookupPallet: lookupPallet, buildJsonRpc: buildJsonRpc,
  init: init
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
else if (typeof window !== "undefined") window.DEVHUB = api;
else this.DEVHUB = api;

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);
})();
