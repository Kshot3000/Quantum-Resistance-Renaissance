/* QTC Quantum Resistance Renaissance — fleet boot-loader guard.
 * Run: node tests/test-boot-loaders.js
 *
 * Guards the single-load boot-loader class (fixed 2026-10-09):
 *  1. Consensus Lab validated its snapshot only by USING it — the parsed
 *     JSON was assigned to S before any field was touched, so a malformed
 *     payload threw inside loadSnapshot's try (pill said "unavailable")
 *     but left S poisoned; hero() then threw and the whole boot died,
 *     protocol-constants fallback included. Pin: validSnapshot() exists,
 *     is consulted, and S is assigned only after it passes.
 *  2. Supply Audit's boot() had no error handling at all: live query +
 *     snapshot fallback both failing (or a malformed snapshot reaching
 *     computeAudit) rejected boot unhandled and stranded the page on
 *     "loading…". Pin: showBootError exists, is wired into boot's catch
 *     paths, and paints the #audit-error box.
 *  3. Reversal Desk's quota simulator fell back to a hard-coded chain
 *     height (146270, build-day) whenever the snapshot hadn't loaded, and
 *     renderLive never re-ran renderQuota, so pre-load interactions stayed
 *     based on the stale height forever. Pin: no `|| 146270` fallback
 *     anywhere in app code, renderLive calls renderQuota(), and the qAdd
 *     handler refuses to fabricate a default height.
 *  4. Mining Observatory audited clean in the same pass (validates
 *     data.ok and routes every buildViews throw to showError) — pin its
 *     shape so it stays that way.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---- 1. Consensus Lab: validate before assigning S ----
{
  const src = read("pages/consensus-lab/app.js");
  ok(src.includes("function validSnapshot(j)"), "consensus: validSnapshot() defined");
  const callIdx = src.indexOf("if (!validSnapshot(j)) throw");
  ok(callIdx !== -1, "consensus: loadSnapshot rejects a malformed snapshot");
  const assignIdx = src.indexOf("S = j;", callIdx);
  ok(callIdx !== -1 && assignIdx > callIdx, "consensus: S is assigned only after validation passes");
  ok(!src.includes("S = await r.json()"), "consensus: no assign-before-validate loader remains");
  // the validator must cover the fields the renderers dereference
  for (const f of ["block_times_ms", "est_hashrate_hs", "net_change_pct", "blocks_indexed", "trend", "recent"])
    ok(src.slice(src.indexOf("function validSnapshot"), src.indexOf("async function loadSnapshot")).includes(f),
      "consensus: validator covers " + f);
}

// ---- 2. Supply Audit: boot failure is visible, never an unhandled rejection ----
{
  const src = read("pages/supply-audit/app.js");
  ok(src.includes("function showBootError(e)"), "supply: showBootError() defined");
  ok(src.includes('d.id = "audit-error"'), "supply: showBootError paints #audit-error");
  ok(src.includes('catch (e) { showBootError(e); return; }'), "supply: boot routes failures to showBootError");
  ok((src.match(/showBootError\(e\)/g) || []).length >= 3, "supply: both boot stages (load + compute/render) are guarded");
  ok(src.includes('"unavailable — audit not run"'), "supply: data-mode reports unavailable instead of loading…");
  const html = read("pages/supply-audit/index.html");
  ok(html.includes('app.js?v=1.30.0'), "supply: app.js cache key bumped for the boot fix");
}

// ---- 3. Reversal Desk: no stale hard-coded height; quota re-bases on load ----
{
  const src = read("pages/reversal-desk/js/app.js");
  ok(!/\|\|\s*146270/.test(src), "reversal: no `|| 146270` stale-height fallback in app code");
  ok(src.includes("function quotaRefHeight()"), "reversal: quotaRefHeight() resolves live-vs-simulated reference");
  const live = src.slice(src.indexOf("function renderLive"), src.indexOf("function txRow"));
  ok(live.includes("renderQuota()"), "reversal: renderLive re-runs renderQuota when the real height lands");
  ok(src.includes("no honest default to add at"), "reversal: qAdd refuses to fabricate a default height");
  const html = read("pages/reversal-desk/index.html");
  ok(html.includes("js/app.js?v=1.50.2"), "reversal: app.js cache key bumped for the quota fix");
}

// ---- 4. Mining Observatory: audited clean — keep its shape ----
{
  const src = read("pages/mining-observatory/app.js");
  ok(src.includes('if (!data || !data.ok) throw'), "observatory: boot validates the snapshot payload");
  ok(src.includes("function showError(msg)"), "observatory: failures route to showError (no figures rather than invented ones)");
}

// ---- 5. Emission Lab: validate the anchor before any renderer uses it ----
// Batch 2 (2026-10-09 03:19): anchorFromSnapshot only required a truthy
// `reward`, so non-numeric rewards / unparseable timestamps / all-zero
// rewards built a poisoned anchor (NaN mean, R0, blockTime) and the page
// rendered NaN figures, reaching fail() only if a canvas call threw.
{
  const src = read("pages/emission-lab/app.js");
  const anchor = src.slice(src.indexOf("function anchorFromSnapshot"), src.indexOf("function timeoutSignal"));
  ok(anchor.includes("Array.isArray(data.blocks)"), "emission: anchor requires a blocks array");
  ok(anchor.includes("isFinite(Date.parse(b.timestamp))"), "emission: blocks with unparseable timestamps are rejected");
  ok(anchor.includes("R0 >= MAX_SUPPLY"), "emission: R0 sanity-bounded before anchoring");
  ok(anchor.includes("bt < 1 || bt > 600"), "emission: observed block time must be finite and plausible");
  ok(anchor.includes('fetchedAt = null'), "emission: unparseable fetched_at is dropped (never 'Invalid Date')");
  ok(!src.includes("return b.reward;"), "emission: no truthy-reward-only filter remains");
  const html = read("pages/emission-lab/index.html");
  ok(html.includes("app.js?v=1.15.2"), "emission: app.js cache key bumped for the anchor fix");
}

// ---- 6. Tokenomics: audited clean — keep its fall-through shape ----
// GraphQL -> snapshot -> local model; every stage guarded, a malformed
// height at any stage falls through instead of poisoning the tiles.
{
  const src = read("pages/tokenomics/app.js");
  ok(src.includes("fromSnap().catch(local)"), "tokenomics: snapshot failure falls through to the local model");
  ok(src.includes('if ($("ltHeight").textContent === "—") local();'), "tokenomics: slow stages cannot strand the tiles on —");
}

// ---- 7. Distribution Planner: no chain load at all (pure local planner) ----
{
  const src = read("pages/distribution-planner/js/app.js");
  ok(!src.includes("fetch("), "distribution: planner never fetches chain data (nothing to strand)");
  ok(src.includes("revalidate();"), "distribution: boot renders the empty state via revalidate()");
}

// ---- 8. Vesting Desk: validate every schedule at the load boundary ----
// Batch 3 (2026-10-09 06:19): vesting-desk trusted both payloads blindly —
// BigInt("1.5") threw in enrichment outside the fetch try/catch, a null
// beneficiary wedged renderTable after partial paint, the snapshot's
// by_cohort was trusted ("oops" totals threw; wrong totals would display
// as fact), and a bad fetched_at rendered as "Invalid Date". Pin: every
// schedule validates, invalid ones drop, by_cohort is rebuilt from the
// survivors on BOTH paths, no assign-before-validate snapshot load.
{
  const src = read("pages/vesting-desk/app.js");
  ok(src.includes("function validateSchedules(rows)"), "vesting: validateSchedules() defined");
  ok(src.includes("function validSchedule(raw, seenIds)"), "vesting: per-schedule validator defined");
  ok(src.includes("ADDR_RE"), "vesting: beneficiary must be a prefix-189-shaped qz address");
  ok(src.includes("BigInt(claimed) > BigInt(total)"), "vesting: claimed > total schedules are rejected");
  ok((src.match(/by_cohort: buildByCohort\(schedules\)/g) || []).length === 2,
    "vesting: by_cohort rebuilt from validated schedules on live AND snapshot paths");
  ok(!src.includes("DATA = await res.json()"), "vesting: no assign-before-validate snapshot load remains");
  ok(!src.includes("function normalizeLive"), "vesting: unvalidated normalizeLive is gone");
  ok(src.includes("snapshot: no valid schedules"), "vesting: all-invalid payload fails honestly instead of rendering poison");
  const html = read("pages/vesting-desk/index.html");
  ok(html.includes("app.js?v=1.29.0"), "vesting: app.js cache key bumped for the boundary fix");
}

// ---- 9. Whale Watch: validate the whole snapshot at the load boundary ----
// Batch 4 (2026-10-09 07:19): whale-watch trusted its snapshot except for a
// truthy `ok` — one top row with free_plancks "1.5" threw BigInt() in the
// hero, a garbage move amount rendered as "0.oops" QTC, an unknown bracket
// key NaN'd the Gini, a missing genesis_allocation threw in renderMoves,
// and a bad fetched_at rendered "Invalid Date". Pin: validateSnapshot()
// gates DATA assignment, core aggregates fail honestly, row collections
// drop invalid entries, ranks are rebuilt from the survivors.
{
  const src = read("pages/whale-watch/app.js");
  ok(src.includes("function validateSnapshot(raw)"), "whale: validateSnapshot() defined");
  ok(src.includes("DATA = validateSnapshot(d);"), "whale: DATA assigned only from the validated snapshot");
  ok(!src.includes("DATA = d;"), "whale: no assign-before-validate loader remains");
  ok(src.includes("BigInt(liquid) !== BigInt(free) - BigInt(locked)"), "whale: top entries must satisfy liquid == free - locked");
  ok(src.includes("e.rank = idx + 1"), "whale: ranks rebuilt from validated survivors");
  ok(src.includes("MAX_SUPPLY_PLANCKS"), "whale: supply sanity-bounded by the 21M cap");
  ok(src.includes("BigInt(vClaimed) > BigInt(vTotal)"), "whale: vesting claimed > total fails the snapshot");
  ok(src.includes("function cleanMove(raw, maxHeight)"), "whale: moves validated against the snapshot height");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.20.0"), "whale: app.js cache key bumped for the boundary fix");
}

// ---- 10. Governance Tracker: validate the whole snapshot at the load boundary ----
// Batch 5 (2026-10-09 08:19): governance-tracker trusted its snapshot except
// for a truthy `referenda` — an event with a null type threw in
// renderTimeline and wiped the whole board, a garbage tally rendered as
// "NaN ayes", a non-array referenda painted the "No referenda" lie, a
// poisoned extrinsic row wiped an otherwise-valid board, a garbage
// referendum_index built a ref-NaN card, an unknown track silently used
// fast_upgrade thresholds, and a bad fetched_at rendered "Invalid Date".
// Pin: validateSnapshot() gates BOTH load paths (fetch and the QA mock),
// rows drop individually, all-invalid referenda fail honestly.
{
  const src = read("pages/governance-tracker/js/app.js");
  ok(src.includes("function validateSnapshot(raw)"), "governance: validateSnapshot() defined");
  ok(src.includes("function cleanRefEvent(raw)"), "governance: per-event validator defined");
  ok((src.match(/validateSnapshot\(/g) || []).length >= 3, "governance: validator gates fetch AND mock load paths");
  ok(src.includes("!STATUS_META[raw.type]"), "governance: event type must be a known lifecycle state");
  ok(src.includes("!trackById(track)"), "governance: unknown track events are rejected (no fallback thresholds)");
  ok(src.includes("tallyOk(raw.tally_ayes)"), "governance: tallies must be null or non-negative integers");
  ok(src.includes("d.referenda.length && !refs.length"), "governance: all-invalid referenda fail honestly (no empty-board lie)");
  ok(src.includes('throw new Error("snapshot failed validation")'), "governance: invalid snapshot throws into the boot catch");
  const html = read("pages/governance-tracker/index.html");
  ok(html.includes("js/app.js?v=1.43.0"), "governance: app.js cache key bumped for the boundary fix");
}

// ---- 11. Mining Studio: validate snapshot scalars at the load boundary ----
// Batch 6 (2026-10-09 09:19): deriveNetworkDefaults trusted every scalar —
// Number() accepted fractional/scientific plancks and hashrate strings,
// heights accepted floats (and any truthy Number on the supply fallback),
// and fetched_at was String()-coerced, then rendered verbatim by fmtUtc
// into the hint's innerHTML (a markup-bearing fetched_at injected markup).
// estimate() also returned NaN figures for a NaN supply. Pin: integer-
// string validation for plancks/hashrate/heights, parseable-only
// fetched_at, fmtUtc "unknown time", and the estimate supply guard.
{
  const src = read("pages/mining-studio/app.js");
  ok(src.includes("function intField(v)"), "studio: intField() defined");
  ok(src.includes("/^\\d+$/"), "studio: integer fields require a pure-digit string");
  ok(src.includes("function validFetchedAt(v)"), "studio: validFetchedAt() defined");
  ok(src.includes("isFinite(Date.parse(v)) ? v : null"), "studio: fetched_at must parse before it is kept");
  ok(!src.includes("String(consensus.fetched_at)") && !src.includes("String(supply.fetched_at)"),
    "studio: no raw String() fetched_at coercion remains");
  ok(src.includes('return isNaN(d) ? "unknown time"'), "studio: fmtUtc renders unknown time, never the raw string");
  ok(src.includes("if (!isFinite(supply) || supply < 0) return null;"), "studio: estimate rejects a non-finite/negative supply");
  const html = read("pages/mining-studio/index.html");
  ok(html.includes("app.js?v=1.2.0"), "studio: app.js cache key bumped for the boundary fix");
}

// ---- 12. Node Desk: validate snapshot scalars at BOTH load boundaries ----
// Batch 7 (2026-10-09 10:19): node-desk's loadSnapshot() and initSync()'s
// snapshot fallback trusted consensus.json via Number()/Date.parse
// coercion — a garbage/missing head rendered "block NaN" with the pill
// marked live, a float head rendered "194,626.9", a negative head was
// adopted into the sync input, a garbage fetched_at rendered "NaNm old",
// and the fallback never even checked r.ok. Pin: a shared parseSnapshot()
// in node-core.js (positive-integer head, parseable fetched_at) gates both
// loaders; an invalid snapshot is treated as NO snapshot.
{
  const core = read("pages/node-desk/node-core.js");
  ok(core.includes("export function parseSnapshot(S, nowMs)"), "nodedesk: parseSnapshot() defined in node-core");
  ok(core.includes("Number.isInteger(S.head)"), "nodedesk: numeric head must be an integer");
  ok(core.includes("/^\\d+$/"), "nodedesk: string head must be pure digits");
  ok(core.includes("if (!Number.isFinite(t)) return null;"), "nodedesk: fetched_at must parse");
  const src = read("pages/node-desk/app.js");
  ok((src.match(/parseSnapshot\(S\)/g) || []).length === 2, "nodedesk: validator gates BOTH snapshot loaders");
  ok((src.match(/snapshot failed validation/g) || []).length >= 2, "nodedesk: invalid snapshot throws into the honest fallback on both paths");
  ok(!src.includes("Number(S.head)"), "nodedesk: no raw Number(S.head) coercion remains");
  ok(!src.includes("Date.parse(S.fetched_at)"), "nodedesk: no raw Date.parse(S.fetched_at) age remains");
  const html = read("pages/node-desk/index.html");
  ok(html.includes("app.js?v=1.40.0"), "nodedesk: app.js cache key bumped for the boundary fix");
}

// ---- 13. Block Explorer: validate GraphQL responses at the load boundary ----
// Batch 8 (2026-10-09 11:19): block-explorer (Tier 1) trusted indexer
// responses except for esc() at render — an extrinsics count reached
// innerHTML unescaped (markup injection), fmtQTC mangled garbage amounts
// into "0.abc", garbage timestamps rendered "Invalid Date", float/negative
// heights were printed and interpolated raw into hrefs, and a null data
// payload threw a TypeError misreported as unreachable. Pin: cleaners gate
// every view, fmt helpers reject non-integer/non-digit input, gql rejects
// a missing data payload.
{
  const src = read("pages/block-explorer/app.js");
  ok(src.includes("function cleanHome(d)"), "explorer: cleanHome() defined");
  ok(src.includes("function cleanBlock(raw)"), "explorer: cleanBlock() defined");
  ok(src.includes("function cleanAccount(raw)"), "explorer: cleanAccount() defined");
  ok(src.includes("function validPlanck(v)"), "explorer: validPlanck() defined");
  ok(src.includes("cleanHome(d)"), "explorer: home view gates on cleanHome");
  ok(src.includes("indexer returned malformed home data"), "explorer: malformed home fails honestly");
  ok(src.includes("indexer returned malformed block data"), "explorer: malformed block fails honestly");
  ok(src.includes("indexer returned no data"), "explorer: gql rejects a missing data payload");
  ok(src.includes('!/^-?\\d+$/.test(String(planckStr))'), "explorer: fmtQTC rejects non-digit planck strings");
  ok(!src.includes("b.extrinsics_aggregate && b.extrinsics_aggregate.aggregate) ? b.extrinsics_aggregate.aggregate.count"),
    "explorer: no raw extrinsics-count interpolation remains");
  const html = read("pages/block-explorer/index.html");
  ok(html.includes("app.js?v=1.2.0"), "explorer: app.js cache key bumped for the boundary fix");
}

// ---- 14. Chain Console: validate RPC results at the summarizer boundary ----
// Batch 9 (2026-10-09 12:19): chain-console (Tier 1) esc()'d node answers at
// render but never validated them — garbage heights/peers/fees rendered as
// NaN or "[object Object]" chain fact, a non-hash broadcast answer was
// claimed as an accepted tx hash, subscription heads logged "#NaN", and the
// storage watch printed Number(cs.block) — a 77-digit invented block number
// from a field that is a 32-byte HASH. Pin: shared validators in core.js
// gate every summarizer, the submit path requires a real hash, and the
// storage watch treats cs.block as a hash.
{
  const core = read("pages/chain-console/js/core.js");
  ok(core.includes("export function parseBlockNumber(v)"), "console: parseBlockNumber() defined in core");
  ok(core.includes("export function isHash32(s)"), "console: isHash32() defined in core");
  ok(core.includes("export function validPlanckField(v)"), "console: validPlanckField() defined in core");
  ok(core.includes("if (number === null) return null"), "console: header/block summarizers drop a garbage height");
  const app = read("pages/chain-console/js/app.js");
  ok(app.includes("if (!isHash32(r)) return null"), "console: hash summarizer requires a 32-byte hash");
  ok(app.includes("treat this broadcast as <b>unconfirmed</b>"), "console: non-hash submit answer is unconfirmed, never an accepted tx hash");
  ok(app.includes("Malformed node identity"), "console: handshake rejects non-string identity values");
  ok(!app.includes("Number(cs.block)"), "console: storage watch no longer Number()s the block hash");
  ok(app.includes("balance key changed${at}"), "console: storage watch renders the block as a hash");
  ok(app.includes("if (html) feedLog(key, html, n)"), "console: malformed head notifications produce no feed row");
  const html = read("pages/chain-console/index.html");
  ok(html.includes("js/app.js?v=1.43.0"), "console: app.js cache key bumped for the boundary fix");
}

// ---- 15. Mempool Desk: validate RPC answers at the node boundary ----
// Batch 10 (2026-10-09 13:19): mempool-desk (Tier 1) esc()'d node answers
// at render but never validated them — String(chain) rendered an object
// identity as "[object Object]", garbage header numbers rendered as
// "#NaN"/"#garbage", a non-array pool answer silently became a fake
// EMPTY pool, garbage pool entries were counted and listed as
// extrinsics, a "-5" partialFee passed BigInt() and rendered as a
// negative fee quote, an object txWatch subscription id was String()'d
// into a LIVE watcher, a garbage notification `from` displayed verbatim,
// and a raw null frame threw in routeMessage. Pin: shared validators in
// rpc-core.js gate the handshake, heads, pool, fees, and subscriptions.
{
  const core = read("pages/mempool-desk/js/rpc-core.js");
  ok(core.includes("function parseBlockNumber(v)"), "mempool: parseBlockNumber() defined in rpc-core");
  ok(core.includes("function isHash32(s)"), "mempool: isHash32() defined in rpc-core");
  ok(core.includes("function validSubscriptionId(v)"), "mempool: validSubscriptionId() defined in rpc-core");
  ok(core.includes("function validExtrinsicHex(s)"), "mempool: validExtrinsicHex() defined in rpc-core");
  ok(core.includes("malformed partialFee in queryInfo result"), "mempool: decodePartialFee rejects negative/float/object fees");
  ok(core.includes('if (typeof raw.from === "string" && /^[A-Za-z0-9]{20,70}$/.test(raw.from)) from = raw.from'),
    "mempool: notification from is kept only when address-shaped");
  const app = read("pages/mempool-desk/js/app.js");
  ok(app.includes("node returned a malformed chain name"), "mempool: handshake rejects a non-string chain name");
  ok(app.includes("Array.isArray(msg)) return"), "mempool: routeMessage ignores non-object frames");
  ok(app.includes("node returned a malformed pool"), "mempool: non-array pool answer is malformed, never a fake empty pool");
  ok(app.includes("pool state unknown, not empty"), "mempool: malformed pool drops last-good figures honestly");
  ok(app.includes("node returned a malformed subscription id"), "mempool: txWatch subscribe validates the subscription id");
  ok(app.includes("Node returned a malformed fee quote"), "mempool: pasted quote labels a malformed fee honestly");
  ok(!app.includes("state.chain = String(chain)"), "mempool: no String() chain coercion remains");
  ok(!app.includes("state.pool = Array.isArray(list) ? list : []"), "mempool: no silent non-array-to-empty pool coercion remains");
  const html = read("pages/mempool-desk/index.html");
  ok(html.includes("js/app.js?v=1.36.0"), "mempool: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/rpc-core.js?v=1.33.0"), "mempool: rpc-core.js cache key bumped for the boundary fix");
}

// ---- 16. Extrinsic Lab: validate RPC answers at the node boundary ----
// Batch 11 (2026-10-09 14:19): extrinsic-lab (Tier 1) esc()'d node answers
// at render but never validated them — the Verify context fetch wrote
// rt.specVersion / genesis / header height straight into the verdict
// inputs (an object genesis became "[object Object]", a garbage header
// number became finalized "#NaN" and a "NaN" target-block field), the
// Live scanner parseInt'd the block header unchecked and turned a
// missing/non-list extrinsics field into a fake EMPTY block, non-string
// block entries were fed to the decoder as garbage, and a raw "null"
// socket frame threw inside attachRpc on msg.id. Pin: shared validators
// in js/rpc-validate.js gate the context fetch (all-or-nothing writes)
// and the scanner; malformed frames are ignored.
{
  const core = read("pages/extrinsic-lab/js/rpc-validate.js");
  ok(core.includes("function parseBlockNumber(v)"), "extrinsic: parseBlockNumber() defined in rpc-validate");
  ok(core.includes("function isHash32(s)"), "extrinsic: isHash32() defined in rpc-validate");
  ok(core.includes("function parseVersionNumber(v)"), "extrinsic: parseVersionNumber() defined in rpc-validate");
  ok(core.includes("function validExtrinsicHex(s)"), "extrinsic: validExtrinsicHex() defined in rpc-validate");
  const app = read("pages/extrinsic-lab/js/app.js");
  ok(app.includes("node returned a malformed finalized head hash"), "extrinsic: context fetch + scanner reject a non-hash finalized head");
  ok(app.includes("node returned a malformed finalized header"), "extrinsic: context fetch rejects a malformed header");
  ok(app.includes("node returned a malformed runtime version"), "extrinsic: context fetch rejects a malformed runtime version");
  ok(app.includes("node returned a malformed genesis hash"), "extrinsic: context fetch rejects a malformed genesis hash");
  ok(app.includes("node returned a malformed era-birth block hash"), "extrinsic: context fetch rejects a malformed era-birth hash");
  ok(app.includes("node returned a malformed block header"), "extrinsic: scanner rejects a malformed block header");
  ok(app.includes("extrinsics is not a list"), "extrinsic: scanner rejects a non-list extrinsics field");
  ok(app.includes("block state unknown, not empty"), "extrinsic: malformed block is unknown, never a fake empty block");
  ok(app.includes("malformed entry"), "extrinsic: scanner labels non-hex block entries as malformed");
  ok(app.includes("Array.isArray(msg)) return"), "extrinsic: attachRpc ignores non-object frames");
  ok(!app.includes("parseInt(header.number, 16)"), "extrinsic: no unchecked header parseInt remains in the context fetch");
  ok(!app.includes("parseInt(block.block.header.number, 16)"), "extrinsic: no unchecked header parseInt remains in the scanner");
  ok(!app.includes("block.block.extrinsics || []"), "extrinsic: no silent non-list-to-empty extrinsics coercion remains");
  const html = read("pages/extrinsic-lab/index.html");
  ok(html.includes("js/app.js?v=1.43.0"), "extrinsic: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/rpc-validate.js?v=1.0.0"), "extrinsic: rpc-validate.js cache key present");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
