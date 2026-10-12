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
// (2026-10-10 Batch 33: validSnapshot moved to consensus-core.js, where the
// node unit tests can import it, and was strengthened from shapes to
// relations — see Batch 33 below. The validate-before-assign wiring stays.)
{
  const src = read("pages/consensus-lab/app.js");
  const core = read("pages/consensus-lab/consensus-core.js");
  ok(core.includes("export function validSnapshot(j"), "consensus: validSnapshot() defined in consensus-core.js");
  ok(src.includes("validSnapshot, "), "consensus: app.js imports the boundary from the core");
  const callIdx = src.indexOf("if (!validSnapshot(j)) throw");
  ok(callIdx !== -1, "consensus: loadSnapshot rejects a malformed snapshot");
  const assignIdx = src.indexOf("S = j;", callIdx);
  ok(callIdx !== -1 && assignIdx > callIdx, "consensus: S is assigned only after validation passes");
  ok(!src.includes("S = await r.json()"), "consensus: no assign-before-validate loader remains");
  // the validator must cover the fields the renderers dereference
  for (const f of ["block_times_ms", "est_hashrate_hs", "net_change_pct", "blocks_indexed", "trend", "recent"])
    ok(core.slice(core.indexOf("export function validSnapshot")).includes(f),
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
  ok(html.includes('app.js?v=1.32.0'), "supply: app.js cache key bumped for the boot fix");
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
  ok(html.includes("js/app.js?v=1.52.0"), "reversal: app.js cache key bumped for the quota fix");
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
  ok(html.includes("app.js?v=1.31.0"), "vesting: app.js cache key bumped for the boundary fix");
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
  ok(src.includes("function cleanMove(raw, maxHeight, fetchedMs, isRecent)"), "whale: moves validated against the snapshot height and capture time");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.21.0"), "whale: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/app.js?v=1.44.0"), "governance: app.js cache key bumped for the boundary fix");
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
  ok(src.includes("if (!isFinite(t)) return null;"), "studio: fetched_at must parse before it is kept");
  ok(!src.includes("String(consensus.fetched_at)") && !src.includes("String(supply.fetched_at)"),
    "studio: no raw String() fetched_at coercion remains");
  ok(src.includes('return isNaN(d) ? "unknown time"'), "studio: fmtUtc renders unknown time, never the raw string");
  ok(src.includes("if (!isFinite(supply) || supply < 0) return null;"), "studio: estimate rejects a non-finite/negative supply");
  const html = read("pages/mining-studio/index.html");
  ok(html.includes("app.js?v=1.3.0"), "studio: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.41.0"), "nodedesk: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.3.0"), "explorer: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/app.js?v=1.45.0"), "console: app.js cache key bumped for the boundary fix");
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
  ok(core.includes('if (typeof raw.from === "string" && SS58_189_RE.test(raw.from)) from = raw.from'),
    "mempool: notification from is kept only when address-shaped (strict SS58-189 since Batch 60)");
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
  ok(html.includes("js/rpc-core.js?v=1.34.0"), "mempool: rpc-core.js cache key bumped for the boundary fix (1.34.0 since Batch 60)");
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
  ok(html.includes("js/app.js?v=1.45.0"), "extrinsic: app.js cache key bumped (1.45.0 round-2, supersedes the 1.44.0 clear-staleness bump)");
  ok(html.includes("js/rpc-validate.js?v=1.1.0"), "extrinsic: rpc-validate.js cache key present (1.1.0 round-2)");
}

// ---- 17. Web Wallet: validate RPC answers at the node boundary ----
// Batch 12 (2026-10-09 15:19): web-wallet (Tier 1, money-touching) rendered
// and SIGNED node answers unchecked — Number(rt.specVersion) turned a
// garbage version into a NaN that u32le silently encoded as 0 in the
// signing payload, a short fake genesis/birth hash was hex-decoded into
// the payload as-is, parseInt(header.number) made "#NaN" chain fact, a
// non-string storage answer threw on startsWith and a truncated blob
// read out of bounds, Number(nonce) signed NaN nonces, BigInt("-5")
// rendered a negative fee quote, any submit answer was presented as the
// tx hash, a raw "null" frame threw on msg.id, and the Activity tab
// turned a non-list indexer payload into a fabricated "no transfers"
// (with "Invalid Date" rows for garbage timestamps). Pin: validators in
// js/rpc-validate.js gate every query in rpc.js, and app.js validates
// activity rows before rendering them as money movement.
{
  const val = read("pages/web-wallet/js/rpc-validate.js");
  ok(val.includes("export function parseBlockNumber(v)"), "wallet: parseBlockNumber() defined in rpc-validate");
  ok(val.includes("export function isHash32(s)"), "wallet: isHash32() defined in rpc-validate");
  ok(val.includes("export function parseVersionNumber(v)"), "wallet: parseVersionNumber() defined in rpc-validate");
  ok(val.includes("export function parseNonce(v)"), "wallet: parseNonce() defined in rpc-validate");
  ok(val.includes("export function parseFeeField(v)"), "wallet: parseFeeField() defined in rpc-validate");
  ok(val.includes("export function validStorageHex(s)"), "wallet: validStorageHex() defined in rpc-validate");
  const rpc = read("pages/web-wallet/js/rpc.js");
  ok(rpc.includes("node returned a malformed runtime version"), "wallet: runtime version validated before it anchors a payload");
  ok(rpc.includes("node returned a malformed genesis hash"), "wallet: genesis hash validated");
  ok(rpc.includes("node returned a malformed latest header"), "wallet: latest header validated");
  ok(rpc.includes("node returned a malformed era-birth block hash"), "wallet: era-birth hash validated (it is signed over)");
  ok(rpc.includes("node returned a malformed account storage blob"), "wallet: account storage validated before decoding");
  ok(rpc.includes("bytes.length !== 68"), "wallet: account storage must be exactly the AccountInfo length");
  ok(rpc.includes("node returned a malformed nonce"), "wallet: nonce validated before signing");
  ok(rpc.includes("node returned a malformed transaction hash"), "wallet: submit answer must be a real hash, else unconfirmed");
  ok(rpc.includes("Array.isArray(msg)) return"), "wallet: RpcClient ignores non-object frames");
  ok(!rpc.includes("parseInt(header.number, 16)"), "wallet: no unchecked header parseInt remains");
  ok(!rpc.includes("BigInt(details.inclusionFee.baseFee)"), "wallet: no raw BigInt() fee coercion remains");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("sanitizeActivityRows(rawRows, addr, Date.now())"), "wallet: activity rows validated before rendering (round-1 shape check, superseded by the round-2 relational sanitize in Batch 38)");
  ok(app.includes("indexer returned malformed activity data"), "wallet: non-list activity payload is malformed, never a fake empty history");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes("js/app.js?v=1.42.0"), "wallet: app.js cache key bumped for the boundary fix (1.39.0, superseded by the 1.40.0 lock-scrub bump, the 1.41.0 activity round-2 bump and the 1.42.0 service-fee bump)");
  // Lock scrub (2026-10-10): lock() zeroed the in-memory key but left the
  // revealed phrase words, Security-tab keys, address and send form rendered
  // in the DOM behind the unlock screen; fillSecurity was { once: true },
  // pinning the first wallet's keys for every later wallet in the page.
  ok(app.includes("function scrubWalletDom()"), "wallet: scrubWalletDom() defined");
  ok(app.includes("scrubWalletDom();\n  $('lock-btn').hidden = true;"), "wallet: lock() scrubs the DOM");
  ok(app.includes("words.innerHTML = ''; words.hidden = true;"), "wallet: scrub removes the revealed phrase words");
  ok(!app.includes("fillSecurity, { once: true }") && !app.includes("{ once: true });\n</script>"), "wallet: fillSecurity is not once-only");
  ok(app.includes("addEventListener('click', fillSecurity);"), "wallet: security tab refills keys on every open");
}

// Batch 13 (2026-10-09 16:19): safesend (Tier 1) has no RPC/load boundary
// — it is fully local, so its boundary is user input, and it was open on
// every side: the checkphrase verifier derived an authoritative-looking
// phrase for ANY string (a checksum-corrupted address, "hello world!!",
// a Bitcoin address all rendered five words + "Derived locally from
// N-character address"), clearing the custom delay left no preset active
// and Schedule threw a TypeError on .dataset.blocks (dead button, no
// error shown), parseFloat scheduled sub-planck dust ("1e-13 QTC") and
// amounts beyond the 21M supply cap, and parseInt silently truncated
// fractional delays (2.5 -> 2 blocks). Pin: the verifier SS58-gates
// before deriving (the Contact Vault gate), and the simulator parses
// amount/delay strictly and can never dereference a missing preset.
{
  const ss58 = read("pages/safesend/js/ss58.js");
  ok(ss58.includes("function ss58Decode(addr)"), "safesend: vendored ss58Decode() present");
  ok(ss58.includes("var QUANTUS_PREFIX = 189;"), "safesend: SS58 codec pins Quantus prefix 189");
  ok(ss58.includes("Checksum mismatch"), "safesend: SS58 decoder verifies the checksum");
  const app = read("pages/safesend/js/app.js");
  ok(app.includes("function quantusAddressError(addr)"), "safesend: verifier gate defined");
  ok(app.includes("QSS58.ss58Decode(addr)"), "safesend: gate decodes SS58 before deriving");
  ok(app.includes("dec.prefix !== QSS58.QUANTUS_PREFIX"), "safesend: gate requires the Quantus prefix");
  ok(app.includes("dec.key.length !== 32"), "safesend: gate requires a 32-byte account key");
  ok(app.includes("No checkphrase was derived."), "safesend: rejection states no phrase was derived");
  ok(app.includes("function parseDelayStrict(raw)"), "safesend: strict delay parser defined");
  ok(app.includes("function parseAmountStrict(raw)"), "safesend: strict amount parser defined");
  ok(app.includes("/^\\d+(\\.\\d{1,12})?$/"), "safesend: amount shape is planck-exact (max 12 decimals)");
  ok(app.includes("amt > MAX_SUPPLY_QTC"), "safesend: amounts above the supply cap are rejected");
  ok(app.includes("var MAX_SUPPLY_QTC = 21000000;"), "safesend: supply cap pinned at 21,000,000 QTC");
  ok(app.includes("activatePreset(DEFAULT_DELAY_BLOCKS)"), "safesend: clearing custom restores the default preset");
  ok(app.includes("act ? +act.dataset.blocks : DEFAULT_DELAY_BLOCKS"), "safesend: Schedule falls back instead of dereferencing a missing preset");
  ok(!app.includes('parseInt($("customBlocks")'), "safesend: no parseInt coercion of the custom delay remains");
  ok(!app.includes('parseFloat($("simAmt")'), "safesend: no parseFloat coercion of the amount remains");
  ok(app.includes("function voidActiveSim()"), "safesend: live-sim voiding present (sim staleness)");
  ok(app.includes("if (!simTimer) return;"), "safesend: voiding only touches a live run — a completed run is history");
  ok(app.includes('$("simAddr").addEventListener("input", voidActiveSim);'), "safesend: recipient edits void the live run");
  ok(app.includes('$("simAmt").addEventListener("input", voidActiveSim);'), "safesend: amount edits void the live run");
  ok(app.includes('$("customBlocks").addEventListener("input", voidActiveSim);'), "safesend: custom-delay edits void the live run");
  ok(app.includes('p.addEventListener("click", voidActiveSim);'), "safesend: preset clicks void the live run");
  ok(app.includes("the running simulation was for the previous recipient, amount and delay"), "safesend: the void explains itself");
  const html = read("pages/safesend/index.html");
  ok(html.includes("js/ss58.js?v=1.0.0"), "safesend: ss58.js loaded with its cache key");
  ok(html.includes("js/app.js?v=1.5.0"), "safesend: app.js cache key bumped for the boundary fix (1.3.0, superseded by the 1.4.0 sim-staleness bump and the 1.5.0 rail-staleness bump)");
}

// Batch 14 (2026-10-09 17:19): airgap-desk (Tier 1) hot side trusted
// node answers exactly like the pre-hardening Web Wallet: the issue flow
// baked Number(rt.specVersion) / parseInt(header.number, 16) /
// Number(nonce) and unvalidated genesis + era-birth hashes into the chain
// ticket a cold signer signs against (garbage spec, "#NaN" head, NaN/-5
// nonce and a [object Object] genesis all rendered as issued tickets),
// the fee quote BigInt()'d fee fields (a "-5" field rendered a negative
// "node-quoted" fee), a garbage head during a quote pronounced the era
// EXPIRED at #NaN, over-long account storage was decoded from its first
// 68 bytes, and any submit answer was presented as the tx hash. Pin:
// lib/rpc-validate.js gates every helper in lib/rpc.js, the quote parses
// fee fields strictly, and submit requires a 32-byte hash.
{
  const val = read("pages/airgap-desk/js/lib/rpc-validate.js");
  ok(val.includes("export function parseBlockNumber"), "airgap: parseBlockNumber validator present");
  ok(val.includes("export function parseFeeField"), "airgap: parseFeeField validator present");
  ok(val.includes("export function isHash32"), "airgap: isHash32 validator present");
  const rpc = read("pages/airgap-desk/js/lib/rpc.js");
  ok(rpc.includes("from './rpc-validate.js'"), "airgap: rpc.js imports the validators");
  ok(rpc.includes("node returned a malformed runtime version"), "airgap: runtime version validated before it anchors a ticket");
  ok(rpc.includes("node returned a malformed genesis hash"), "airgap: genesis hash validated before it anchors a ticket");
  ok(rpc.includes("node returned a malformed header number"), "airgap: header number validated, never parseInt-NaN");
  ok(rpc.includes("node returned a malformed nonce"), "airgap: nonce validated before it anchors a ticket");
  ok(rpc.includes("node returned a malformed era-birth hash"), "airgap: era-birth hash validated");
  ok(rpc.includes("bytes.length !== 68"), "airgap: account storage must be exactly the 68-byte AccountInfo layout");
  ok(rpc.includes("broadcast unconfirmed"), "airgap: a non-hash submit answer is an unconfirmed broadcast, never a tx hash");
  ok(rpc.includes("Array.isArray(msg)"), "airgap: non-object socket frames are ignored, not dereferenced");
  ok(!rpc.includes("parseInt(header.number, 16)"), "airgap: no parseInt header coercion remains");
  ok(!rpc.includes("BigInt(details.inclusionFee.baseFee)"), "airgap: no raw BigInt() fee coercion remains in rpc.js");
  const app = read("pages/airgap-desk/js/app.js");
  ok(app.includes("parseFeeField(f.baseFee)"), "airgap: fee quote validates fee fields before BigInt");
  ok(app.includes("node did not quote a fee (malformed fee answer)"), "airgap: a malformed fee answer is an honest no-quote, not a TypeError");
  ok(!app.includes("BigInt(f.baseFee)"), "airgap: no raw BigInt() fee coercion remains in app.js");
  ok(app.includes("$('fee-quote').hidden = true;"), "airgap: a quote attempt hides the previous quote until a fresh one lands");
  ok(app.includes("$('broadcast-result').hidden = true;"), "airgap: a broadcast attempt hides the previous result until a fresh one lands");
  ok(app.includes("function voidSignedPackage(what)"), "airgap: signed-package voiding present (cold export staleness)");
  ok(app.includes("voidSignedPackage('a new chain ticket was imported')"), "airgap: importing a new ticket voids the signed package");
  ok(app.includes("voidSignedPackage('the destination was edited')"), "airgap: editing the destination voids the signed package");
  ok(app.includes("['cold-scheme', 'the signing scheme was changed']"), "airgap: amount/nonce/scheme edits void the signed package");
  ok(app.includes("scheme changed since review"), "airgap: sign refuses a scheme switched after review, named as such");
  ok(app.includes("nonce: nonceRaw, scheme, feeBps }"), "airgap: the review pins the scheme alongside dest/amount/nonce (feeBps added by Batch 61)");
  const html = read("pages/airgap-desk/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "airgap: app.js cache key bumped for the cold-void fix (1.44.0, superseded by the 1.45.0 round-2 bump)");
}

// Batch 15 (2026-10-09 19:19): notary-desk (Tier 1) — the last Tier 1 app
// whose boundaries were unhardened. Its localStorage vault JSON.parsed
// blindly: a null entry threw inside renderVault and bricked the vault,
// a markup-bearing feeQTC reached innerHTML, and a garbage envelopeHex
// was hashed (blake2 of the empty decode) into a verify "expected event
// hash" presented as a real fingerprint. Its Remark Board parseInt'd
// node answers unchecked: a garbage head claimed "scan complete — NaN
// blocks", a truncated System.Events blob was silently swallowed behind
// the same claim, a raw "null" frame threw on msg.id, and a rejected
// new-heads subscription left an unhandled rejection under a false
// "Live — watching" status. The build nonce parseInt-truncated "2.5"
// and the codec's compact encoder wrapped nonces past u32. Pin:
// sanitizeVault + RPC validators live in notary-codec.js and gate every
// load, verify, board row, scan verdict, and live claim.
{
  const codec = read("pages/notary-desk/js/notary-codec.js");
  ok(codec.includes("function sanitizeVault(raw)"), "notary: sanitizeVault() defined in codec");
  ok(codec.includes("function parseBlockNumber(v)"), "notary: parseBlockNumber() defined in codec");
  ok(codec.includes("function isHash32(s)"), "notary: isHash32() defined in codec");
  ok(codec.includes("function validSubscriptionId(v)"), "notary: validSubscriptionId() defined in codec");
  ok(codec.includes("parsed.digestHex !== digestHex"), "notary: envelope must parse back to the stored digest");
  ok(codec.includes("nonce must be a u32 integer"), "notary: signedLengthEstimate rejects a wrapping nonce");
  const app = read("pages/notary-desk/js/app.js");
  ok(app.includes("C.sanitizeVault(JSON.parse"), "notary: loadVault routes through sanitizeVault");
  ok(app.includes("node returned a malformed head"), "notary: scan rejects a malformed head instead of claiming NaN blocks");
  ok(app.includes("node returned a malformed block hash"), "notary: processBlock requires a 32-byte block hash");
  ok(app.includes("node returned malformed System.Events data"), "notary: malformed/truncated events are an error, never silently swallowed");
  ok(app.includes("extrinsics is not a list"), "notary: a non-list extrinsics field is malformed, never a fake empty block");
  ok(app.includes("Array.isArray(msg)) return"), "notary: board ignores non-object socket frames");
  ok(app.includes("new-heads subscription failed"), "notary: a failed subscription drops the Live claim honestly");
  ok(app.includes("node returned a malformed subscription id"), "notary: subscription id validated before it anchors the watch");
  ok(app.includes("lastBuild = null;"), "notary: a build attempt clears the previous build so a failed build is never saveable");
  ok(app.includes("/^\\d+$/.test(nonceRaw)"), "notary: the build nonce is parsed strictly (no parseInt truncation)");
  ok(!app.includes("hexToNum"), "notary: no unchecked parseInt header coercion remains");
  ok(!app.includes("parseInt($(\"nonceInput\")"), "notary: no parseInt nonce coercion remains");
  const html = read("pages/notary-desk/index.html");
  ok(html.includes("js/app.js?v=1.53.0"), "notary: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/notary-codec.js?v=1.49.0"), "notary: notary-codec.js cache key bumped for the boundary fix");
}

// Batch 16 (2026-10-09 20:19): watchtower (Tier 2) — its persisted state
// was copied into `state` with NO validation except rules: a null alert
// entry threw inside renderAll and killed init, a numeric alert address
// threw on .indexOf, a poisoned baseline balance ("abc") made
// evaluateRules throw BigInt() on EVERY scan, and a garbage lastScan
// rendered as a fake "just now". buildScanContext trusted every payload
// the same way: a garbage head height was presented as chain fact,
// poisoned transfer rows reached the rule engine, and a FAILED
// governance fetch computed referenda/upgrades as 0 — resetting the
// chain baselines so the next good scan fired FALSE "new referendum /
// upgrade" alerts. Pin: sanitizers in watch-core.js gate stored state,
// blocks, transfers, governance, baselines, and balances; unknown
// governance counts never fire and never reset a baseline.
{
  const core = read("pages/watchtower/js/watch-core.js");
  ok(core.includes("function sanitizeBlocks(rows)"), "watchtower: sanitizeBlocks() defined in watch-core");
  ok(core.includes("function sanitizeTransfers(rows, maxHeight)"), "watchtower: sanitizeTransfers() defined in watch-core");
  ok(core.includes("function sanitizeGovernance(data)"), "watchtower: sanitizeGovernance() defined in watch-core");
  ok(core.includes("function sanitizeBaselines(raw)"), "watchtower: sanitizeBaselines() defined in watch-core");
  ok(core.includes("function sanitizeAlerts(raw)"), "watchtower: sanitizeAlerts() defined in watch-core");
  ok(core.includes("counting it as 0 resets the chain baselines"), "watchtower: failed governance load reads unknown, never 0");
  ok(core.includes("if (nonNegInt(ctx.referenda) === null) break;"), "watchtower: unknown referendum count neither fires nor resets the baseline");
  ok(core.includes("if (nonNegInt(ctx.upgrades) === null) break;"), "watchtower: unknown upgrade count neither fires nor resets the baseline");
  ok(core.includes("return sanitizeBaselines(baselines);"), "watchtower: ensureBaselines sanitizes on every evaluation");
  const app = read("pages/watchtower/js/app.js");
  ok(app.includes("function sanitizeWatchlist(rows)"), "watchtower: sanitizeWatchlist() defined in app");
  ok(app.includes("state.baselines = QWATCH.sanitizeBaselines(parsed.baselines);"), "watchtower: stored baselines sanitized at load");
  ok(app.includes("state.alerts = QWATCH.sanitizeAlerts(parsed.alerts);"), "watchtower: stored alerts sanitized at load");
  ok(app.includes("state.lastScan = QWATCH.parseableTs(parsed.lastScan);"), "watchtower: stored lastScan must parse or is dropped");
  ok(app.includes("QWATCH.sanitizeBlocks(src && src.data && src.data.blocks)"), "watchtower: scan head comes only from validated blocks");
  ok(app.includes("QWATCH.sanitizeTransfers(bundle.flows && bundle.flows.transfers, flowsMeta ? flowsMeta.chain_height : null)"), "watchtower: transfers sanitized before the rule engine");
  ok(app.includes("QWATCH.sanitizeGovernance(bundle.gov && bundle.gov.data)"), "watchtower: governance counts sanitized before baselining");
  ok(!app.includes("(govData.referenda || []).length"), "watchtower: no raw governance length counting remains");
  ok(!app.includes("Object.keys(blankState())"), "watchtower: no blind stored-state copy remains");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/app.js?v=1.35.0"), "watchtower: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/watch-core.js?v=1.32.0"), "watchtower: watch-core.js cache key bumped for the boundary fix");
}

// Batch 17 (2026-10-09 21:19): portfolio-desk (Tier 2) — its stored
// vault and every snapshot/RPC payload crossed into BigInt math with no
// validation: parseVaultJson threw on ONE null entry (loadVault's catch
// then discarded the WHOLE vault), never deduped (a duplicate address
// double-counted every portfolio total), fractional/negative planck
// strings from the indexer or whales snapshot threw inside renderAll,
// garbage heights rendered as chain fact, miner counts went NaN,
// vesting schedule ids reached innerHTML unescaped, and id-less
// transfers all collapsed into a single activity row. Pin: sanitizers
// in desk-core.js gate the vault, balances, schedules, transfers, top
// balances, and mined counts; the rollup re-validates its ctx; the app
// SS58-gates the stored vault and validates live answers per-address.
{
  const core = read("pages/portfolio-desk/js/desk-core.js");
  ok(core.includes("function sanitizeBalance(row)"), "portfolio: sanitizeBalance() defined in desk-core");
  ok(core.includes("function sanitizeSchedule(s)"), "portfolio: sanitizeSchedule() defined in desk-core");
  ok(core.includes("function sanitizeSchedules(rows)"), "portfolio: sanitizeSchedules() defined in desk-core");
  ok(core.includes("function sanitizeTransfers(rows)"), "portfolio: sanitizeTransfers() defined in desk-core");
  ok(core.includes("function sanitizeTopBalances(rows)"), "portfolio: sanitizeTopBalances() defined in desk-core");
  ok(core.includes("function sanitizeMinedCounts(windowMiners, allTime)"), "portfolio: sanitizeMinedCounts() defined in desk-core");
  ok(core.includes("function sanitizeVaultEntries(rows)"), "portfolio: sanitizeVaultEntries() defined in desk-core");
  ok(core.includes("a duplicate silently double-counted every total"), "portfolio: duplicate vault entries are dropped, never double-counted");
  ok(core.includes("sanitizeBalance(ctx.balances.get(entry.address))"), "portfolio: rollup re-validates balances from any ctx producer");
  ok(core.includes("dedupe on the row's own facts"), "portfolio: id-less transfers dedupe on their own facts, never one shared key");
  const app = read("pages/portfolio-desk/js/app.js");
  ok(app.includes("v.addresses = v.addresses.filter(function (e) { return validateQuantusAddress(e.address).ok; });"), "portfolio: stored vault is SS58-gated at load");
  ok(app.includes("indexer returned a malformed response"), "portfolio: a non-object indexer answer is rejected, never dereferenced");
  ok(app.includes("QPORT.sanitizeBalance(row)"), "portfolio: live balance rows sanitized before they anchor the desk");
  ok(app.includes("row.id === addr ? QPORT.sanitizeBalance(row) : null"), "portfolio: a single-address refresh must answer for the address asked");
  ok(app.includes("Live refresh returned a malformed balance"), "portfolio: a malformed live balance reports honestly instead of anchoring");
  ok(app.includes("c.snapBalances = QPORT.sanitizeTopBalances(whales.top);"), "portfolio: snapshot balances sanitized at load");
  ok(app.includes("c.schedules = QPORT.sanitizeSchedules(vesting.schedules);"), "portfolio: vesting schedules sanitized at load");
  ok(app.includes("indexTransfers(QPORT.sanitizeTransfers(flows.transfers))"), "portfolio: transfers sanitized before the activity index");
  ok(app.includes("c.minedCounts = QPORT.sanitizeMinedCounts(miners.window_miners, miners.all_time);"), "portfolio: mined counts sanitized at load");
  ok(app.includes("QPORT.parseHeight(bundle.liveData.status.block_height)"), "portfolio: the live head is parsed strictly, never presented raw");
  ok(app.includes('esc(String(x.s.id))'), "portfolio: vesting schedule ids are escaped at render");
  const html = read("pages/portfolio-desk/index.html");
  ok(html.includes("js/app.js?v=1.35.0"), "portfolio: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/desk-core.js?v=1.33.0"), "portfolio: desk-core.js cache key bumped for the boundary fix");
}

// Batch 18 (2026-10-09 22:19): flow-tracer (Tier 2) — its snapshot and
// live indexer answers crossed into BigInt graph math with no
// validation: buildGraph's toBig() threw on ONE fractional/garbage
// amount or fee (killing the whole boot), snap.meta was dereferenced
// raw (object bounds rendered "[object Object]", fake capture dates
// presented as fact), id-less rows all shared trace()'s seenEdge key
// `undefined` (every id-less transfer after the first vanished), and
// the live dedupe collapsed id-less rows the same way. Pin: sanitizers
// in flow-core.js gate every row at buildGraph and the snapshot meta;
// the app validates the GraphQL envelope and the per-direction arrays,
// counts only sanitized rows, and fails a zero-valid-transfer snapshot
// honestly instead of booting an empty graph.
{
  const core = read("pages/flow-tracer/js/flow-core.js");
  ok(core.includes("function sanitizeTransfer(r, i)"), "flowtracer: sanitizeTransfer() defined in flow-core");
  ok(core.includes("function sanitizeTransfers(rows)"), "flowtracer: sanitizeTransfers() defined in flow-core");
  ok(core.includes("function sanitizeSnapshotMeta(m)"), "flowtracer: sanitizeSnapshotMeta() defined in flow-core");
  ok(core.includes("a duplicate id is the same transfer, never a second one"), "flowtracer: duplicate transfer ids are dropped, never double-counted");
  ok(core.includes("shared trace()'s seenEdge key `undefined`"), "flowtracer: id-less rows get fact-derived ids, never a shared key");
  ok(core.includes("var clean = sanitizeTransfers(rows);"), "flowtracer: buildGraph sanitizes at the boundary");
  const app = read("pages/flow-tracer/app.js");
  ok(app.includes("indexer returned a malformed response"), "flowtracer: a malformed indexer answer is rejected, never dereferenced");
  ok(app.includes("if (!Array.isArray(d.a) || !Array.isArray(d.b)) throw"), "flowtracer: live per-direction arrays are shape-checked");
  ok(app.includes("dedupe on their own facts, never one shared `undefined` key"), "flowtracer: live id-less rows dedupe on their own facts");
  ok(app.includes("var m = F.sanitizeSnapshotMeta(snap.meta);"), "flowtracer: snapshot meta is sanitized before it anchors the badge");
  ok(app.includes('throw new Error("snapshot contained no valid transfers")'), "flowtracer: a zero-valid-transfer snapshot fails honestly");
  ok(app.includes("if (liveGraph.rows.length) { graph = liveGraph; mode = \"live\"; }"), "flowtracer: a poison-only live answer never suppresses the snapshot graph");
  const html = read("pages/flow-tracer/index.html");
  ok(html.includes("js/flow-core.js?v=1.32.0"), "flowtracer: flow-core.js cache key bumped for the boundary fix");
  ok(html.includes("app.js?v=1.34.0"), "flowtracer: app.js cache key bumped for the boundary fix");
}

// Batch 19 (2026-10-10 04:19): ledger-desk (Tier 1, money-touching) —
// its boundaries were hardened in Batches-era passes (sanitizeState,
// scanSeq, snapshot validation, address-confirm pin), but the tax-year
// REPORT had no staleness path at all: lastReport + the rendered cards
// are a pin on (events, prices, method, tax year), yet adding/deleting/
// importing an event, adding detected events, adding/removing a price,
// switching FIFO/LIFO/HIFO, or editing the year field left the old
// report standing — and Export report CSV/JSON silently exported the
// stale figures. Wipe vault was worse: it reset only the stored state,
// leaving the built report (exports resurrecting wiped figures), the
// scan candidates, and a pending checkphrase confirm fully alive. Pin:
// voidReport() exists and is wired into every determinant mutation,
// voidDetections() clears candidates when the vault changes, and wipe
// clears every rendered derivative.
{
  const app = read("pages/ledger-desk/app.js");
  ok(app.includes("function voidReport(what)"), "ledger: voidReport() defined (report staleness)");
  ok(app.includes("if (!lastReport) return;"), "ledger: voiding only touches a built report");
  ok(app.includes('voidReport("an event was added")'), "ledger: event add voids the report");
  ok(app.includes('voidReport("an event was deleted")'), "ledger: event delete voids the report");
  ok(app.includes('voidReport("events were imported")'), "ledger: CSV import voids the report");
  ok(app.includes('voidReport("detected events were added to the ledger")'), "ledger: adding detections voids the report");
  ok((app.match(/voidReport\("the price table changed"\)/g) || []).length >= 2, "ledger: price add AND remove void the report");
  ok(app.includes('voidReport("the cost-basis method changed")'), "ledger: method switch voids the report");
  ok(app.includes('voidReport("the tax year changed")'), "ledger: tax-year edit voids the report");
  ok(app.includes("Number($(\"repYear\").value) !== lastReport.year"), "ledger: year void is scoped to a different year");
  ok(app.includes("function voidDetections(msg)"), "ledger: voidDetections() defined (candidate staleness)");
  ok(app.includes("the scan candidates were computed for the previous vault"), "ledger: address removal voids the candidates");
  ok(app.includes('voidReport("the vault was wiped")'), "ledger: wipe voids the report");
  ok(app.includes('$("addrCheck").innerHTML = "";'), "ledger: wipe voids a pending address confirm");
  const html = read("pages/ledger-desk/index.html");
  ok(html.includes("app.js?v=1.6.0"), "ledger: app.js cache key bumped for the report-staleness fix");
}

// Batch 20 (2026-10-10 05:19): chain-console (Tier 1) — the gated broadcast
// review had NO staleness path at all. The review is a pin on (extrinsic
// hex, connection): pendingBroadcast + the rendered size/head/tail. Editing
// #rf-extrinsic after reviewing left the old review confirmable (confirm
// broadcast the OLD hex while the form showed the new one); selecting a
// different recipe silently nulled pendingBroadcast but left the review UI
// alive (confirm then broadcast [null]); disconnect/reconnect left the
// review live against a connection it was never reviewed on. Pin:
// voidPendingBroadcast() exists and is wired into every determinant change,
// renderResult / the node-identity write clear an orphaned review silently,
// and uncommitted endpoint typing does NOT void (no endpoint listener).
{
  const app = read("pages/chain-console/js/app.js");
  ok(app.includes("function voidPendingBroadcast(what)"), "console: voidPendingBroadcast() defined (broadcast-review staleness)");
  ok(app.includes("if (pendingBroadcast === null) return;"), "console: voiding only touches a pending review");
  ok(app.includes("Broadcast review cleared"), "console: void replaces the review with a cleared note");
  ok(app.includes("voidPendingBroadcast('the recipe inputs')"), "console: recipe-input edits void the review");
  ok(app.includes("voidPendingBroadcast('the selected recipe')"), "console: recipe switch voids the review");
  ok(app.includes("voidPendingBroadcast('the connection');"), "console: disconnect voids the review");
  ok(app.includes("voidPendingBroadcast('the connection was lost')"), "console: socket loss voids the review");
  ok((app.match(/pendingBroadcast = null;/g) || []).length >= 5, "console: renderResult + node-identity writes clear an orphaned review");
  ok(!app.includes("$('endpoint').addEventListener('input'"), "console: uncommitted endpoint typing does not void the review");
  const html = read("pages/chain-console/index.html");
  ok(html.includes("js/app.js?v=1.45.0"), "console: app.js cache key bumped for the broadcast-staleness fix");
}

// Batch 21 (2026-10-10 06:19): extrinsic-lab (Tier 1) — the Decode tab's
// Clear button was the one determinant change with no staleness path:
// it writes hex-input.value programmatically (no input event, so the
// hex-divergence voidDecode never runs), nulls state.last/lastHex and
// hides the autopsy — but never voided the Verify tab, so a VALID
// verdict earned by the cleared extrinsic stayed rendered, pronouncing
// over an extrinsic that no longer exists anywhere in the app. Pin:
// Clear calls voidVerify with an explanation (voidVerify itself no-ops
// when no verdict is shown, so Clear paints no spurious verify error).
{
  const app = read("pages/extrinsic-lab/js/app.js");
  ok(app.includes("voidVerify('The decoded extrinsic was cleared"), "extrinsic: Clear voids a shown verdict with an explanation");
  ok((app.match(/voidVerify\(/g) || []).length >= 6, "extrinsic: voidVerify wired at definition + decode + hex-void + context-fetch + context-edit + Clear");
  const html = read("pages/extrinsic-lab/index.html");
  ok(html.includes("js/app.js?v=1.45.0"), "extrinsic: app.js cache key bumped for the clear-staleness fix (1.44.0, superseded by the 1.45.0 round-2 bump)");
}

// Batch 22 (2026-10-10 07:19): notary-desk (Tier 1) — the last Tier 1
// staleness sweep. Neither rendered pin had ANY staleness path: the
// Timestamp Studio build (lastBuild + rendered call/envelope/fee
// ledger) is a pin on (mode, digest, algorithm, label, message, remark
// variant, signature scheme, nonce, dropped file), yet editing any of
// them left the old extrinsic standing — and Save anchor silently
// persisted the OLD build while the form showed the new inputs. The
// Verify verdict is a pin on (digest field, file pairing, vault
// contents), yet digest edits, the verify drop's programmatic fill,
// and every vault mutation (save / delete / clear / block annotation)
// left it standing. Pin: voidBuild() / voidVerifyResult() exist, no-op
// when nothing is live, and are wired into every determinant —
// including both programmatic drop fills, which fire no events.
{
  const app = read("pages/notary-desk/js/app.js");
  ok(app.includes("function voidBuild(what)"), "notary: voidBuild() defined (build staleness)");
  ok(app.includes("Build cleared — "), "notary: build void replaces the output with a cleared note");
  ok((app.match(/voidBuild\(/g) || []).length >= 10, "notary: voidBuild wired at definition + digest + algo + label + message + mode + variant + scheme + nonce + studio drop");
  ok(app.includes("const changed = studio.mode !== btn.dataset.mode"), "notary: mode void scoped to an actual mode change");
  ok(app.includes("const changed = nv !== studio.withEvent"), "notary: variant void scoped to an actual variant change");
  ok(app.includes("function voidVerifyResult(what)"), "notary: voidVerifyResult() defined (verdict staleness)");
  ok(app.includes("if (!verifyLive) return;"), "notary: verdict void only touches a live verdict");
  ok(app.includes("Result cleared."), "notary: verdict void replaces the verdict with a cleared note");
  ok(app.includes("verifyLive = true;"), "notary: a fresh verdict marks itself live for voiding");
  ok((app.match(/voidVerifyResult\(/g) || []).length >= 7, "notary: voidVerifyResult wired at definition + digest edit + verify drop + save + delete + clear + block annotation");
  const html = read("pages/notary-desk/index.html");
  ok(html.includes("js/app.js?v=1.53.0"), "notary: app.js cache key bumped for the staleness fix");
}

// Batch 23 (2026-10-10 08:19): network-dashboard (Tier 2) — the first
// Tier 2 boundary batch. It trusted every indexer/snapshot field raw:
// fmtQTC passed non-digit reward strings straight into the blocks
// table's innerHTML (a poisoned reward became live markup), block
// hash/timestamp were interpolated into data-* attributes (quote
// breakout = injection), a string block_height rendered "—" while the
// poisoned blocks still painted, negative accounts rendered as fact,
// and a poisoned daily tx_count rendered "NaN tx/s". Pin:
// sanitizeData() exists, is consulted in refresh() before any render,
// and a malformed payload throws into the failure path (last good
// telemetry kept); fmtQTC/fmtInt reject non-numeric input outright.
{
  const app = read("pages/network-dashboard/app.js");
  ok(app.includes("function sanitizeData(data, opts)"), "netdash: sanitizeData() defined");
  ok(app.includes("function validHash(v)"), "netdash: validHash() defined (0x + 64 hex)");
  ok(app.includes("function validPlancks(v)"), "netdash: validPlancks() defined");
  ok(app.includes("function nonNegInt(v)"), "netdash: nonNegInt() defined");
  ok(app.includes("var data = sanitizeData(result.data, { fetchedAt: result.fetchedAt, nowMs: Date.now() });"), "netdash: refresh() sanitizes before rendering");
  ok(app.includes('if (!data) throw new Error("malformed chain data");'), "netdash: malformed payload routes to the failure path");
  ok(app.includes('if (valid === null) return "—";'), "netdash: fmtQTC rejects non-planck input instead of passing it through");
  const html = read("pages/network-dashboard/index.html");
  ok(html.includes("app.js?v=1.10.0"), "netdash: app.js cache key bumped for the boundary fix");
}

// Batch 24 (2026-10-10 09:19): supply-audit (Tier 2) — the second Tier 2
// boundary batch. computeAudit + the renderers trusted every supply
// payload raw: a genesis total that disagreed with its own transfer
// list anchored the PASS verdict (the class of the 2026-09-30 3-row
// truncation), a negative mined total rendered as fact, a swapped
// mint-sentinel id was quoted as evidence, vesting claimed > total
// produced a negative unclaimed, malformed genesis addresses rendered
// truncated as fact — and one poisoned reward in the AUXILIARY
// data/live.json threw inside drawRewards, routing the whole boot to
// showBootError and dashing figures the supply data had proven good.
// Pin: sanitizeSupply() lives in audit-core (shared with node tests),
// computeAudit sanitizes before any math, loadSupply sanitizes the
// live payload inside its try (malformed live -> snapshot fallback)
// and the snapshot on the fallback path (malformed snapshot -> boot
// error), and cleanBlocks() drops poisoned recent-block rows instead
// of letting them reach BigInt.
{
  const core = read("pages/supply-audit/js/audit-core.js");
  ok(core.includes("function sanitizeSupply(d, nowMs)"), "supply2: sanitizeSupply() defined in audit-core (round-2 signature, Batch 37)");
  ok(core.includes("genesis.total_plancks != sum of its transfers"), "supply2: genesis total cross-checked against its transfer list");
  ok(core.includes("d.mint_sentinel_id !== MINT_SENTINEL"), "supply2: mint-sentinel id pinned to the canonical account");
  ok(core.includes("vesting.claimed_plancks exceeds vesting.total_plancks"), "supply2: vesting claimed bounded by vesting total");
  ok(core.includes("var d = sanitizeSupply(raw);"), "supply2: computeAudit sanitizes before any math");
  const app = read("pages/supply-audit/app.js");
  ok(app.includes("return A.sanitizeSupply(toSnapshot(core"), "supply2: live payload sanitized inside loadSupply's try (fallback on malformed)");
  ok(app.includes("var snap = A.sanitizeSupply(await fetchJson("), "supply2: snapshot sanitized on the fallback path");
  ok(app.includes("function cleanBlocks(blocks, subsidy, statusHeight)"), "supply2: cleanBlocks() defined for the auxiliary live.json overlay (round-2 signature, Batch 37)");
  ok(app.includes("blocks = cleanBlocks(live.data.blocks, a.subsidy,"), "supply2: recent blocks cleaned against the audited subsidy before they reach drawRewards");
  const html = read("pages/supply-audit/index.html");
  ok(html.includes("js/audit-core.js?v=1.30.0"), "supply2: audit-core cache key bumped for the boundary fix");
  ok(html.includes("app.js?v=1.32.0"), "supply2: app.js cache key bumped for the boundary fix");
}

// Batch 25 (2026-10-10 10:19): mining-observatory (Tier 2) — the third
// Tier 2 boundary batch. It trusted data/miners.json raw: a coinbase
// address was interpolated unescaped into title=/data-copy=/href
// attributes in the leaderboard's innerHTML (quote breakout = live
// markup injection, an <img> demonstrably materialized), the window
// denominator was never cross-checked against the miner counts it
// divides (a truncated map silently rescaled every share, Nakamoto
// coefficient and HHI), negative counts produced negative shares, a
// duplicate all-time row split one miner's share in two, an all-time
// count above the chain height rendered a >100% share, a garbage
// fetched_at rendered "NaNd ago" as fresh — while a STRING
// observed_block_time_s threw on .toFixed and one poisoned bucket
// (miners: null) threw inside the timeline draw, each dashing figures
// the rest of the snapshot had proven. Pin: sanitizeMiners() rejects a
// malformed core payload wholesale before DATA is assigned, the block
// time degrades to null (the fetch script itself emits null), and
// buckets are cleaned drop-and-continue.
{
  const app = read("pages/mining-observatory/app.js");
  ok(app.includes("function sanitizeMiners(d)"), "minobs: sanitizeMiners() defined");
  ok(app.includes("var ADDR_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/;"), "minobs: coinbase addresses must be prefix-189 SS58 shape");
  ok(app.includes("DATA = sanitizeMiners(data);"), "minobs: DATA assigned only from the sanitized snapshot");
  ok(app.includes("window_miners counts do not sum to window.block_count"), "minobs: window counts cross-checked against the denominator they divide");
  ok(app.includes("window.end_height != chain_height"), "minobs: window must end at the claimed chain height");
  ok(app.includes("all_time duplicate address"), "minobs: duplicate all-time rows rejected (no split shares)");
  ok(app.includes("function cleanBuckets(buckets, win, windowMiners)"), "minobs: cleanBuckets() defined for the auxiliary timeline (round 2: window-context signature)");
  ok(app.includes("wout.observed_block_time_s = cleanBlockTime(w.observed_block_time_s);"), "minobs: block time degraded to null, never .toFixed on a string");
  const html = read("pages/mining-observatory/index.html");
  ok(html.includes("app.js?v=1.19.0"), "minobs: app.js cache key bumped for the boundary fix");
}

// Batch 26 (2026-10-10 11:19): mining-calculator (Tier 2) — the fourth
// Tier 2 boundary batch. deriveNetworkDefaults trusted the consensus +
// supply snapshots raw: Number() accepted a scientific-notation
// hashrate ("9.9e13" painted as ≈99 TH/s live) and fractional scalars,
// a hashrate was never cross-checked against the difficulty it is
// derived from (fetch construction: est = difficulty / 12 exactly),
// a fractional height rendered as "block 153,406.9" and a garbage
// fetched_at as "unknown time" while the payload still counted as a
// live snapshot, a fractional avg_ms overstated blocks/day ~14x, a
// supply total was never cross-checked against its own balances
// itemization (fetch construction: total == free+reserved+frozen), and
// a supply payload from a different, stale capture was mixed into the
// live reward math. The honesty bullet also pinned the fallback to the
// long-superseded Oct 2 capture. Pin: strict intField/validPlancks/
// validHeight/validFetchedAt shapes, both exact cross-checks, the
// >=100 sample gate on observed pace, and the one-capture height rule.
{
  const app = read("pages/mining-calculator/app.js");
  ok(app.includes("function intField(v)"), "miningcalc: intField() defined (integer shapes only)");
  ok(app.includes("function validFetchedAt(v)"), "miningcalc: validFetchedAt() defined (real capture times only)");
  ok(app.includes("BigInt(hs) !== BigInt(diff) / 12n) hs = null;"), "miningcalc: hashrate cross-checked against difficulty / 12 exactly");
  ok(app.includes("if (total != null && sum != null && BigInt(total) !== sum) return null;"), "miningcalc: supply total cross-checked against its balances itemization");
  ok(app.includes("sample != null && sample >= 100"), "miningcalc: observed pace requires the fetch sample (>= 100 blocks)");
  ok(app.includes("Math.abs(sHeight - out.height) > 100) out.supplyQtc = null;"), "miningcalc: cross-capture supply rejected (one-capture rule)");
  const html = read("pages/mining-calculator/index.html");
  ok(html.includes("app.js?v=1.11.14"), "miningcalc: app.js cache key bumped for the boundary fix");
  ok(!html.includes("falls back to the dated Oct 2, 2026 capture"), "miningcalc: honesty bullet no longer pins the fallback to the stale Oct 2 capture");
}

// Batch 27 (2026-10-10 12:19): pool-desk (Tier 2) — the fifth Tier 2
// boundary batch. deriveNetworkDefaults trusted all three snapshots raw:
// Number() accepted a scientific-notation hashrate ("9.9e13" painted as
// ≈99 TH/s live) and a hashrate was never cross-checked against the
// difficulty it derives from (fetch construction: est = difficulty/12
// exactly); a 100ms avg_ms over a 3-block sample painted 864,000
// blocks/day; a supply total was never cross-checked against its own
// balances itemization (a 9,000,000 QTC total anchored a 0.240000 QTC
// reward); a fractional balance threw inside BigInt() and killed ALL
// live defaults (inverted failure domain); a supply payload from a
// different, stale capture mixed into the live reward math; poisoned
// live-block rewards averaged to NaN; and a garbage fetched_at rendered
// "unknown time" while the payload still counted as a live snapshot.
// Pin: strict intField/validPlancks/validHeight/validFetchedAt shapes,
// both exact cross-checks, the 21M cap on total issuance, parseable
// fetched_at provenance per payload, the >=100 sample gate on observed
// pace, per-row reward validation on the block-avg path, and the
// one-capture height rule for both the supply and live payloads.
{
  const app = read("pages/pool-desk/js/app.js");
  ok(app.includes("function intField(v)"), "pooldesk: intField() defined (integer shapes only)");
  ok(app.includes("function validFetchedAt(v)"), "pooldesk: validFetchedAt() defined (real capture times only)");
  ok(app.includes("BigInt(h) !== BigInt(diff) / 12n) h = null;"), "pooldesk: hashrate cross-checked against difficulty / 12 exactly");
  ok(app.includes("if (total != null && sum != null && BigInt(total) !== sum) return null;"), "pooldesk: supply total cross-checked against its balances itemization");
  ok(app.includes("BigInt(MAX_SUPPLY_QTC) * 1000000000000n"), "pooldesk: total issuance capped at 21M before it anchors a reward");
  ok(app.includes("sample != null && sample >= 100"), "pooldesk: observed pace requires the fetch sample (>= 100 blocks)");
  ok(app.includes("Math.abs(supHeight - consHeight) > 100) supplyPlancks = null;"), "pooldesk: cross-capture supply rejected (one-capture rule)");
  ok(app.includes("q > 0 && q <= MAX_SUPPLY_QTC / EMISSION_DENOM"), "pooldesk: block-avg rewards validated per row against the emission range");
  const html = read("pages/pool-desk/index.html");
  ok(html.includes("app.js?v=1.48.14"), "pooldesk: app.js cache key bumped for the boundary fix");
}

// Batch 28 (2026-10-10 13:19): energy-observatory (Tier 2) — the sixth
// Tier 2 boundary batch. loadSnapshots trusted all three snapshots raw:
// String() accepted a scientific-notation difficulty ("9.9e13" painted
// as 8.25 TH/s live) and the payload's own est_hashrate was never
// cross-checked against it (fetch construction: est = difficulty/12
// exactly); a fractional height rendered as a live block; a supply
// total was never cross-checked against its balances itemization (a
// 9,000,000 QTC total anchored a 0.240000 QTC reward) and an over-cap
// total minted a NEGATIVE reward (-439.58 QTC); a fractional balance
// threw inside BigInt() and killed the live payload's tx rate too
// (inverted failure domain); a supply payload from a different, stale
// capture mixed into the live reward math; poisoned trend points
// bucketed into a "NaN-aN-aN" history day; a poisoned first daily row
// NaN'd the whole per-transfer desk; and a garbage fetched_at anchored
// the snapshot AND reached the provenance note's innerHTML as markup.
// Pin: strict intField/validPlancks/validHeight/validFetchedAt shapes,
// both exact cross-checks, the 21M cap on total issuance, parseable
// fetched_at provenance per payload, per-point trend cleaning, per-row
// daily validation, the one-capture rule, and a re-serialized
// (toISOString) provenance date — never the raw payload string.
{
  const app = read("pages/energy-observatory/js/app.js");
  ok(app.includes("function deriveSnapshotState(con, sup, liv)"), "energy: deriveSnapshotState() defined (the snapshot boundary)");
  ok(app.includes("function intField(v)"), "energy: intField() defined (integer shapes only)");
  ok(app.includes("function validFetchedAt(v)"), "energy: validFetchedAt() defined (real capture times only)");
  ok(app.includes("BigInt(eh) !== BigInt(diff) / 12n) diff = null;"), "energy: difficulty cross-checked against est_hashrate x 12 exactly");
  ok(app.includes("if (total != null && sum != null && BigInt(total) !== sum) return null;"), "energy: supply total cross-checked against its balances itemization");
  ok(app.includes("BigInt(tp) <= 21000000n * 1000000000000n"), "energy: total issuance capped at 21M before it anchors a reward");
  ok(app.includes("Math.abs(supHeight - consHeight) > 100"), "energy: cross-capture supply rejected (one-capture rule)");
  ok(app.includes("function cleanTrend(trend)"), "energy: cleanTrend() defined (poisoned points drop individually)");
  ok(app.includes("new Date(state.fetchedAt).toISOString()"), "energy: provenance date re-serialized, never raw payload text in innerHTML");
  const html = read("pages/energy-observatory/index.html");
  ok(html.includes("app.js?v=1.51.14"), "energy: app.js cache key bumped for the boundary fix");
  ok(!html.includes("97/97 node tests green"), "energy: methodology no longer pins a stale hard-coded test count");
}

// Batch 29 (2026-10-10 14:19): luck-lab (Tier 2) — the seventh Tier 2
// boundary batch. loadData trusted both snapshots raw via Number():
// a scientific-notation difficulty ("9.9e13") painted as 8.25 TH/s; an
// est_hashrate contradicting the difficulty painted 1.00 kH/s (and was
// never cross-checked against difficulty/12, the fetch construction);
// a supply total contradicting its balances painted a 0.2400 QTC
// reward; an over-cap total minted a negative reward; a fractional
// height rounded into the badge ("head 201,294"); a garbage fetched_at
// was echoed raw into the provenance note while the payload anchored;
// a recent window with gapped heights and compressed timestamps
// painted 78,545 blocks/day (span/(n-1) overcounts when heights skip);
// a fractional balance summed into a near-max 0.4200 QTC reward; and
// the live GraphQL head was compared unvalidated, so a fractional or
// string head could promote/mark the snapshot. Pin: strict
// intField/validPlancks/validHeight/validFetchedAt shapes, both exact
// cross-checks, the 21M cap, parseable fetched_at provenance per
// payload, the one-capture rule, a consecutive-window pace cleaner,
// a validated live head, and the module hook that makes the boundary
// unit-testable. Also pins the footer honesty line: the snapshots
// refresh hourly — a hard-coded "(refreshed 2026-10-02)" date rotted
// eight days stale on a live page.
{
  const app = read("pages/luck-lab/js/app.js");
  ok(app.includes("function deriveSnapshotState(con, sup)"), "lucklab: deriveSnapshotState() defined (the snapshot boundary)");
  ok(app.includes("function intField(v)"), "lucklab: intField() defined (integer shapes only)");
  ok(app.includes("function validFetchedAt(v)"), "lucklab: validFetchedAt() defined (real capture times only)");
  ok(app.includes("BigInt(eh) !== BigInt(diff) / 12n) diff = null;"), "lucklab: difficulty cross-checked against est_hashrate x 12 exactly");
  ok(app.includes("if (total != null && sum != null && BigInt(total) !== sum) return null;"), "lucklab: supply total cross-checked against its balances itemization");
  ok(app.includes("BigInt(tp) <= 21000000n * 1000000000000n"), "lucklab: total issuance capped at 21M before it anchors a reward");
  ok(app.includes("Math.abs(supHeight - consHeight) > 100"), "lucklab: cross-capture supply rejected (one-capture rule)");
  ok(app.includes("function recentPaceMs(rec)"), "lucklab: recentPaceMs() defined (consecutive-window pace only)");
  ok(app.includes("h !== prevH + 1"), "lucklab: pace requires consecutive heights (span cannot overcount blocks)");
  ok(app.includes("var liveHead = validHeight(rawHead);"), "lucklab: live head validated before it can promote the snapshot");
  const html = read("pages/luck-lab/index.html");
  ok(html.includes("app.js?v=1.48.14"), "lucklab: app.js cache key bumped for the boundary fix");
  ok(!html.includes("(refreshed 2026-10-02)"), "lucklab: footer no longer pins the snapshot refresh to the stale Oct 2 date");
}

// Batch 30 (2026-10-10 15:19): vesting-desk round 2 (Tier 2) — the
// 2026-10-09 boundary validated shapes per schedule, but five classes
// still anchored: cliff < start (vestedAmount measures elapsed from
// start, so the hero painted NEGATIVE vested, -42,262 QTC, and locked
// exceeded the pool); a (start,end) outside the three genesis cohorts
// counted into hero/chart/table but no cohort card or filter could
// show it; a single total above the whole 5,670,000 QTC genesis mint
// anchored (locked painted 10,005,451,072 QTC); block_height was any
// digit string (a 40-digit height painted as block 1e40); and a
// parseable-but-disagreeing fetched_at (1999) was echoed as provenance
// while the math anchored on fetched_at_ms. Plus stale hard-coded
// cohort notes (intents "~2,441 vested" vs actual 3,617.983; liquidity
// "171,475 claimed" vs actual fully claimed 210,000). Pin: cliff >=
// start, known-cohort-only, genesis-mint cap, fleet validBlockHeight,
// fetched_at always re-derived from fetched_at_ms, cohort notes and
// the claimed sub computed from the loaded rows, and the Node module
// hook that makes the boundary unit-testable.
{
  const src = read("pages/vesting-desk/app.js");
  ok(src.includes("if (BigInt(cliff) < BigInt(start)) return null;"), "vesting2: cliff before start is rejected (no negative vested)");
  ok(src.includes('VC.cohortOf(start, end) === "unknown"'), "vesting2: schedules outside the genesis cohorts are rejected");
  ok(src.includes("BigInt(total) > VC.GENESIS_MINT_QTC * Q"), "vesting2: a schedule total above the genesis mint is rejected");
  ok(src.includes("function validBlockHeight(v)"), "vesting2: validBlockHeight() defined (fleet 1..10,000,000 shape)");
  ok(src.includes("block_height: validBlockHeight(raw.block_height)"), "vesting2: snapshot block_height goes through validBlockHeight");
  ok(src.includes("const fetchedAt = new Date(Number(fetchedMs)).toISOString();"), "vesting2: fetched_at always re-derived from fetched_at_ms");
  ok(!src.includes("isFinite(Date.parse(raw.fetched_at))"), "vesting2: raw fetched_at string is never echoed as provenance");
  ok(src.includes("function cohortNote(key, rows, vested, claimed, total)"), "vesting2: cohort notes computed from the loaded rows");
  ok(!src.includes("2,441 QTC had vested"), "vesting2: stale hard-coded intents vested figure is gone");
  ok(!src.includes("171,475 of 210,000"), "vesting2: stale hard-coded liquidity claimed figure is gone");
  ok(src.includes('$("st-claimed-sub")'), "vesting2: claimed sub derived from which schedules actually claimed");
  ok(src.includes("module.exports = { validSchedule, validateSchedules, validBlockHeight, validFetchedAtMs };"), "vesting2: Node module hook exports the boundary");
  const html = read("pages/vesting-desk/index.html");
  ok(html.includes("app.js?v=1.31.0"), "vesting2: app.js cache key bumped for the boundary fix");
  ok(html.includes('id="st-claimed-sub"'), "vesting2: claimed sub has the id the app writes");
  ok(!html.includes("96% locked"), "vesting2: hero no longer pins a drifting locked percentage");
}

// Batch 31 (2026-10-10 16:19): whale-watch round 2 (Tier 2) — the
// 2026-10-09 boundary validated shapes per field, but the desk still
// broke on RELATIONS between fields: bracket counts/sums were never
// reconciled with accounts_total / supply.free and a bracket average
// could sit outside its own band; locked could be split across a
// non-pool row (each row still satisfied liquid == free - locked) or
// fall short of vesting total - claimed; the whale bracket could
// disagree with the top list; a top row could outweigh the whole
// supply (top-10 share painted 1099.13%); block_height was any safe
// integer (badge painted block 9,007,199,254,740,991); fetched_at
// could be in the far future (staleness warning defeated); moves
// could postdate their snapshot and "recent" moves owed neither the
// >= 10 QTC nor the 7-day contract; genesis rows could sit at any
// block from any origin; a malformed reserved silently became "0".
// Pin: partition + band + pool-identity + whale cross-checks fail the
// snapshot honestly; time/genesis/reserved poison drops its row.
{
  const src = read("pages/whale-watch/app.js");
  ok(src.includes("bracketCountSum !== accounts || bracketSumTotal !== BigInt(sFree)"), "whale2: brackets must partition accounts and free supply exactly");
  ok(src.includes("BRACKET_BOUNDS"), "whale2: per-bracket average band bounds defined");
  ok(src.includes("lockedSum !== BigInt(vTotal) - BigInt(vClaimed)"), "whale2: summed top locked must equal unclaimed vesting to the planck");
  ok(src.includes("if (lockers > 1) return null;"), "whale2: at most one top entry may carry locked");
  ok(src.includes("inTopWhales.length !== whaleBracket.count"), "whale2: whale bracket count must agree with the top list");
  ok(src.includes("if (topFreeSum > BigInt(sFree)) return null;"), "whale2: the top list cannot outweigh the supply");
  ok(src.includes("function validBlockHeight(v)"), "whale2: validBlockHeight() defined (fleet 1..10,000,000 shape)");
  ok(src.includes("fetchedMs > Date.now() + 3600000"), "whale2: a future fetched_at fails the snapshot");
  ok(src.includes("RECENT_MIN_PLANCKS"), "whale2: recent moves owe the >= 10 QTC contract");
  ok(src.includes("if (bh !== 1) return;"), "whale2: genesis allocations must sit at block 1");
  ok(src.includes("poolEntry.address !== genesis[0].to"), "whale2: the pool must be the block-1 allocation recipient");
  ok(src.includes('raw.reserved_plancks == null ? "0" : decStr(raw.reserved_plancks)'), "whale2: present-but-malformed reserved drops its row, never silently zeroed");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.21.0"), "whale2: app.js cache key bumped for the round-2 fix");
}

// Batch 32 (2026-10-10 17:19): tokenomics (Tier 2) — the live tiles
// anchor modeled supply + block reward to a single external scalar,
// the block height, arriving via direct GraphQL and the live.json
// snapshot fallback. Both paths were guarded only by `h > 0` (Batch 6
// pinned the fall-through shape but never the validation): an absurd
// height (9,007,199,254,740,991) painted with supply 21,000,000 /
// reward 0.0000, a boolean painted block 1, fractional/scientific
// heights coerced mid-block, and the snapshot's ok flag + fetched_at
// were never consulted (far-future capture time; status height
// disagreeing with the snapshot's own blocks[0]). Pin: one boundary
// (fleet validBlockHeight + liveHeightFromGraphQL /
// liveHeightFromSnapshot) gates both paths, snapshot requires ok:true,
// a real capture time, and status/blocks[0] agreement.
{
  const src = read("pages/tokenomics/app.js");
  ok(src.includes("function validBlockHeight(v)"), "tokenomics2: validBlockHeight() defined (fleet 1..10,000,000 shape)");
  ok(src.includes("function liveHeightFromGraphQL(j)"), "tokenomics2: liveHeightFromGraphQL() defined");
  ok(src.includes("function liveHeightFromSnapshot(p)"), "tokenomics2: liveHeightFromSnapshot() defined");
  ok(src.includes("p.ok !== true"), "tokenomics2: snapshot must carry ok:true");
  ok(src.includes("fetchedMs > Date.now() + 3600000"), "tokenomics2: a future fetched_at fails the snapshot");
  ok(src.includes("fetchedMs < GENESIS_FLOOR_MS"), "tokenomics2: a pre-genesis fetched_at fails the snapshot");
  ok(src.includes("bh !== h"), "tokenomics2: status height must agree with blocks[0]");
  ok(src.includes("var h = liveHeightFromGraphQL(j);"), "tokenomics2: GraphQL height goes through the boundary");
  ok(src.includes("var h = liveHeightFromSnapshot(p);"), "tokenomics2: snapshot height goes through the boundary");
  ok(!src.includes("if (h > 0)"), "tokenomics2: no coercion-only height guard remains");
  ok(src.includes("liveHeightFromSnapshot: liveHeightFromSnapshot"), "tokenomics2: Node module hook exports the boundary");
  const html = read("pages/tokenomics/index.html");
  ok(html.includes("app.js?v=1.10.0"), "tokenomics2: app.js cache key bumped for the boundary fix");
}

// ---- 33. Consensus Lab round 2 (2026-10-10 18:19): the validator checked
// shapes only — head 9,007,199,254,740,991 finite, any parseable
// fetched_at, stats that need not summarize their own window. Round 2
// checks the RELATIONS the generator guarantees (see
// scripts/fetch-consensus-data.mjs): head == current.height, hashrate ==
// difficulty/12, hex == difficulty, net_change recomputes exactly, the
// block-time stats equal the recomputed stats of last[], blocks_indexed +
// missing == head, trend/recent tails == current, trend[0] == genesis.
{
  const core = read("pages/consensus-lab/consensus-core.js");
  ok(core.includes("export function validBlockHeight(v)"), "consensus2: validBlockHeight() defined (fleet 1..10,000,000 shape)");
  ok(core.includes("j.ok !== true"), "consensus2: snapshot must carry ok:true");
  ok(core.includes("fetchedMs > nowMs + 3600000"), "consensus2: a future fetched_at fails the snapshot");
  ok(core.includes("fetchedMs < GENESIS_FLOOR_MS"), "consensus2: a pre-genesis fetched_at fails the snapshot");
  ok(core.includes("j.blocks_indexed + j.missing_heights !== head"), "consensus2: indexed + missing must equal the head");
  ok(core.includes("validBlockHeight(cur.height) !== head"), "consensus2: current.height must agree with head");
  ok(core.includes('cur.difficulty_hex !== "0x" + D.toString(16)'), "consensus2: difficulty_hex must restate difficulty");
  ok(core.includes("digitBig(cur.est_hashrate_hs) !== D / 12n"), "consensus2: hashrate must equal difficulty / 12 exactly");
  ok(core.includes("d.net_change_pct !== Number(((D - INITIAL_DIFF) * 10000n) / INITIAL_DIFF) / 100"), "consensus2: net_change_pct must recompute exactly");
  ok(core.includes("bt.avg_ms !== Math.round(mean)"), "consensus2: avg_ms must be the window's own mean");
  ok(core.includes("bt.sample !== last.length"), "consensus2: sample must count the window it summarizes");
  ok(core.includes("bt.longest_gap_ms < bt.max_ms"), "consensus2: the all-time gap cannot be below the window max");
  ok(core.includes('j.trend[0][2] !== INITIAL_DIFF.toString()'), "consensus2: trend must start at the genesis point");
  ok(core.includes("trendTail[2] !== cur.difficulty || recentTail[2] !== cur.difficulty"), "consensus2: trend/recent tails must land on current");
  const html = read("pages/consensus-lab/index.html");
  ok(html.includes("app.js?v=1.38.0"), "consensus2: app.js cache key bumped for the boundary fix");
}

// Batch 34 (2026-10-10 19:19): reversal-desk round 2 (Tier 2) — the
// desk trusted data/reversal.json except for `snap.ok`: the height was
// any truthy value (absurd / fractional / scientific-string / boolean
// all painted and anchored the planner ETA + quota ages), fetched_at
// was never consulted, totals painted raw with pending computed via
// `|| 0` (a null total silently became 0; cancelled + executed could
// exceed scheduled for a negative pending), the chain_stats scheduled
// total was never reconciled with the aggregate total, list lengths
// were never reconciled with the fetcher's limit:25 / counts, and
// queue rows rendered raw. Pin: one boundary (validateSnapshot in
// reversal-core.js) checks shapes AND relations; poison fails the
// snapshot honestly, a malformed row drops out of its queue.
{
  const core = read("pages/reversal-desk/js/reversal-core.js");
  const src = read("pages/reversal-desk/js/app.js");
  ok(core.includes("function validateSnapshot(raw, nowMs)"), "reversal2: validateSnapshot() defined in reversal-core.js");
  ok(core.includes("function validBlockHeight(v)"), "reversal2: validBlockHeight() defined (fleet 1..10,000,000 shape)");
  ok(core.includes("raw.ok !== true"), "reversal2: snapshot must carry ok:true");
  ok(core.includes("fetchedMs > now + 3600000"), "reversal2: a future fetched_at fails the snapshot");
  ok(core.includes("fetchedMs < GENESIS_FLOOR_MS"), "reversal2: a pre-genesis fetched_at fails the snapshot");
  ok(core.includes("totals.scheduled !== statusTotal"), "reversal2: status total must agree with the aggregate total");
  ok(core.includes("totals.cancelled + totals.executed > totals.scheduled"), "reversal2: cancelled + executed cannot exceed scheduled");
  ok(core.includes("Math.min(SNAPSHOT_LIST_CAP, total)"), "reversal2: list length must equal min(cap, total)");
  ok(core.includes("if (ms > prevMs) return null;"), "reversal2: lists must stay newest-first as the fetcher orders them");
  ok(src.includes("RC.validateSnapshot(snap)"), "reversal2: renderLive goes through the boundary");
  ok(src.includes("t.cancelled == null || t.executed == null"), "reversal2: pending is derived only from known totals (null paints —)");
  ok(!src.includes("(t.scheduled || 0) - (t.cancelled || 0)"), "reversal2: no || 0 pending fabrication remains");
  const html = read("pages/reversal-desk/index.html");
  ok(html.includes("js/app.js?v=1.52.0"), "reversal2: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/reversal-core.js?v=1.52.0"), "reversal2: reversal-core.js cache key bumped for the boundary fix");
}

// Batch 35 (2026-10-10 20:19): exposure-lab round 2 (Tier 2) — round 1
// validated each BTC/ETH API field's shape, but the relations between
// fields were unchecked (spent outputs could exceed funded, a zero
// tx_count could coexist with a balance, n_tx 0 could coexist with
// received value), no client checked that an answer was FOR the
// address asked, and the Blockscout fallback's 1-wei sent sentinel
// rendered as a sent amount ("has sent 0.000000000000000001 ETH").
// Pin: the core sanitizers reject relational poison, every client
// verifies response identity, and the fallback evidence names itself.
{
  const core = read("pages/exposure-lab/js/exposure-core.js");
  const src = read("pages/exposure-lab/js/app.js");
  ok(core.includes("if (spent > funded) return null;"), "exposure2: spent outputs cannot exceed funded outputs");
  ok(core.includes("tx === 0 && (spent > 0 || funded > 0 || bal > 0)"), "exposure2: zero transactions cannot coexist with funded/spent/balance");
  ok(core.includes("bal > 0 && funded <= spent"), "exposure2: a positive balance needs an unspent funded output");
  ok(core.includes('nTx === 0 && (sent !== "0" || recv !== "0" || bal !== "0")'), "exposure2: ETH n_tx 0 cannot coexist with value");
  ok(core.includes("if (api.sent_signal === true) out.sent_signal = true;"), "exposure2: sanitize preserves the sent_signal flag");
  ok(core.includes("Blockscout fallback: sent/not-sent signal only"), "exposure2: fallback evidence names the fallback, never the sentinel amount");
  ok(src.includes("mempool.space answer for a different address"), "exposure2: mempool answer identity is verified");
  ok(src.includes("BlockCypher answer for a different address"), "exposure2: BlockCypher answer identity is verified");
  ok(src.includes("Blockscout answer for a different address"), "exposure2: Blockscout answer identity is verified");
  ok(src.includes("fh.toLowerCase() === addr.toLowerCase()"), "exposure2: a Blockscout item proves a send only when its sender is this address");
  ok(src.includes("sent_signal: sent,"), "exposure2: the fallback marks its sent sentinel as a signal");
  const html = read("pages/exposure-lab/index.html");
  ok(html.includes("js/exposure-core.js?v=1.54.0"), "exposure2: exposure-core.js cache key bumped for the boundary fix");
  ok(html.includes("js/app.js?v=1.54.0"), "exposure2: app.js cache key bumped for the boundary fix");
}

// Batch 36 (2026-10-10 21:19): network-dashboard round 2 (Tier 2) —
// round 1 (Batch 23) validated each field's shape, but the relations
// between fields were unchecked: an absurd (MAX_SAFE_INTEGER) or zero
// status height anchored the supply/reward estimates, a blocks list
// whose head disagreed with the status height (or ran ascending, or
// duplicated a block) painted as the chain head, a well-shaped but
// impossible block reward (999 QTC, or 0) rendered as fact even
// though the emission schedule caps rewards near 0.31 QTC, a daily
// row could claim more active accounts than the chain has ever had,
// and the snapshot's fetched_at was never required to be a real
// capture time. Pin: validBlockHeight/validFetchedAt gate the height
// and capture time, the head/order/duplicate relations reject or drop
// before render, rewardPlausible ties every reward to the emission
// schedule for its own height, and fetchSnapshot rejects a bogus
// capture time like any other failed fetch.
{
  const app = read("pages/network-dashboard/app.js");
  ok(app.includes("function validBlockHeight(v)"), "netdash2: validBlockHeight() defined (fleet height shape)");
  ok(app.includes("function validFetchedAt(v, nowMs)"), "netdash2: validFetchedAt() defined (real capture times only)");
  ok(app.includes("function rewardPlausible(height, rewardPlanckStr)"), "netdash2: rewardPlausible() ties rewards to the emission schedule");
  ok(app.includes("if (rawHead !== null && rawHead !== height) return null;"), "netdash2: blocks head must agree with the status height");
  ok(app.includes("if (aa > accounts) return;"), "netdash2: a day's active accounts cannot exceed all accounts");
  ok(app.includes('if (validFetchedAt(payload.fetched_at) === null) throw new Error("snapshot capture time invalid");'), "netdash2: fetchSnapshot rejects a bogus capture time");
  const html = read("pages/network-dashboard/index.html");
  ok(html.includes("app.js?v=1.10.0"), "netdash2: app.js cache key bumped for the round-2 fix");
}

// Batch 37 (2026-10-10 22:19): supply-audit round 2 (Tier 2) — round 1
// (Batch 24) validated each field's shape; the relations between fields
// were unchecked: reward_events could disagree with block_height, a
// genesis transfer could come from a non-sentinel account (or the list
// could run ascending, so a 3 QTC grant posed as the vesting pool, or
// repeat a recipient), the vesting pool_account could point anywhere
// and pool_free float free of what the pool received and paid out, a
// mined total of 0.01 QTC across ~203k reward events painted as fact,
// the snapshot's redundant totals (total_supply_plancks, sentinel
// out_count/out_total) were never restated against their components,
// fetched_at needed only to parse, and the auxiliary live.json overlay
// capped rewards at a shape-only 10 QTC so a 9 QTC "reward" painted
// on the chart. Pin: sanitizeSupply validates the relations (all
// verified exact/plausible in live data at height 203,246 before
// tightening), and cleanBlocks ties the overlay to the audited
// subsidy and the snapshot's own status head.
{
  const core = read("pages/supply-audit/js/audit-core.js");
  ok(core.includes("function validBlockHeight(v)"), "supply3: validBlockHeight() defined (fleet height shape)");
  ok(core.includes("function validFetchedAt(v, nowMs)"), "supply3: validFetchedAt() defined (real capture times only)");
  ok(core.includes('if (rewardEvents !== h) malformed("mined.reward_events != block_height")'), "supply3: one MinerRewarded per block — events must equal the height");
  ok(core.includes("is not from the mint sentinel"), "supply3: every genesis transfer flows from the mint sentinel");
  ok(core.includes("genesis.transfers is not amount-descending"), "supply3: genesis list runs amount-descending (row 0 is the pool)");
  ok(core.includes("duplicates a genesis recipient"), "supply3: genesis recipients are distinct");
  ok(core.includes("vesting.pool_account is not the genesis pool recipient"), "supply3: vesting pool identity is genesis row 0");
  ok(core.includes("vesting.pool_free_plancks != genesis pool allocation - claimed"), "supply3: pool free == received - claimed, to the planck");
  ok(core.includes("mined.total_plancks below the schedule floor for its event count"), "supply3: mined total floored by the emission schedule");
  ok(core.includes("total_supply_plancks != free+reserved+frozen"), "supply3: redundant supply total restates its components");
  ok(core.includes("mint_sentinel outflows below the recorded rewards"), "supply3: sentinel outflows cover the recorded rewards");
  const app = read("pages/supply-audit/app.js");
  ok(app.includes("total_supply_plancks: (BigInt(core.totals.aggregate.sum.free) +"), "supply3: live builder restates the supply total for cross-checking");
  ok(app.includes("if (heights[0] !== head) return null;"), "supply3: aux overlay head must agree with its own status height");
  const html = read("pages/supply-audit/index.html");
  ok(html.includes("js/audit-core.js?v=1.30.0"), "supply3: audit-core cache key bumped for the round-2 fix");
  ok(html.includes("app.js?v=1.32.0"), "supply3: app.js cache key bumped for the round-2 fix");
}

// Batch 38 (2026-10-10 23:19): web-wallet Activity round 2 (Tier 1) —
// round 1 (Batch 12) validated each indexer row's shape; the RELATIONS
// were unchecked: a transfer between two strangers painted as this
// wallet's history, non-SS58 endpoints painted, height 2^53-1 and a
// 100M QTC amount (over the 21M supply cap) painted, a future-dated
// row painted, an ascending list painted as "Recent transfers", a
// duplicated transfer id rendered twice, and a 26-row payload painted
// despite the query's limit:25. Pin: sanitizeActivityRows in
// rpc-validate.js validates the relations (all verified against live
// indexer data at height 203,723 before tightening) and app.js routes
// every payload through it.
{
  const val = read("pages/web-wallet/js/rpc-validate.js");
  ok(val.includes("export function validBlockHeight(v)"), "wallet2: validBlockHeight() defined (fleet height shape)");
  ok(val.includes("export function sanitizeActivityRows(raw, address, nowMs"), "wallet2: sanitizeActivityRows() defined");
  ok(val.includes("if (t.from_id !== address && t.to_id !== address) continue;"), "wallet2: a row must be a transfer OF the queried wallet");
  ok(val.includes("return prefix === 189;"), "wallet2: endpoints must be real SS58-189 addresses");
  ok(val.includes("MAX_SUPPLY_PLANCKS = 21000000000000000000n"), "wallet2: amounts bounded by the 21M QTC supply cap");
  ok(val.includes("raw.length > ACTIVITY_LIMIT"), "wallet2: over-limit payloads are malformed (limit:25 contract)");
  ok(val.includes("rows[i].block_height > rows[i - 1].block_height) return null;"), "wallet2: kept rows must run newest-first, else the payload is malformed");
  ok(val.includes("seen.has(t.id)"), "wallet2: duplicate transfer ids drop");
  const rpc = read("pages/web-wallet/js/rpc.js");
  ok(rpc.includes("rpc-validate.js?v=1.1.0"), "wallet2: rpc.js pins the bumped rpc-validate module");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './rpc-validate.js?v=1.1.0'"), "wallet2: app.js imports the sanitizer from the bumped module");
  ok(!app.includes("function validActivityRow(t)"), "wallet2: the round-1 shape-only row check is gone");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes("js/app.js?v=1.42.0"), "wallet2: app.js cache key bumped for the round-2 fix");
}

// Batch 39 (2026-10-11 00:19): Key Forge verdict staleness (Tier 1) —
// every rendered verdict is a function of specific inputs, but nothing
// voided any of them: a "Valid Quantus address" badge stayed up after
// the address was replaced with garbage, a hex-encode result stayed up
// after the hex was edited, a "Signed & verified" panel (with its copy/
// download buttons for the signature) stayed up after the message was
// edited OR a new keypair was forged (that signature was the old key's),
// and a verify verdict stayed up after any of its three inputs changed
// — including the programmatic useForgedPk fill, which fires no input
// event. Pin: the four void functions exist, are wired to every
// determinant (input listeners + explicit voids in forge() and
// useForgedPk), and each render path marks its panel rendered.
{
  const app = read("pages/key-forge/js/app.js");
  ok(app.includes("function voidInsp(what)"), "keyforge: voidInsp() defined");
  ok(app.includes("function voidHex(what)"), "keyforge: voidHex() defined");
  ok(app.includes("function voidSign(what)"), "keyforge: voidSign() defined");
  ok(app.includes("function voidVerify(what)"), "keyforge: voidVerify() defined");
  ok(app.includes("$('inspAddr').addEventListener('input'"), "keyforge: inspector verdict voids on address edit");
  ok(app.includes("$('inspHex').addEventListener('input'"), "keyforge: hex verdict voids on hex edit");
  ok(app.includes("$('signMsg').addEventListener('input'"), "keyforge: sign verdict voids on message edit");
  ok(app.includes("$('verPubkey').addEventListener('input'"), "keyforge: verify verdict voids on pubkey edit");
  ok(app.includes("$('verMsg').addEventListener('input'"), "keyforge: verify verdict voids on message edit");
  ok(app.includes("$('verSig').addEventListener('input'"), "keyforge: verify verdict voids on signature edit");
  ok(app.includes("voidSign('a new keypair was forged"), "keyforge: forging a new key explicitly voids the old key's sign panel");
  ok(app.includes("voidVerify('the public key was replaced with the forged key"), "keyforge: useForgedPk fill explicitly voids the verify verdict");
  ok(app.includes("inspRendered = true;"), "keyforge: inspector render marks its panel rendered");
  ok(app.includes("hexRendered = true;"), "keyforge: hex render marks its panel rendered");
  ok(app.includes("signRendered = true;"), "keyforge: sign render marks its panel rendered");
  ok(app.includes("verifyRendered = true;"), "keyforge: verify render marks its panel rendered");
  const html = read("pages/key-forge/index.html");
  ok(html.includes("js/app.js?v=1.3.0"), "keyforge: app.js cache key bumped for the staleness fix");
}

// Batch 40 (2026-10-11 01:19): Block Explorer round 2 (Tier 1) —
// validate RELATIONS, not just shapes. Round 1 checked each field
// alone, so a home payload whose blocks head disagreed with its own
// stats painted, a 999 QTC reward painted (the schedule pays ~0.305),
// a 100M QTC transfer painted (over the 21M cap), ascending/future
// lists painted as "latest", a stranger-to-stranger transfer painted
// as the queried account's own outgoing history, balances summing
// past the cap painted, duplicate extrinsic indices and foreign
// events painted, and a block returned for the wrong height painted.
// Pin: fleet height/chain-time/strict-address validators, the supply
// cap and emission-schedule relations, list limits and newest-first
// order with payload-level rejection, cleanAccountData gating the
// account view, and blockMatchesKey gating the block view.
{
  const src = read("pages/block-explorer/app.js");
  ok(src.includes("function validAddress(v)"), "explorer2: strict SS58-189 address validator defined");
  ok(src.includes("function rewardPlausible(height, rewardPlanckStr)"), "explorer2: emission-schedule reward relation defined");
  ok(src.includes("function planckWithinSupply(p)"), "explorer2: 21M supply-cap relation defined");
  ok(src.includes("function cleanAccountData(d, id)"), "explorer2: account payload cleaner defined");
  ok(src.includes("function blockMatchesKey(b, key)"), "explorer2: block/key match defined");
  ok(src.includes("cleanAccountData(d, id)"), "explorer2: account view gates on cleanAccountData");
  ok(src.includes("blockMatchesKey(b, key)"), "explorer2: block view gates on blockMatchesKey");
  ok(src.includes("t.from_id !== id && t.to_id !== id"), "explorer2: account transfers must involve the queried account");
  ok(src.includes("rawHead !== stats.block_height"), "explorer2: home head must restate the stats height");
  ok(src.includes("d.blocks.length > HOME_LIMIT"), "explorer2: home lists respect their query limit");
  ok(src.includes("d.t.length > ACCOUNT_TX_LIMIT"), "explorer2: account transfers respect limit:25");
  ok(src.includes("MAX_SUPPLY_PLANCKS"), "explorer2: supply cap constant present");
  const html = read("pages/block-explorer/index.html");
  ok(html.includes("app.js?v=1.3.0"), "explorer2: app.js cache key bumped for the round-2 fix");
}

// Batch 41 (2026-10-11 02:19): Chain Console round 2 (Tier 1) —
// validate RELATIONS, not just shapes. Round 1 checked each RPC field
// alone, so a syncState whose currentBlock sat ABOVE its highestBlock
// painted "synced" (the gap went negative), a header/block/peer height
// of 99,999,999,999 painted as chain fact, non-hex strings in a block's
// extrinsics list inflated its count and byte total, a duplicated
// peerId painted the same peer twice, and a finalized-heads feed
// logged regressing/duplicate heads — finality re-narrated. Pin: the
// fleet height bound in core (validChainHeight, genesis 0 valid over
// RPC), validExtrinsicHex gating block counts, peer dedup, the
// syncState order relation in summarizeSyncState, and the finalized
// monotonic gate fed by feedLog's stored head height.
{
  const core = read("pages/chain-console/js/core.js");
  ok(core.includes("export function validChainHeight(v)"), "console2: validChainHeight() defined in core");
  ok(core.includes("export function validExtrinsicHex(s)"), "console2: validExtrinsicHex() defined in core");
  ok(core.includes("export function summarizeSyncState(r)"), "console2: summarizeSyncState() defined in core");
  ok(core.includes("if (!(startingBlock <= currentBlock && currentBlock <= highestBlock)) return null"), "console2: sync order relation enforced");
  ok(core.includes("if (seen.has(p.peerId)) continue;"), "console2: duplicate peer identities dropped");
  ok(core.includes("const number = validChainHeight(h.number);"), "console2: header height bound to the chain");
  ok(core.includes("filter(validExtrinsicHex)"), "console2: block extrinsics must be extrinsic hex");
  const app = read("pages/chain-console/js/app.js");
  ok(app.includes("const s = summarizeSyncState(r);"), "console2: sync summarizer gates on the relation");
  ok(app.includes("if (prev && typeof prev.num === 'number' && num <= prev.num) return null;"), "console2: finalized heads cannot regress or repeat");
  ok(app.includes("num: n && typeof n === 'object' ? validChainHeight(n.number) : null"), "console2: feedLog stores the logged head height");
  const html = read("pages/chain-console/index.html");
  ok(html.includes("js/app.js?v=1.45.0"), "console2: app.js cache key bumped for the round-2 fix");
}

// Batch 42 (2026-10-11 03:19): Extrinsic Lab round 2 (Tier 1) —
// validate RELATIONS, not just shapes. Round 1 checked each RPC field
// alone, so a finalized header number of 99,999,999,999 painted as
// chain fact in BOTH the Verify context and the Live scanner, a
// specVersion of 2^32 anchored a verdict (wrapping to 0 in the
// payload's u32le — parseVersionNumber documented "u32" but never
// bounded it), an era-birth block AFTER the finalized head fetched a
// "birth hash" for a block that cannot exist yet, a fetched context
// for an immortal extrinsic left a previous extrinsic's era-birth hash
// standing (immortal birth IS genesis), the manual Verify path coerced
// its fields with parseInt(...)||default (truncation, silent 153/6
// substitution, u32 wrap) and rendered VALID for a target block before
// the era-birth block, and the scanner painted a duplicated extrinsic
// and a trailing-byte entry as clean decoded rows. Pin: the fleet
// validChainHeight in rpc-validate gating both header numbers,
// parseVersionNumber enforcing its u32 bound, verify.js refusing
// out-of-range versions / short hashes instead of wrapping, the
// era-birth <= head gate before the birth-hash request, the fetched
// context always restating v-block and clearing v-birth for immortal,
// the manual path parsing through the validators with the era-birth
// and immortal-genesis relations as errors, and the scanner's
// duplicate / length-trailing malformed rows.
{
  const core = read("pages/extrinsic-lab/js/rpc-validate.js");
  ok(core.includes("function validChainHeight(v)"), "extrinsic2: validChainHeight() defined in rpc-validate");
  ok(core.includes("n <= MAX_U32 ? n : null"), "extrinsic2: parseVersionNumber enforces the u32 bound");
  ok(core.includes("var MAX_CHAIN_HEIGHT = 10000000"), "extrinsic2: fleet 10,000,000 height bound present");
  const vf = read("pages/extrinsic-lab/js/verify.js");
  ok(vf.includes("must be a u32 integer"), "extrinsic2: verifyExtrinsic refuses out-of-range versions instead of wrapping");
  const app = read("pages/extrinsic-lab/js/app.js");
  ok(app.includes("R.validChainHeight(header.number)"), "extrinsic2: context header height bound to the chain");
  ok(app.includes("R.validChainHeight(hdr.number)"), "extrinsic2: scanner header height bound to the chain");
  ok(app.includes("is after the finalized head"), "extrinsic2: era-birth after the head fails the context fetch");
  ok(app.includes("$('v-birth').value = birthHash || '';"), "extrinsic2: fetched context clears v-birth for immortal/no extrinsic");
  ok(app.includes("R.parseVersionNumber($('v-spec').value.trim())"), "extrinsic2: manual verify parses spec through the validator");
  ok(!app.includes("parseInt($('v-spec').value.trim(), 10) || 153"), "extrinsic2: no silent parseInt spec fallback remains");
  ok(app.includes("is before this extrinsic"), "extrinsic2: target before era-birth is an error, not a verdict");
  ok(app.includes("Immortal era: the era-birth hash is the genesis hash"), "extrinsic2: immortal era-birth must equal genesis");
  ok(app.includes("duplicate entry"), "extrinsic2: scanner labels a duplicated extrinsic entry");
  ok(app.includes("the length prefix does not match the entry bytes"), "extrinsic2: scanner labels length/trailing-mismatched entries malformed");
  const html = read("pages/extrinsic-lab/index.html");
  ok(html.includes("js/app.js?v=1.45.0"), "extrinsic2: app.js cache key bumped for the round-2 fix");
  ok(html.includes("js/rpc-validate.js?v=1.1.0"), "extrinsic2: rpc-validate.js cache key bumped for the round-2 fix");
  ok(html.includes("js/verify.js?v=1.40.1"), "extrinsic2: verify.js cache key bumped for the round-2 fix");
}

// Batch 43 (2026-10-11 04:19): Notary Desk round 2 (Tier 1) — validate
// RELATIONS, not just shapes. Round 1's sanitizeVault checked each
// vault field alone, so an anchor whose stored call carried a
// DIFFERENT payload than its envelope (another document, a raw "hi")
// survived — the vault and verify fingerprint described one document
// while the broadcastable call anchored another; a call whose compact
// length prefix lied or which carried a trailing byte survived; a
// block annotation of 10^23 (or 0) stood as a landing claim. The
// events decoder accepted trailing bytes after the last record and a
// Remarked record under the Finalization phase. The board had no
// fleet height bound (a 99,999,999,999 header painted), never checked
// the returned block was the height it asked for, recovered payloads
// from ANY same-hash extrinsic instead of the one the record's
// ApplyExtrinsic phase names, accepted extrinsics whose length prefix
// or payload did not end the entry exactly, and deduped board rows by
// (block, hash) — silently dropping a second sender's anchor of the
// same bytes. Pin: the codec's call-structure + payload==envelope
// relations and bounded block annotation, decodeSystemEvents'
// exact-consumption + ApplyExtrinsic-only Remarked, the app's
// validChainHeight gates, expected-height check, phase-index payload
// recovery, exact length/payload ends, and the sender-keyed dedup.
{
  const codec = read("pages/notary-desk/js/notary-codec.js");
  ok(codec.includes("function validChainHeight(v)"), "notary2: validChainHeight() defined in codec");
  ok(codec.includes("var MAX_CHAIN_HEIGHT = 10000000"), "notary2: fleet 10,000,000 height bound present");
  ok(codec.includes("cpl.next + cpl.value !== callBytes.length"), "notary2: vault call length prefix must end the call exactly");
  ok(codec.includes("bytesToHex(payloadBytes) !== envelopeHex"), "notary2: vault call payload must equal the stored envelope");
  ok(codec.includes("Remarked event outside ApplyExtrinsic phase"), "notary2: a Remarked record outside ApplyExtrinsic is malformed");
  ok(codec.includes("trailing bytes after the last event record"), "notary2: event records must consume the blob exactly");
  const app = read("pages/notary-desk/js/app.js");
  ok(app.includes("C.validChainHeight(blockNum)"), "notary2: board block height bound to the chain");
  ok(app.includes("node returned a block for a different height than requested"), "notary2: a block answering a different height is an error");
  ok(app.includes("await processBlock(hash, hn)"), "notary2: live watch passes its head height as the expected height");
  ok(app.includes("await processBlock(hash, n)"), "notary2: scan passes each requested height as the expected height");
  ok(app.includes("lc.value !== b.length - o"), "notary2: spotRemarkCall requires the length prefix to cover the entry exactly");
  ok(app.includes("pl.next + pl.value !== b.length"), "notary2: spotRemarkCall requires the payload to end the entry exactly");
  ok(app.includes('blockNum + ":" + senderHex + ":" + eventHash'), "notary2: board dedup keys on (block, sender, hash)");
  ok(app.includes("r.phase.kind === \"ApplyExtrinsic\"") || app.includes("kind === \"ApplyExtrinsic\" ? r.phase.index"), "notary2: payload recovery follows the record's phase index");
  const html = read("pages/notary-desk/index.html");
  ok(html.includes("js/app.js?v=1.53.0"), "notary2: app.js cache key bumped for the round-2 fix");
  ok(html.includes("js/notary-codec.js?v=1.49.0"), "notary2: notary-codec.js cache key bumped for the round-2 fix");
}

// Batch 44 (2026-10-11 06:19): Airgap Desk round 2 (Tier 1) — validate
// RELATIONS, not just shapes. Round 1 shape-checked each ticket field and
// chunk line alone, so a ticket whose era birth was not congruent to its
// phase, whose window had already expired at its own head, whose period
// the SCALE mortal-era codec cannot encode, or whose spec/tx version
// wrapped u32le in the signing payload was accepted and signed against;
// a chunk session assembled a conflicting duplicate first-copy-wins, a
// short middle chunk shifted every later byte, and a 1/999999999 count
// ground the missing-list construction; and a FAILED ticket import left
// the previous ticket installed and signable. Pin: decodeTicket's era /
// u32 / height relations, decodeChunks' duplicate / uniform-size / count
// relations, and importTicketString voiding the standing ticket on a
// refused replacement.
{
  const core = read("pages/airgap-desk/js/airgap.js");
  ok(core.includes("era.period must be a power of two in 4..65536"), "airgap2: era period must be SCALE-encodable");
  ok(core.includes("era.phase must be a multiple of the era quantize step"), "airgap2: era phase must respect the quantize step");
  ok(core.includes("era.birth must be congruent to era.phase mod era.period"), "airgap2: era birth must be congruent to phase");
  ok(core.includes("era window already expired at the ticket head"), "airgap2: era window must contain the ticket head");
  ok(core.includes("must fit u32 (<= 4294967295)"), "airgap2: spec/tx versions must fit u32, never wrap in the payload");
  ok(core.includes("head is above the fleet chain-height bound (10000000)"), "airgap2: ticket head bound to the fleet chain height");
  ok(core.includes("export const MAX_CHUNKS = 10000"), "airgap2: chunk count bound present");
  ok(core.includes("conflicting duplicate (two different copies in one session)"), "airgap2: a conflicting duplicate is refused, never first-copy-wins");
  ok(core.includes("reassembly would shift the payload"), "airgap2: a short middle chunk is refused, never byte-shifted");
  const app = read("pages/airgap-desk/js/app.js");
  ok(app.includes("voidSignedPackage('the replacement ticket was refused')"), "airgap2: a refused import voids the standing ticket's package");
  ok(app.includes("cold.ticket = null; cold.ticketStr = '';"), "airgap2: a refused import clears the standing ticket");
  const html = read("pages/airgap-desk/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "airgap2: app.js cache key bumped for the round-2 fix");
}

// Batch 45 (2026-10-11 07:19): Ledger Desk round 2 (Tier 1) — validate
// RELATIONS, not just shapes. Round 1 shape-checked each snapshot field
// alone, so a live status height disagreeing with blocks[0] anchored the
// scan, bucket counts that did not sum to their span (or a window_miners
// map that did not restate them) modeled phantom mining income, a
// MISSING window_miners read as 0 window blocks so the pre-window
// aggregate double-counted the whole window, a duplicated transfer id
// double-wrote the ledger, a transfer above the 21M supply cap or past
// the snapshot head painted, a present-but-impossible timestamp painted,
// a null extrinsic_id rendered as "null…", and re-importing the desk's
// own CSV export doubled every event. Pin: the ledger-core relation
// validators, the scan's per-row relations + id dedup, and the CSV
// import's id/ref idempotence.
{
  const core = read("pages/ledger-desk/ledger-core.js");
  ok(core.includes("function validateLiveHead(live, nowMs)"), "ledger2: validateLiveHead() defined (status restates blocks[0])");
  ok(core.includes("function validateMiners(miners, liveHead)"), "ledger2: validateMiners() defined (bucket/window relations)");
  ok(core.includes("function validateFlowsMeta(flows, liveHead)"), "ledger2: validateFlowsMeta() defined (meta restates payload)");
  ok(core.includes("if (sum !== span) return null;"), "ledger2: bucket miner counts must sum to the bucket span");
  ok(core.includes("if (!isPlainObject(miners.window_miners)) return null;"), "ledger2: a missing window_miners fails, never reads as 0");
  ok(core.includes("MAX_SUPPLY_PLANCKS = 21000000n * PLANCK"), "ledger2: supply-cap constant present");
  const app = read("pages/ledger-desk/app.js");
  ok(app.includes("var anchorH = L.validateLiveHead(live, nowMs);"), "ledger2: scan anchors on the validated live head");
  ok(app.includes("if (seenTx[idKey]) { skipped++; return; }"), "ledger2: a duplicated transfer id drops, never double-writes");
  ok(app.includes("amt > L.MAX_SUPPLY_PLANCKS"), "ledger2: an over-supply-cap transfer drops");
  ok(app.includes("(csvId && existingIds[csvId]) || (csvRef && existingRefs[csvRef])"), "ledger2: CSV import dedupes on exported id/ref");
  ok(app.includes("duplicates skipped"), "ledger2: CSV import reports duplicates separately");
  const html = read("pages/ledger-desk/index.html");
  ok(html.includes("ledger-core.js?v=1.2.0"), "ledger2: ledger-core.js cache key bumped for the round-2 fix");
  ok(html.includes("app.js?v=1.6.0"), "ledger2: app.js cache key bumped for the round-2 fix");
}

// Batch 46 (2026-10-11 08:19): SafeSend rail-staleness (Tier 1) — the
// "Your chosen delay" rail is a rendered output bound to the CURRENT
// effective delay, but the custom-delay handler restated it only for a
// positive whole number (`if (b !== null && b > 0)`), so an invalid
// custom delay (fractional 2.5, zero, an unsafe integer) left the
// PREVIOUS delay's text standing as the chosen one while Schedule
// rejected the input, and a valid-but-unschedulable delay (1 block,
// below the runtime minimum; 1,000,001, above the lab's demo cap) was
// presented as chosen with no invalid marker. Pin: every handler branch
// restates the rail (valid text or an explicit invalid text naming the
// reason), the demo cap is one shared constant used by both the rail
// and Schedule, and the stale positive-only guard is gone.
{
  const app = read("pages/safesend/js/app.js");
  ok(app.includes("var MAX_DELAY_BLOCKS = 1000000;"), "safesend-rail: demo cap pinned as a shared constant");
  ok(app.includes("function railDelayInvalidText(reason)"), "safesend-rail: invalid rail text defined");
  ok(app.includes("Invalid custom delay"), "safesend-rail: invalid states are marked invalid in the rail");
  ok(app.includes("it is not a whole number of blocks"), "safesend-rail: non-whole custom delay restates the rail");
  ok(app.includes("it is below the 2-block runtime minimum"), "safesend-rail: below-minimum custom delay restates the rail");
  ok(app.includes("it is above the lab's 1,000,000-block demo cap"), "safesend-rail: over-cap custom delay restates the rail");
  ok(app.includes("blocks > MAX_DELAY_BLOCKS"), "safesend-rail: Schedule enforces the same demo cap the rail names");
  ok(!app.includes("if (b !== null && b > 0)"), "safesend-rail: the stale positive-only rail guard is gone");
  const html = read("pages/safesend/index.html");
  ok(html.includes("js/app.js?v=1.5.0"), "safesend-rail: app.js cache key bumped for the rail-staleness fix");
}

// Batch 47 (2026-10-11 09:19): Mining Observatory snapshot-boundary
// hardening round 2 (Tier 2) — round 1 validated each bucket against
// ITSELF and the core maps against their own totals, but never the
// buckets against each other or the window they partition: a duplicated
// bucket double-painted 500 blocks, an out-of-window bucket painted as
// window history, a gapped sequence painted as consecutive (charts
// space buckets by INDEX), bucket miners contradicting window_miners
// painted a timeline at war with the headline view, a mid-run span
// change made index spacing lie about time density, and a future
// fetched_at rendered "0s ago" with the STALE warning unreachable.
// Pin: cleanBuckets takes the window + window_miners context and keeps
// only one contiguous, in-window, uniform-span run (short final bucket
// at the window end allowed) whose per-address totals never exceed
// window_miners; sanitizeMiners rejects a future fetched_at; the views
// are built from the SANITIZED snapshot, never the raw payload. The
// relation window_miners ⊆ all_time is deliberately NOT pinned —
// all_time is the fetch script's top-100 and the relation is false on
// real data (verified head 206,247: buckets tile the window exactly,
// bucket aggregate == window_miners exactly).
{
  const app = read("pages/mining-observatory/app.js");
  ok(app.includes("function cleanBuckets(buckets, win, windowMiners)"), "minobs2: cleanBuckets() takes the window context it must relate buckets to");
  ok(app.includes("out.buckets = cleanBuckets(d.buckets, { start: wStart, end: wEnd }, wm);"), "minobs2: sanitizeMiners passes the validated window + miner totals into bucket cleaning");
  ok(app.includes("if (b.start < win.start || b.end > win.end) return;"), "minobs2: a bucket outside the window is not window history");
  ok(app.includes("if (nextStart !== null && b.start !== nextStart) return;"), "minobs2: kept buckets are one contiguous run — gaps, overlaps and duplicates break it");
  ok(app.includes("!(b.end === win.end && span < runSpan)"), "minobs2: span may differ only for a short final bucket at the window end");
  ok(app.includes("> (windowMiners[keys[i]] || 0)) return;"), "minobs2: bucket totals may never exceed the window totals they partition");
  ok(app.includes('bad("fetched_at in the future")'), "minobs2: a future fetched_at is rejected, never rendered as fresh");
  ok(app.includes("VIEWS = buildViews(DATA);"), "minobs2: views are built from the sanitized snapshot");
  ok(!app.includes("VIEWS = buildViews(data);"), "minobs2: the raw payload never reaches the views");
  const html = read("pages/mining-observatory/index.html");
  ok(html.includes("app.js?v=1.19.0"), "minobs2: app.js cache key bumped for the round-2 fix");
}

// Batch 48 (2026-10-11 10:19): Mining Studio snapshot-boundary
// hardening round 2 (Tier 2) — Studio's deriveNetworkDefaults was the
// fleet's original intField pattern, but its sibling copies
// (mining-calculator, pool-desk) had since gained RELATION checks it
// never got, so the same poisoned snapshot was rejected by the
// calculator and painted by the studio: a hashrate contradicting its
// own difficulty (est "1000" vs difficulty 5.4e14 rounded the network
// input to 0 GH/s), current.height disagreeing with head, a supply
// total contradicting its own balances itemization (and no aggregate
// fallback when the total was missing), a supply 50,000 blocks from
// the consensus height mixed in as the same capture, a pace anchored
// by a 3-block sample, a fetched_at of 2999 cited as provenance, and
// a 99,999,999,999 height cited as the capture height. All relations
// verified on live data first (head 206,532: hs == difficulty/12
// exactly, current.height == head, sample 3000, total == balances sum
// exactly, heights equal across snapshots). Pin: the difficulty
// cross-check, the height-agreement rule, totalSupplyOf, the
// one-capture rule, the >=100 sample gate, the fleet height bound,
// and real capture-time bounds on fetched_at.
{
  const app = read("pages/mining-studio/app.js");
  ok(app.includes("if (hs != null && diff != null && BigInt(hs) !== BigInt(diff) / 12n) hs = null;"), "studio2: a hashrate must restate its own difficulty (difficulty / 12)");
  ok(app.includes("if (hh != null && hd != null && hh !== hd) out.height = null;"), "studio2: current.height and head are two reads of one tip — disagreement trusts neither");
  ok(app.includes("function totalSupplyOf(sup)"), "studio2: totalSupplyOf() defined");
  ok(app.includes("Studio.totalSupplyOf = totalSupplyOf;"), "studio2: totalSupplyOf exported for tests");
  ok(app.includes("if (total != null && sum != null && BigInt(total) !== sum) return null;"), "studio2: a total contradicting its balances itemization is trusted on neither side");
  ok(app.includes("Math.abs(sHeight - out.height) > 100) out.supplyQtc = null;"), "studio2: one-capture rule — a supply far from the consensus height is a different capture");
  ok(app.includes("sample != null && sample >= 100"), "studio2: observed pace requires the >=100-block sample the fetch construction guarantees");
  ok(app.includes("var avg = intField(consensus.block_times_ms.avg_ms);"), "studio2: avg_ms is an integer field (the fetch emits a rounded mean), never Number()-coerced");
  ok(app.includes("h >= 1 && h <= 10000000"), "studio2: heights carry the fleet 10,000,000 bound");
  ok(app.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "studio2: a pre-genesis fetched_at is not a capture time");
  ok(app.includes("if (t > Date.now() + 3600000) return null;"), "studio2: a future fetched_at is not a capture time");
  const html = read("pages/mining-studio/index.html");
  ok(html.includes("app.js?v=1.3.0"), "studio2: app.js cache key bumped for the round-2 fix");
}

// Batch 49 (2026-10-11 11:19): fleet capture-time alignment — Studio's
// round-2 validFetchedAt bounds (genesis floor 2026-09-01, ceiling
// now+1h) never propagated to the four sync-fallback siblings, whose
// copies still accepted ANY parseable date: a fetched_at of 2999 (or
// 2020, before the chain existed) was cited verbatim as the snapshot's
// provenance in mining-calculator, pool-desk, energy-observatory and
// luck-lab while Network Dashboard / Supply Audit / Studio rejected
// the same payload. RED first (probe qa-fetchedat-bounds: 10 failures
// across the four apps, controls passing). Pin: the bounded body in
// all four copies and the new cache keys.
{
  const mc = read("pages/mining-calculator/app.js");
  ok(mc.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: miningcalc rejects a pre-genesis capture time");
  ok(mc.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: miningcalc rejects a future capture time");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "fetchedat: miningcalc cache key bumped");
  const pd = read("pages/pool-desk/js/app.js");
  ok(pd.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: pooldesk rejects a pre-genesis capture time");
  ok(pd.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: pooldesk rejects a future capture time");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "fetchedat: pooldesk cache key bumped");
  const en = read("pages/energy-observatory/js/app.js");
  ok(en.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: energy rejects a pre-genesis capture time");
  ok(en.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: energy rejects a future capture time");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "fetchedat: energy cache key bumped");
  const lk = read("pages/luck-lab/js/app.js");
  ok(lk.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: lucklab rejects a pre-genesis capture time");
  ok(lk.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: lucklab rejects a future capture time");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "fetchedat: lucklab cache key bumped");
}

// Batch 50 (2026-10-11 12:19): fleet capture-time alignment, round 2 —
// Batch 49 aligned the four sync-fallback siblings, but a fleet grep
// found three more snapshot consumers whose fetched_at validators still
// accepted any parseable date: mining-observatory's sanitizeMiners had
// the future bound only (a 2020 stamp was cited as provenance for a
// chain that did not exist), governance-tracker's validateSnapshot was
// parseable-only (2020 AND 2999 both rendered as the board's snapshot
// provenance), and node-desk's parseSnapshot was parseable-only with a
// future stamp clamped to "0m old" (a poisoned snapshot masquerading
// as brand new, its head adopted as the network head). RED first
// (probe qa-capturetime-fleet: 10 failures across the three apps,
// controls passing). Pin: the fleet bounds (genesis floor 2026-09-01,
// now+1h ceiling, 1h skew still tolerated) in all three validators and
// the new cache keys.
{
  const mo = read("pages/mining-observatory/app.js");
  ok(mo.includes('if (Date.parse(d.fetched_at) < GENESIS_FLOOR_MS) bad("fetched_at before genesis");'), "capturetime: minobs rejects a pre-genesis capture time");
  ok(mo.includes('bad("fetched_at in the future")'), "capturetime: minobs keeps the future capture-time rejection");
  ok(read("pages/mining-observatory/index.html").includes("app.js?v=1.19.0"), "capturetime: minobs cache key bumped");
  const gv = read("pages/governance-tracker/js/app.js");
  ok(gv.includes("if (fetchedMs < GENESIS_FLOOR_MS || fetchedMs > Date.now() + 3600000) return null;"), "capturetime: governance rejects a non-capture fetched_at (pre-genesis or future)");
  ok(read("pages/governance-tracker/index.html").includes("js/app.js?v=1.44.0"), "capturetime: governance cache key bumped");
  const nd = read("pages/node-desk/node-core.js");
  ok(nd.includes("if (t < GENESIS_FLOOR_MS || t > now + 3600000) return null;"), "capturetime: nodedesk rejects a non-capture fetched_at (pre-genesis or future)");
  ok(read("pages/node-desk/index.html").includes("app.js?v=1.41.0"), "capturetime: nodedesk cache key bumped");
}

// Batch 51 (2026-10-11 13:19): vesting-desk capture-time bounds — the
// last snapshot consumer the Batch 49/50 fleet grep flagged. Its
// fetched_at_ms went through msStr, the generic 2000..2100 timestamp
// shape shared with schedule cliff/start/end, so a 2020 stamp computed
// vesting at a pre-genesis instant (the desk's vested/claimable figures
// anchor on fetched_at_ms as "now") and a 2099 stamp vested the whole
// pool instantly, both cited as snapshot provenance. RED first (probe
// qa-vesting-capturetime: 15 failures, controls passing). Pin: the
// fleet bounds (genesis floor 2026-09-01, now+1h ceiling) live ONLY in
// validFetchedAtMs at the fetched_at_ms call site — msStr itself is
// untouched because the grant cohort's end legitimately reaches 2030 —
// plus the new cache key and Node exports.
{
  const src = read("pages/vesting-desk/app.js");
  ok(src.includes("function validFetchedAtMs(v, nowMs)"), "vesting3: validFetchedAtMs() defined for the capture time");
  ok(src.includes("return n >= GENESIS_FLOOR_MS && n <= now + 3600000 ? s : null;"), "vesting3: fetched_at_ms carries the fleet capture-time bounds");
  ok(src.includes("const fetchedMs = validFetchedAtMs(raw.fetched_at_ms);"), "vesting3: snapshot fetched_at_ms goes through validFetchedAtMs");
  ok(!src.includes("const fetchedMs = msStr(raw.fetched_at_ms);"), "vesting3: no msStr-only fetched_at_ms load remains");
  ok(src.includes("return n >= MS_MIN && n <= MS_MAX ? s : null;"), "vesting3: msStr itself stays 2000..2100 for schedule cliff/start/end");
  ok(read("pages/vesting-desk/index.html").includes("app.js?v=1.31.0"), "vesting3: app.js cache key bumped for the capture-time fix");
}

// Batch 52 (2026-10-11 14:19): flow-tracer snapshot-boundary hardening
// round 2 — validate RELATIONS, not just shapes. Round 1 checked each row
// and meta field alone, so a 0-planck row and a 100M QTC row (over the
// 21M cap) painted, a height of 99,999,999,999 painted, a 2020/2999
// timestamp painted, meta accepted 2020/2999 capture times and a
// window_blocks contradicting its own heights, snapshot rows were never
// checked against the snapshot (non-SS58 endpoints, heights above its
// own head, in-window rows below its dust floor, post-capture stamps),
// live rows were never checked against the queried address, and the
// fetch merge's id-only dedupe let the synthetic genesis copy of the
// 5,669,940 QTC vesting transfer paint TWICE in the live snapshot.
// RED first (probe qa-flowtracer-relations: 13 failures, controls
// passing). Pins: the core fleet bounds + snapshot layer, the loader's
// meta-restatement checks, the live involvement filter, the fetch
// script's fact dedupe, and the new cache keys.
{
  const core = read("pages/flow-tracer/js/flow-core.js");
  ok(core.includes("function sanitizeSnapshotTransfers(rows, meta)"), "flowtracer2: sanitizeSnapshotTransfers() defined in flow-core");
  ok(core.includes("BigInt(amount) > MAX_SUPPLY_PLANCKS"), "flowtracer2: amounts bounded by the 21M supply cap");
  ok(core.includes("if (r.block_height > meta.chain_height) return false;"), "flowtracer2: snapshot rows bounded by the snapshot's own head");
  ok(core.includes("genesisFacts.has(r.from_id"), "flowtracer2: synthetic genesis fact-duplicates drop, indexer row wins");
  ok(core.includes("wb !== head - from"), "flowtracer2: meta window_blocks must restate its heights");
  const app = read("pages/flow-tracer/app.js");
  ok(app.includes("snapshot transfer count does not restate its metadata"), "flowtracer2: loader fails when meta.transfers contradicts the payload");
  ok(app.includes("snapshot genesis rows do not restate its metadata"), "flowtracer2: loader fails when cleaned genesis rows contradict meta.genesis_rows");
  ok(app.includes("var cleaned = F.sanitizeSnapshotTransfers(snap.transfers, m);"), "flowtracer2: loader sanitizes snapshot rows against the meta");
  ok(app.includes("(r.from_id === addr || r.to_id === addr)"), "flowtracer2: live rows must involve the queried address");
  const fetchScript = read("scripts/fetch-flow-data.mjs");
  ok(fetchScript.includes("already carried by the indexer copy"), "flowtracer2: fetch merge dedupes genesis rows by facts, not just id");
  const html = read("pages/flow-tracer/index.html");
  ok(html.includes("js/flow-core.js?v=1.32.0"), "flowtracer2: flow-core.js cache key bumped for round 2");
  ok(html.includes("app.js?v=1.34.0"), "flowtracer2: app.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "flowtracer2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "flowtracer2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "flowtracer2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "flowtracer2: lucklab sync patch-bump pin");
}

// Batch 53 (2026-10-11 15:19): portfolio-desk snapshot-boundary hardening
// round 2 — validate RELATIONS, not just shapes. Headline: sanitizeMined
// Counts ADDED window_miners and all_time, but all_time is cumulative
// since genesis and already includes the window blocks for every shared
// address (verified at head 207,818: 35/35 all_time >= window), so the
// desk painted the top miner at 94,310 blocks mined against a true
// 83,778. Round 1 also let a 0-planck / over-cap transfer paint, a height
// of 0 or 99,999,999,999 paint, non-SS58 endpoints anchor the rollup, a
// balance whose components sum past the 21M cap anchor, a schedule whose
// claimed exceeds its total (or whose cliff follows its end, or whose
// window sits in 1970) vest, and a duplicated transfer id double-count
// the per-address activity. RED first (probe qa-portfolio-relations:
// 19 failures, controls passing). Pins: the core relations + new key.
{
  const core = read("pages/portfolio-desk/js/desk-core.js");
  ok(core.includes("all_time already INCLUDES the"), "portfolio2: mined counts document the all_time-covers-window relation");
  ok(core.includes("counts.set(m.address, v);"), "portfolio2: all_time count replaces the window count, never sums");
  ok(core.includes("if (seenAllTime[m.address]) return;"), "portfolio2: duplicated all_time rows counted once");
  ok(core.includes("BigInt(free) + BigInt(reserved) + BigInt(frozen) > MAX_SUPPLY_PLANCKS"), "portfolio2: balance components sum-bounded by the supply cap");
  ok(core.includes("if (BigInt(claimed) > BigInt(total)) return null;"), "portfolio2: claimed may not exceed the schedule total");
  ok(core.includes("if (cliff > end) return null;"), "portfolio2: a cliff after the end is not a schedule");
  ok(core.includes("SS58_189_RE.test(t.from_id)"), "portfolio2: transfer endpoints must be strict SS58-189");
  ok(core.includes("height < 1 || height > MAX_CHAIN_HEIGHT"), "portfolio2: transfer heights bounded 1..10,000,000");
  ok(core.includes("ms >= GENESIS_FLOOR_MS && ms <= nowCeil"), "portfolio2: present-but-impossible timestamps drop the row");
  ok(core.includes("if (seenIds[id]) return;"), "portfolio2: transfer ids dedupe after validation");
  const html = read("pages/portfolio-desk/index.html");
  ok(html.includes("js/desk-core.js?v=1.33.0"), "portfolio2: desk-core.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "portfolio2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "portfolio2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "portfolio2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "portfolio2: lucklab sync patch-bump pin");
}

// Batch 54 (2026-10-11 16:19): watchtower snapshot-boundary hardening
// round 2 — validate RELATIONS, not just shapes. Round 1 checked each
// field alone, so sanitizeTransfers let a 0-planck row and an over-cap
// row paint, a height of 99,999,999,999 paint, non-SS58 endpoints
// anchor the rollup, and a duplicated id double-count activity;
// sanitizeBlocks trusted input order (an ascending list made the
// OLDEST block the head) and parseable-only timestamps (a 2020 head
// stamp fired instant false chain_stall alerts, a 2999 stamp disabled
// stall detection forever); buildBalanceMap accepted balances above
// the supply cap under non-address keys; and the payload's second
// read of the head (status.block_height) was never cross-checked
// against blocks[0]. All relations verified on live data first (head
// 207,818: blocks strictly newest-first with monotonic timestamps and
// status == blocks[0], 5,300/5,300 flows rows pass, 200/200 whale
// rows in-cap with no duplicates). RED first (probe
// qa-watchtower-relations: 26 failures, controls passing). Pins: the
// core relations + app wiring + new keys.
{
  const core = read("pages/watchtower/js/watch-core.js");
  ok(core.includes("function validChainHeight(v)"), "watchtower2: validChainHeight() defined in watch-core");
  ok(core.includes("function chainTimeMs(v)"), "watchtower2: chainTimeMs() defined in watch-core");
  ok(core.includes("function resolveHead(blocks, status)"), "watchtower2: resolveHead() defined in watch-core");
  ok(core.includes("if (sh === null || sh !== head.height) return null;"), "watchtower2: a disagreeing status trusts neither head read");
  ok(core.includes("if (b.ms > lastMs) return; // timestamp contradicts the height order"), "watchtower2: non-monotonic block timestamps drop");
  ok(core.includes("amt === null || amt <= 0n || amt > MAX_SUPPLY_PLANCKS"), "watchtower2: transfer amounts positive and within the supply cap");
  ok(core.includes("if (capH !== null && h > capH) return;"), "watchtower2: transfers bounded by the snapshot's own head");
  ok(core.includes("if (seen[t.id]) return;"), "watchtower2: transfer ids dedupe after validation");
  ok(core.includes("if (m.has(row.address)) return;"), "watchtower2: duplicated balance rows count once");
  const app = read("pages/watchtower/js/app.js");
  ok(app.includes("QWATCH.resolveHead(blocks, src && src.data && src.data.status)"), "watchtower2: app cross-checks status against blocks[0]");
  ok(app.includes("chain_height: QWATCH.validChainHeight(fm.chain_height)"), "watchtower2: app carries the flows meta head into the transfer bound");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/watch-core.js?v=1.32.0"), "watchtower2: watch-core.js cache key bumped for round 2");
  ok(html.includes("js/app.js?v=1.35.0"), "watchtower2: app.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "watchtower2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "watchtower2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "watchtower2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "watchtower2: lucklab sync patch-bump pin");
}

// Batch 55 (2026-10-11 17:19): Pay Desk gains an OPTIONAL, disclosed
// service fee (profit mandate) — the customer pays it as a second,
// separate transfer to Kyle's QTC address; the two legs sum exactly to
// the invoice total in plancks; the fee is floored so it never exceeds
// the quoted percentage and capped at 100 bps in code. Pins: the split
// + address + wiring + disclosure surfaces + new key.
{
  const app = read("pages/pay-desk/js/app.js");
  ok(app.includes("function splitServiceFee(totalPlancks, feeBps)"), "paydesk-fee: splitServiceFee() defined");
  ok(app.includes('var SERVICE_FEE_ADDRESS = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";'), "paydesk-fee: fee routes only to Kyle's QTC address");
  ok(app.includes("var SERVICE_FEE_MAX_BPS = 100;"), "paydesk-fee: fee capped at 100 bps in code");
  ok(app.includes("serviceFeeBps: hasFee ? split.feeBps : 0,"), "paydesk-fee: invoices record the fee split");
  ok(app.includes("service_fee_bps"), "paydesk-fee: CSV export carries the fee columns");
  const html = read("pages/pay-desk/index.html");
  ok(html.includes('id="inv-fee-bps"'), "paydesk-fee: builder offers the fee selector with a None option");
  ok(html.includes('id="req-fee-addr"'), "paydesk-fee: payment request shows the fee leg and its address");
  ok(html.includes("js/app.js?v=1.46.0"), "paydesk-fee: app.js cache key bumped for the service fee");
}

// Batch 56 (2026-10-11 18:19): Distribution Planner gains an OPTIONAL,
// disclosed service fee (profit mandate port of the Pay Desk pattern) —
// but ON TOP of the recipient total, never deducted: recipient rows pass
// through untouched, the fee is one extra transfer to Kyle's QTC address
// appended LAST so it rides in the final batch, floored so it never
// exceeds the quoted percentage and capped at 100 bps in code. Pins: the
// core split + address + final-batch placement + wiring + disclosure
// surfaces + new keys.
{
  const core = read("pages/distribution-planner/js/core.js");
  ok(core.includes("function computeServiceFee(totalPlancks, feeBps)"), "dist-fee: computeServiceFee() defined");
  ok(core.includes("function withServiceFee(validRows, feeBps)"), "dist-fee: withServiceFee() defined");
  ok(core.includes('var SERVICE_FEE_ADDRESS = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";'), "dist-fee: fee routes only to Kyle's QTC address");
  ok(core.includes("var SERVICE_FEE_MAX_BPS = 100;"), "dist-fee: fee capped at 100 bps in code");
  ok(core.includes("isServiceFee: true"), "dist-fee: fee row is marked and appended last");
  const app = read("pages/distribution-planner/js/app.js");
  ok(app.includes("core.withServiceFee(sum.validRows, currentServiceFeeBps())"), "dist-fee: plan is built through withServiceFee");
  ok(app.includes("state.serviceFeePlancks"), "dist-fee: balance check includes the service fee");
  const html = read("pages/distribution-planner/index.html");
  ok(html.includes('id="service-fee-bps"'), "dist-fee: planner offers the fee selector with a None option");
  ok(html.includes("added <strong>on top of</strong>"), "dist-fee: on-top semantics disclosed in Step 3");
  ok(html.includes("js/core.js?v=1.22.0"), "dist-fee: core.js cache key bumped for the service fee");
  ok(html.includes("js/app.js?v=1.22.0"), "dist-fee: app.js cache key bumped for the service fee");
  ok(html.includes("styles.css?v=1.22.0"), "dist-fee: styles.css cache key bumped for the fee note");
}

// Batch 57 (2026-10-11 19:19): MultiSig Vault payouts gain an OPTIONAL,
// disclosed service fee (profit mandate, third port of the pattern) —
// ON TOP of the payout, never deducted: the recipient leg passes through
// untouched and FIRST, the fee is a second transfer_keep_alive to Kyle's
// QTC address, and both legs ride in ONE atomic Utility.batch_all inner
// call (pallet 9, call 2 — the Quantus fork exposes only batch_all), so
// the vault pays both or neither and every approver sees the fee leg
// byte-for-byte. Floored so it never exceeds the quoted percentage,
// capped at 100 bps in code; a fee floored to zero adds NO leg; sweeps
// (transfer_all) cannot carry it. Pins: the core math + batch encoding
// + address + wiring + disclosure surfaces + new keys + sync bumps.
{
  const core = read("pages/multisig-vault/js/msig-core.js");
  ok(core.includes("function computeServiceFee(totalPlancks, feeBps)"), "msig-fee: computeServiceFee() defined");
  ok(core.includes("function encodePayoutWithServiceFee(destHex, valuePlancks, feeBps)"), "msig-fee: encodePayoutWithServiceFee() defined");
  ok(core.includes("function encodeBatchAll(callHexes)"), "msig-fee: encodeBatchAll() defined");
  ok(core.includes('var SERVICE_FEE_ADDRESS = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";'), "msig-fee: fee routes only to Kyle's QTC address");
  ok(core.includes("var SERVICE_FEE_MAX_BPS = 100;"), "msig-fee: fee capped at 100 bps in code");
  ok(core.includes("var UTILITY_PALLET_INDEX = 9;"), "msig-fee: utility pallet index pinned at 9");
  ok(core.includes("var BATCH_ALL_CALL_IDX = 2;"), "msig-fee: batch_all call index pinned at 2");
  const app = read("pages/multisig-vault/js/app.js");
  ok(app.includes('C.encodePayoutWithServiceFee(recipHex, amount, Number($("b-service-fee").value))'), "msig-fee: builder builds payouts through encodePayoutWithServiceFee");
  ok(app.includes("Service fee disclosure:"), "msig-fee: built payloads carry the fee disclosure note");
  const html = read("pages/multisig-vault/index.html");
  ok(html.includes('id="b-service-fee"'), "msig-fee: builder offers the fee selector with a None option");
  ok(html.includes("added <strong>on top</strong>"), "msig-fee: on-top semantics disclosed at the selector");
  ok(html.includes("js/msig-core.js?v=1.24.0"), "msig-fee: msig-core.js cache key bumped for the service fee");
  ok(html.includes("js/app.js?v=1.24.0"), "msig-fee: app.js cache key bumped for the service fee");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "msig-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "msig-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "msig-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "msig-fee: lucklab sync patch-bump pin");
}

// Batch 58 (2026-10-11 20:19): Reversal Desk's one-time delay planner
// gains an OPTIONAL, disclosed builder service fee (profit mandate,
// fourth port of the pattern — and the first whose fee leg had to be
// REFUSED somewhere): ON TOP of the scheduled amount, never deducted —
// the schedule leg passes through byte-for-byte and FIRST, the fee is a
// Balances::transfer_keep_alive (pallet 2, call 3, compact value) to
// Kyle's QTC address, and both legs ride in ONE atomic
// Utility.batch_all (pallet 9, call 2), so the sender pays both or
// neither. The fee transfers immediately at submit and is NOT refunded
// if the reversible transfer is later cancelled (the amount returns in
// full) — disclosed at the selector and in the plan rows. High-security
// mode CANNOT carry the fee: the HS whitelist allows a batch_all only
// of schedule/cancel/recover calls, so the selector disables there with
// the reason in the plan. Floored so it never exceeds the quoted
// percentage, capped at 100 bps in code; a fee floored to zero adds NO
// leg. Pins: the core math + encoders + address + wiring + disclosure
// surfaces + new keys + sync bumps.
{
  const core = read("pages/reversal-desk/js/reversal-core.js");
  ok(core.includes("function computeServiceFee(totalPlancks, feeBps)"), "rev-fee: computeServiceFee() defined");
  ok(core.includes("function encodeScheduleWithServiceFee(destKey32, amountPlanck, delay, feeBps)"), "rev-fee: encodeScheduleWithServiceFee() defined");
  ok(core.includes("function encodeBatchAll(callHexes)"), "rev-fee: encodeBatchAll() defined");
  ok(core.includes("function encodeTransferKeepAlive(destKey32, valuePlanck)"), "rev-fee: encodeTransferKeepAlive() defined");
  ok(core.includes('var SERVICE_FEE_ADDRESS = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";'), "rev-fee: fee routes only to Kyle's QTC address");
  ok(core.includes("var SERVICE_FEE_MAX_BPS = 100;"), "rev-fee: fee capped at 100 bps in code");
  ok(core.includes("it is NOT refunded if the sender later cancels"), "rev-fee: non-refundable-on-cancel semantics stated in core");
  const app = read("pages/reversal-desk/js/app.js");
  ok(app.includes("RC.encodeScheduleWithServiceFee(dres.key, amt, dl.delay, Number($(\"plFee\").value))"), "rev-fee: planner builds through encodeScheduleWithServiceFee");
  ok(app.includes('$("plFee").disabled = $("plMode").value === "hs";'), "rev-fee: selector disables in high-security mode");
  ok(app.includes("not available in high-security mode"), "rev-fee: HS exclusion reason shown in the plan");
  const html = read("pages/reversal-desk/index.html");
  ok(html.includes('id="plFee"'), "rev-fee: planner offers the fee selector with a None option");
  ok(html.includes("added <strong>on top of</strong>"), "rev-fee: on-top semantics disclosed at the selector");
  ok(html.includes("not refunded"), "rev-fee: non-refundable fee disclosed at the selector");
  ok(html.includes("js/reversal-core.js?v=1.52.0"), "rev-fee: reversal-core.js cache key bumped for the service fee");
  ok(html.includes("js/app.js?v=1.52.0"), "rev-fee: app.js cache key bumped for the service fee");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "rev-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "rev-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "rev-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "rev-fee: lucklab sync patch-bump pin");
}

// Batch 59 (2026-10-11 21:19): Web Wallet (Tier 1 signer) gains an
// OPTIONAL, disclosed builder service fee (profit mandate, fifth port
// of the pattern — the first inside a live signing flow): ON TOP of
// the amount, never deducted — the recipient leg passes through
// byte-for-byte and FIRST, the fee is a second transfer_keep_alive to
// Kyle's QTC address, and both legs ride in ONE atomic
// Utility.batch_all (pallet 9, call 2), so the wallet still signs
// exactly ONE extrinsic and the sender pays both legs or neither. The
// fee choice is a determinant of the pinned estimate (changing the
// selector voids it, like recipient/amount), the review renders the
// fee from the PINNED estimate (rate + address + floored-to-zero
// honesty), the balance check and Max both count the fee, and
// fee-free sends are byte-identical plain transfers. Same run fixes
// the fee-quote placeholder: it hard-coded the ML-DSA-65 wire length,
// under-quoting the length fee for ML-DSA-87 wallets by 1,958 bytes —
// the placeholder is now length-accurate per scheme. Floored so it
// never exceeds the quoted percentage, capped at 100 bps in code; a
// fee floored to zero adds NO leg. Pins: the scale math + batch
// encoder + address + rpc pinning + scheme placeholder + app wiring +
// disclosure surfaces + new keys + sync bumps.
{
  const scale = read("pages/web-wallet/js/scale.js");
  ok(scale.includes("export function computeServiceFee(amountPlancks, feeBps)"), "wallet-fee: computeServiceFee() defined");
  ok(scale.includes("export function buildTransferWithServiceFee(destAccountId, amountPlancks, feeDestAccountId, feeBps)"), "wallet-fee: buildTransferWithServiceFee() defined");
  ok(scale.includes("export function buildBatchAllCall(calls)"), "wallet-fee: buildBatchAllCall() defined");
  ok(scale.includes("export const UTILITY_PALLET_INDEX = 9;"), "wallet-fee: Utility pallet index 9 pinned");
  ok(scale.includes("export const BATCH_ALL_CALL_INDEX = 2;"), "wallet-fee: batch_all call index 2 pinned");
  ok(scale.includes("export const SERVICE_FEE_ADDRESS = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';"), "wallet-fee: fee routes only to Kyle's QTC address");
  ok(scale.includes("export const SERVICE_FEE_MAX_BPS = 100;"), "wallet-fee: fee capped at 100 bps in code");
  const rpc = read("pages/web-wallet/js/rpc.js");
  ok(rpc.includes("const built = buildTransferWithServiceFee(destAccountId, amountPlancks, feeDestAccountId, serviceFeeBps);"), "wallet-fee: buildUnsignedTransfer builds through buildTransferWithServiceFee");
  ok(rpc.includes("serviceFeePlancks: built.feePlancks"), "wallet-fee: the fee is pinned in the unsigned estimate");
  ok(rpc.includes("scheme === 87 ? 1 + 4627 + 2592 : 1 + 3309 + 1952"), "wallet-fee: fee-quote placeholder is length-accurate per ML-DSA scheme (87 under-quote fixed)");
  ok(rpc.includes("from './scale.js?v=1.1.0'"), "wallet-fee: rpc.js pins the bumped scale module");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './rpc.js?v=1.1.0'"), "wallet-fee: app.js pins the bumped rpc module");
  ok(app.includes("$('send-fee').addEventListener('change', invalidateUnsigned);"), "wallet-fee: changing the fee selector voids the pinned estimate");
  ok(app.includes("serviceFeeBps: Number(feeRaw)"), "wallet-fee: estimate builds with the selector's rate, pinned as feeRaw");
  ok(app.includes("const svcFee = unsigned.serviceFeePlancks ?? 0n;"), "wallet-fee: review renders the fee from the pinned estimate, never the live form");
  ok(app.includes("$('send-fee').value = '50';"), "wallet-fee: lock scrub resets the fee selector to the default");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes('id="send-fee"'), "wallet-fee: send form offers the fee selector with a None option");
  ok(html.includes("added <strong>on top of</strong>"), "wallet-fee: on-top semantics disclosed at the selector");
  ok(html.includes("inside the same atomic"), "wallet-fee: atomic batch_all transport disclosed at the selector");
  ok(html.includes('id="est-service-fee"'), "wallet-fee: review carries a dedicated service-fee row");
  ok(html.includes("js/app.js?v=1.42.0"), "wallet-fee: app.js cache key bumped for the service fee");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "wallet-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "wallet-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "wallet-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "wallet-fee: lucklab sync patch-bump pin");
}

// Batch 60 (2026-10-11 22:19): Mempool Desk RPC-boundary hardening
// round 2 — validate RELATIONS, not just shapes. Round 1 (Batch 10)
// checked each node answer alone, so a height of 99,999,999,999 (or 0)
// rendered as the chain head, a 0-planck txWatch "transfer" painted in
// the feed and fired a desktop notification, a native amount above the
// whole 21M QTC supply painted as a real transfer, and any base58-ish
// `from` string (20 a's, a '0'-padded string — 0 is not base58, another
// chain's address) rendered as the sender. rpc-core now enforces the
// fleet relations: parseBlockNumber accepts only 1..10,000,000 in all
// three encodings, parseTxWatchNotification rejects zero amounts and
// caps NATIVE amounts at MAX_SUPPLY_PLANCKS (asset amounts uncapped —
// an asset's supply is not QTC's), and `from` is kept only in the
// strict SS58-189 shape (qz + 47 base58, the fleet SS58_189_RE).
{
  const core = read("pages/mempool-desk/js/rpc-core.js");
  ok(core.includes("var MAX_CHAIN_HEIGHT = 10000000;"), "mempool2: fleet height ceiling defined");
  ok(core.includes("var MAX_SUPPLY_PLANCKS = 21000000n * PLANCK_PER_QTC;"), "mempool2: 21M supply cap defined in plancks");
  ok(core.includes("var SS58_189_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/;"), "mempool2: strict SS58-189 shape defined");
  ok(core.includes("return n !== null && n > 0 && n <= MAX_CHAIN_HEIGHT ? n : null;"), "mempool2: parseBlockNumber enforces the fleet height relation");
  ok(core.includes('throw new Error("bad amount (zero-planck transfer)");'), "mempool2: zero-planck notifications rejected");
  ok(core.includes("if (assetId === null && amountPlanck > MAX_SUPPLY_PLANCKS)"), "mempool2: native amounts capped at supply, asset amounts exempt");
  ok(core.includes("MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,"), "mempool2: supply cap exported for tests");
  const html = read("pages/mempool-desk/index.html");
  ok(html.includes("js/rpc-core.js?v=1.34.0"), "mempool2: rpc-core.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "mempool2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "mempool2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "mempool2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "mempool2: lucklab sync patch-bump pin");
}

// Batch 61 (2026-10-12 15:19): Airgap Desk service fee (profit mandate) —
// the sixth fee carrier and the first on an OFFLINE signer. The cold desk
// may add an optional, plainly disclosed fee ON TOP of the amount (None /
// 0.25% / 0.5% default / 1%, capped at 100 bps): recipient leg untouched
// and FIRST, fee leg a second transfer_keep_alive to the builder's QTC
// address, wrapped in ONE atomic Utility.batch_all so the cold side still
// signs exactly one extrinsic. The hot-side decoder whitelist grows by
// exactly that shape — a batch_all of EXACTLY two transfer legs — and
// renders BOTH legs, warning when leg 2 does not pay the disclosed
// builder address. Fee choice is pinned in the cold review like
// dest/amount/nonce/scheme; editing it voids the signed package.
{
  const core = read("pages/airgap-desk/js/airgap.js");
  ok(core.includes("export const SERVICE_FEE_ADDRESS = 'qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau';"), "airgap-fee: disclosed builder fee address pinned in core");
  ok(core.includes("export const SERVICE_FEE_MAX_BPS = 100;"), "airgap-fee: fee capped at 100 bps in code");
  ok(core.includes("export function computeServiceFee(amountPlancks, feeBps)"), "airgap-fee: exact floor fee math exported");
  ok(core.includes("export function buildColdCall({ destAccountId, amountPlancks, serviceFeePlancks = 0n })"), "airgap-fee: cold call builder carries the optional fee");
  ok(core.includes("buildBatchAllCall([recipient, buildTransferCall(serviceFeeAccountId(), fee)])"), "airgap-fee: recipient leg first, fee leg last, one atomic batch");
  ok(core.includes("only a 2-leg transfer batch is decoded"), "airgap-fee: decoder whitelist is exactly the 2-leg transfer batch");
  ok(core.includes("serviceFeeDestAddress: legs[1].destAddress"), "airgap-fee: decoder names the second leg's destination for the hot-side warning");
  const lib = read("pages/airgap-desk/js/lib/scale.js");
  ok(lib.includes("export function buildBatchAllCall(calls)"), "airgap-fee: fleet batch_all encoding in the vendored scale lib");
  ok(lib.includes("export const UTILITY_PALLET_INDEX = 9;"), "airgap-fee: Utility pallet index pinned");
  const app = read("pages/airgap-desk/js/app.js");
  ok(app.includes("['cold-fee', 'the service fee was changed']"), "airgap-fee: editing the fee voids the signed package");
  ok(app.includes("service fee changed since review"), "airgap-fee: signing is pinned to the reviewed fee");
  ok(app.includes("NOT the builder fee address named on this page"), "airgap-fee: hot side warns when leg 2 pays someone else");
  ok(app.includes("v.decoded.call.totalPlancks + fee"), "airgap-fee: fee quote counts both legs against the balance");
  const html = read("pages/airgap-desk/index.html");
  ok(html.includes('id="cold-fee"'), "airgap-fee: fee selector present in the cold build form");
  ok(html.includes("added ON TOP of the amount"), "airgap-fee: fee disclosed as on-top in the page");
  ok(html.includes("js/app.js?v=1.46.0"), "airgap-fee: app.js cache key bumped for the fee (1.46.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.14"), "airgap-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.14"), "airgap-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.14"), "airgap-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.14"), "airgap-fee: lucklab sync patch-bump pin");
}
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
