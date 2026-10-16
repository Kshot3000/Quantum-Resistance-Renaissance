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
  ok(html.includes('app.js?v=1.33.0'), "supply: app.js cache key bumped for the boot fix");
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
  ok(html.includes("app.js?v=1.17.0"), "emission: app.js cache key bumped for the round-3 fix (1.17.0; was 1.16.0 since Batch 75)");
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
  ok(src.includes("function validateSchedules(rows, anchorMs)"), "vesting: validateSchedules() defined");
  ok(src.includes("function validSchedule(raw, seenIds, anchorMs)"), "vesting: per-schedule validator defined");
  ok(src.includes("ADDR_RE"), "vesting: beneficiary must be a prefix-189-shaped qz address");
  ok(src.includes("BigInt(claimed) > BigInt(total)"), "vesting: claimed > total schedules are rejected");
  ok((src.match(/by_cohort: buildByCohort\(schedules\)/g) || []).length === 2,
    "vesting: by_cohort rebuilt from validated schedules on live AND snapshot paths");
  ok(!src.includes("DATA = await res.json()"), "vesting: no assign-before-validate snapshot load remains");
  ok(!src.includes("function normalizeLive"), "vesting: unvalidated normalizeLive is gone");
  ok(src.includes("snapshot: no valid schedules"), "vesting: all-invalid payload fails honestly instead of rendering poison");
  const html = read("pages/vesting-desk/index.html");
  ok(html.includes("app.js?v=1.33.0"), "vesting: app.js cache key bumped for the boundary fix");
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
  ok(src.includes("function cleanMove(raw, maxHeight, fetchedMs, isRecent, supplyTotal)"), "whale: moves validated against the snapshot height and capture time (round 3: + the supply bound)");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.25.0"), "whale: app.js cache key bumped for the boundary fix (superseded by the 1.24.0 round-4 bump)");
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
  // Round 2 moved the boundary into gov-core.js (testable pure logic);
  // app.js keeps only the two gated load paths and the boot-catch throw.
  const src = read("pages/governance-tracker/js/gov-core.js");
  const app = read("pages/governance-tracker/js/app.js");
  ok(src.includes("function validateSnapshot(raw, nowMs)"), "governance: validateSnapshot() defined in gov-core");
  ok(src.includes("function cleanRefEvent(raw, fetchedMs)"), "governance: per-event validator defined in gov-core");
  ok(app.includes("validateSnapshot(window.__qgov_mock)") && app.includes("validateSnapshot(j)"), "governance: validator gates fetch AND mock load paths");
  ok(src.includes("!STATUS_META[raw.type]"), "governance: event type must be a known lifecycle state");
  ok(src.includes("if (!trackObj) return null;"), "governance: unknown track events are rejected (no fallback thresholds)");
  ok(src.includes("tv > GOV.max_member_count"), "governance: tallies bounded by the member cap");
  ok(src.includes("d.referenda.length && !refs.length"), "governance: all-invalid referenda fail honestly (no empty-board lie)");
  ok(app.includes('throw new Error("snapshot failed validation")'), "governance: invalid snapshot throws into the boot catch");
  const html = read("pages/governance-tracker/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "governance: app.js cache key bumped for the relations fix");
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
  ok(html.includes("app.js?v=1.5.0"), "studio: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.42.0"), "nodedesk: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.5.0"), "explorer: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/app.js?v=1.49.0"), "console: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/app.js?v=1.38.0"), "mempool: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/rpc-core.js?v=1.36.0"), "mempool: rpc-core.js cache key bumped for the boundary fix (1.34.0 since Batch 60)");
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
  ok(html.includes("js/app.js?v=1.46.0"), "wallet: app.js cache key bumped for the boundary fix (1.39.0, superseded by the 1.40.0 lock-scrub bump, the 1.41.0 activity round-2 bump, the 1.42.0 service-fee bump and the 1.43.0 keystore-boundary bump)");
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
  ok(html.includes("js/ss58.js?v=1.2.0"), "safesend: ss58.js loaded with its cache key (1.1.0 reserved-prefix bump)");
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
  ok(html.includes("js/app.js?v=1.50.0"), "airgap: app.js cache key bumped for the cold-void fix (1.44.0, superseded by the 1.48.0 nonce-u32 bump and the 1.49.0 supply-cap bump)");
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
  ok(html.includes("js/app.js?v=1.55.0"), "notary: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/notary-codec.js?v=1.51.0"), "notary: notary-codec.js cache key bumped for the boundary fix");
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
  ok(core.includes("function sanitizeWatchlist(rows, validateFn)"), "watchtower: sanitizeWatchlist() defined in watch-core (moved there in Batch 74)");
  ok(app.includes("QWATCH.sanitizeWatchlist(parsed.watchlist, validateQuantusAddress)"), "watchtower: stored watchlist sanitized at load via the core");
  ok(app.includes("state.baselines = QWATCH.sanitizeBaselines(parsed.baselines);"), "watchtower: stored baselines sanitized at load");
  ok(app.includes("state.alerts = QWATCH.sanitizeAlerts(parsed.alerts);"), "watchtower: stored alerts sanitized at load");
  ok(app.includes("state.lastScan = QWATCH.eraTs(parsed.lastScan);"), "watchtower: stored lastScan era-held (superseded parseable-only pin, Batch 92)");
  ok(app.includes("QWATCH.sanitizeBlocks(src && src.data && src.data.blocks)"), "watchtower: scan head comes only from validated blocks");
  ok(app.includes("QWATCH.sanitizeTransfers(bundle.flows && bundle.flows.transfers, flowsMeta ? flowsMeta.chain_height : null)"), "watchtower: transfers sanitized before the rule engine");
  ok(app.includes("QWATCH.sanitizeGovernance(bundle.gov && bundle.gov.data)"), "watchtower: governance counts sanitized before baselining");
  ok(!app.includes("(govData.referenda || []).length"), "watchtower: no raw governance length counting remains");
  ok(!app.includes("Object.keys(blankState())"), "watchtower: no blind stored-state copy remains");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/app.js?v=1.38.0"), "watchtower: app.js cache key bumped for the boundary fix (Batch 74 relations round)");
  ok(html.includes("js/watch-core.js?v=1.36.0"), "watchtower: watch-core.js cache key bumped for the boundary fix (Batch 74 relations round)");
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
  ok(core.includes("function sanitizeMinedCounts(windowMiners, allTime, bounds)"), "portfolio: sanitizeMinedCounts() defined in desk-core");
  ok(core.includes("function sanitizeVaultEntries(rows, opts)"), "portfolio: sanitizeVaultEntries() defined in desk-core");
  ok(core.includes("a duplicate silently double-counted every total"), "portfolio: duplicate vault entries are dropped, never double-counted");
  ok(core.includes("sanitizeBalance(ctx.balances.get(entry.address))"), "portfolio: rollup re-validates balances from any ctx producer");
  ok(core.includes("dedupe on the row's own facts"), "portfolio: id-less transfers dedupe on their own facts, never one shared key");
  const app = read("pages/portfolio-desk/js/app.js");
  ok(app.includes("validateAddress: function (a) { return validateQuantusAddress(a).ok; }"), "portfolio: stored vault is SS58-gated at load");
  ok(app.includes("indexer returned a malformed response"), "portfolio: a non-object indexer answer is rejected, never dereferenced");
  ok(app.includes("QPORT.sanitizeBalance(row)"), "portfolio: live balance rows sanitized before they anchor the desk");
  ok(app.includes("row.id === addr ? QPORT.sanitizeBalance(row) : null"), "portfolio: a single-address refresh must answer for the address asked");
  ok(app.includes("Live refresh returned a malformed balance"), "portfolio: a malformed live balance reports honestly instead of anchoring");
  ok(app.includes("c.snapBalances = QPORT.sanitizeTopBalances(whales.top);"), "portfolio: snapshot balances sanitized at load");
  ok(app.includes("c.schedules = QPORT.sanitizeSchedules(vesting.schedules);"), "portfolio: vesting schedules sanitized at load");
  ok(app.includes("indexTransfers(QPORT.sanitizeTransfers(flows.transfers))"), "portfolio: transfers sanitized before the activity index");
  ok(app.includes("chainHeight: miners.chain_height"), "portfolio: mined counts held to the snapshot chain height at load");
  ok(app.includes("QPORT.parseHeight(bundle.liveData.status.block_height)"), "portfolio: the live head is parsed strictly, never presented raw");
  ok(app.includes('esc(String(x.s.id))'), "portfolio: vesting schedule ids are escaped at render");
  const html = read("pages/portfolio-desk/index.html");
  ok(html.includes("js/app.js?v=1.37.0"), "portfolio: app.js cache key bumped for the boundary fix");
  ok(html.includes("js/desk-core.js?v=1.36.0"), "portfolio: desk-core.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/flow-core.js?v=1.33.0"), "flowtracer: flow-core.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.10.0"), "ledger: app.js cache key bumped for the report-staleness fix");
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
  ok(html.includes("js/app.js?v=1.49.0"), "console: app.js cache key bumped for the broadcast-staleness fix");
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
  ok(html.includes("js/app.js?v=1.55.0"), "notary: app.js cache key bumped for the staleness fix");
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
  ok(html.includes("app.js?v=1.12.0"), "netdash: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("js/audit-core.js?v=1.32.0"), "supply2: audit-core cache key bumped for the boundary fix");
  ok(html.includes("app.js?v=1.33.0"), "supply2: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.20.0"), "minobs: app.js cache key bumped for the boundary fix");
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
  ok(app.includes("if (!(avg > 1000 && avg < 120000) || sample < 100) return null;"), "miningcalc: observed pace requires the fetch sample (>= 100 blocks)");
  ok(app.includes("Math.abs(sHeight - out.height) > 100) out.supplyQtc = null;"), "miningcalc: cross-capture supply rejected (one-capture rule)");
  const html = read("pages/mining-calculator/index.html");
  ok(html.includes("app.js?v=1.11.98"), "miningcalc: app.js cache key bumped for the boundary fix");
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
  ok(app.includes("if (!(avg > 1000 && avg < 120000) || sample < 100) return null;"), "pooldesk: observed pace requires the fetch sample (>= 100 blocks)");
  ok(app.includes("Math.abs(supHeight - consHeight) > 100) supplyPlancks = null;"), "pooldesk: cross-capture supply rejected (one-capture rule)");
  ok(app.includes("q > 0 && q <= MAX_SUPPLY_QTC / EMISSION_DENOM"), "pooldesk: block-avg rewards validated per row against the emission range");
  const html = read("pages/pool-desk/index.html");
  ok(html.includes("app.js?v=1.48.98"), "pooldesk: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.51.98"), "energy: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.48.98"), "lucklab: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.33.0"), "vesting2: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.25.0"), "whale2: app.js cache key bumped for the round-2 fix (superseded by the 1.24.0 round-4 bump)");
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
  ok(html.includes("app.js?v=1.12.0"), "tokenomics2: app.js cache key bumped for the boundary fix (1.10.0, superseded by the 1.11.0 parser-bound bump)");
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
  ok(html.includes("app.js?v=1.39.0"), "consensus2: app.js cache key bumped for the boundary fix (1.38.0, superseded by the 1.39.0 round-3 bump)");
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
  ok(html.includes("js/reversal-core.js?v=1.55.0"), "reversal2: reversal-core.js cache key bumped for the boundary fix (superseded by the 1.54.0 round-3 bump)");
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
  ok(html.includes("js/exposure-core.js?v=1.58.0"), "exposure2: exposure-core.js cache key bumped for the boundary fix (superseded by the 1.55.0 reserved-prefix bump)");
  ok(html.includes("js/app.js?v=1.55.0"), "exposure2: app.js cache key bumped for the boundary fix");
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
  ok(html.includes("app.js?v=1.12.0"), "netdash2: app.js cache key bumped for the round-2 fix");
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
  ok(html.includes("js/audit-core.js?v=1.32.0"), "supply3: audit-core cache key bumped for the round-2 fix");
  ok(html.includes("app.js?v=1.33.0"), "supply3: app.js cache key bumped for the round-2 fix");
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
  ok(rpc.includes("rpc-validate.js?v=1.2.0"), "wallet2: rpc.js pins the bumped rpc-validate module");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './rpc-validate.js?v=1.2.0'"), "wallet2: app.js imports the sanitizer from the bumped module");
  ok(!app.includes("function validActivityRow(t)"), "wallet2: the round-1 shape-only row check is gone");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "wallet2: app.js cache key bumped for the round-2 fix (superseded by 1.43.0, then the 1.44.0 reserved-prefix bump and the 1.45.0 supply-cap bump)");
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
  ok(html.includes("js/app.js?v=1.5.0"), "keyforge: app.js cache key bumped for the staleness fix (superseded by the 1.4.0 reserved-prefix bump)");
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
  ok(html.includes("app.js?v=1.5.0"), "explorer2: app.js cache key bumped for the round-2 fix");
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
  ok(html.includes("js/app.js?v=1.49.0"), "console2: app.js cache key bumped for the round-2 fix (superseded by the 1.47.0 reserved-prefix bump and the 1.48.0 supply-cap bump)");
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
  ok(html.includes("js/app.js?v=1.55.0"), "notary2: app.js cache key bumped for the round-2 fix");
  ok(html.includes("js/notary-codec.js?v=1.51.0"), "notary2: notary-codec.js cache key bumped for the round-2 fix");
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
  ok(html.includes("js/app.js?v=1.50.0"), "airgap2: app.js cache key bumped for the round-2 fix (superseded by the 1.48.0 nonce-u32 bump and the 1.49.0 supply-cap bump)");
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
  ok(html.includes("ledger-core.js?v=1.7.0"), "ledger2: ledger-core.js cache key bumped for the round-2 fix");
  ok(html.includes("app.js?v=1.10.0"), "ledger2: app.js cache key bumped for the round-2 fix");
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
  ok(html.includes("app.js?v=1.20.0"), "minobs2: app.js cache key bumped for the round-2 fix");
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
  ok(app.includes("if (!(avg > 1000 && avg < 120000) || sample < 100) return null;"), "studio2: observed pace requires the >=100-block sample the fetch construction guarantees");
  ok(app.includes("var avg = intField(bt.avg_ms), sample = intField(bt.sample);"), "studio2: avg_ms is an integer field (the fetch emits a rounded mean), never Number()-coerced");
  ok(app.includes("h >= 1 && h <= 10000000"), "studio2: heights carry the fleet 10,000,000 bound");
  ok(app.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "studio2: a pre-genesis fetched_at is not a capture time");
  ok(app.includes("if (t > Date.now() + 3600000) return null;"), "studio2: a future fetched_at is not a capture time");
  const html = read("pages/mining-studio/index.html");
  ok(html.includes("app.js?v=1.5.0"), "studio2: app.js cache key bumped for the round-2 fix");
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
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "fetchedat: miningcalc cache key bumped");
  const pd = read("pages/pool-desk/js/app.js");
  ok(pd.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: pooldesk rejects a pre-genesis capture time");
  ok(pd.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: pooldesk rejects a future capture time");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "fetchedat: pooldesk cache key bumped");
  const en = read("pages/energy-observatory/js/app.js");
  ok(en.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: energy rejects a pre-genesis capture time");
  ok(en.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: energy rejects a future capture time");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "fetchedat: energy cache key bumped");
  const lk = read("pages/luck-lab/js/app.js");
  ok(lk.includes('if (t < Date.parse("2026-09-01T00:00:00Z")) return null;'), "fetchedat: lucklab rejects a pre-genesis capture time");
  ok(lk.includes("if (t > Date.now() + 3600000) return null;"), "fetchedat: lucklab rejects a future capture time");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "fetchedat: lucklab cache key bumped");
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
  ok(read("pages/mining-observatory/index.html").includes("app.js?v=1.20.0"), "capturetime: minobs cache key bumped");
  const gv = read("pages/governance-tracker/js/gov-core.js");
  ok(gv.includes("if (fetchedMs < GENESIS_FLOOR_MS || fetchedMs > now + 3600000) return null;"), "capturetime: governance rejects a non-capture fetched_at (pre-genesis or future)");
  ok(read("pages/governance-tracker/index.html").includes("js/app.js?v=1.46.0"), "capturetime: governance cache key bumped");
  const nd = read("pages/node-desk/node-core.js");
  ok(nd.includes("if (t < GENESIS_FLOOR_MS || t > now + 3600000) return null;"), "capturetime: nodedesk rejects a non-capture fetched_at (pre-genesis or future)");
  ok(read("pages/node-desk/index.html").includes("app.js?v=1.42.0"), "capturetime: nodedesk cache key bumped");
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
  ok(read("pages/vesting-desk/index.html").includes("app.js?v=1.33.0"), "vesting3: app.js cache key bumped for the capture-time fix");
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
  ok(html.includes("js/flow-core.js?v=1.33.0"), "flowtracer2: flow-core.js cache key bumped for round 2");
  ok(html.includes("app.js?v=1.34.0"), "flowtracer2: app.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "flowtracer2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "flowtracer2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "flowtracer2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "flowtracer2: lucklab sync patch-bump pin");
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
  ok(core.includes("kept.forEach(function (kv) { counts.set(kv[0], kv[1]); });"), "portfolio2: all_time count replaces the window count, never sums");
  ok(core.includes("if (seenAllTime[m.address]) return;"), "portfolio2: duplicated all_time rows counted once");
  ok(core.includes("BigInt(free) + BigInt(reserved) + BigInt(frozen) > MAX_SUPPLY_PLANCKS"), "portfolio2: balance components sum-bounded by the supply cap");
  ok(core.includes("if (BigInt(claimed) > BigInt(total)) return null;"), "portfolio2: claimed may not exceed the schedule total");
  ok(core.includes("if (cliff > end) return null;"), "portfolio2: a cliff after the end is not a schedule");
  ok(core.includes("SS58_189_RE.test(t.from_id)"), "portfolio2: transfer endpoints must be strict SS58-189");
  ok(core.includes("height < 1 || height > MAX_CHAIN_HEIGHT"), "portfolio2: transfer heights bounded 1..10,000,000");
  ok(core.includes("ms >= GENESIS_FLOOR_MS && ms <= nowCeil"), "portfolio2: present-but-impossible timestamps drop the row");
  ok(core.includes("if (seenIds[id]) return;"), "portfolio2: transfer ids dedupe after validation");
  const html = read("pages/portfolio-desk/index.html");
  ok(html.includes("js/desk-core.js?v=1.36.0"), "portfolio2: desk-core.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "portfolio2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "portfolio2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "portfolio2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "portfolio2: lucklab sync patch-bump pin");
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
  ok(html.includes("js/watch-core.js?v=1.36.0"), "watchtower2: watch-core.js cache key bumped for round 2");
  ok(html.includes("js/app.js?v=1.38.0"), "watchtower2: app.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "watchtower2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "watchtower2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "watchtower2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "watchtower2: lucklab sync patch-bump pin");
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
  ok(html.includes("js/app.js?v=1.51.0"), "paydesk-fee: app.js cache key bumped for the service fee (superseded by the 1.49.0 rate-grammar bump and the 1.50.0 csv-formula bump)");
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
  ok(html.includes("js/core.js?v=1.25.0"), "dist-fee: core.js cache key bumped for the service fee (superseded by the 1.24.0 comma-amount bump)");
  ok(html.includes("js/app.js?v=1.23.0"), "dist-fee: app.js cache key bumped for the service fee");
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
  ok(html.includes("js/msig-core.js?v=1.30.0"), "msig-fee: msig-core.js cache key bumped for the service fee (superseded by the 1.27.0 reserved-prefix bump and the 1.27.0 supply-cap bump)");
  ok(html.includes("js/app.js?v=1.28.0"), "msig-fee: app.js cache key bumped for the service fee");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "msig-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "msig-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "msig-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "msig-fee: lucklab sync patch-bump pin");
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
  ok(html.includes("js/reversal-core.js?v=1.55.0"), "rev-fee: reversal-core.js cache key bumped for the service fee (superseded by the 1.54.0 round-3 bump)");
  ok(html.includes("js/app.js?v=1.52.0"), "rev-fee: app.js cache key bumped for the service fee");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "rev-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "rev-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "rev-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "rev-fee: lucklab sync patch-bump pin");
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
  ok(rpc.includes("from './scale.js?v=1.2.0'"), "wallet-fee: rpc.js pins the bumped scale module");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './rpc.js?v=1.2.0'"), "wallet-fee: app.js pins the bumped rpc module");
  ok(app.includes("$('send-fee').addEventListener('change', invalidateUnsigned);"), "wallet-fee: changing the fee selector voids the pinned estimate");
  ok(app.includes("serviceFeeBps: Number(feeRaw)"), "wallet-fee: estimate builds with the selector's rate, pinned as feeRaw");
  ok(app.includes("const svcFee = unsigned.serviceFeePlancks ?? 0n;"), "wallet-fee: review renders the fee from the pinned estimate, never the live form");
  ok(app.includes("$('send-fee').value = '50';"), "wallet-fee: lock scrub resets the fee selector to the default");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes('id="send-fee"'), "wallet-fee: send form offers the fee selector with a None option");
  ok(html.includes("added <strong>on top of</strong>"), "wallet-fee: on-top semantics disclosed at the selector");
  ok(html.includes("inside the same atomic"), "wallet-fee: atomic batch_all transport disclosed at the selector");
  ok(html.includes('id="est-service-fee"'), "wallet-fee: review carries a dedicated service-fee row");
  ok(html.includes("js/app.js?v=1.46.0"), "wallet-fee: app.js cache key bumped for the service fee (superseded by 1.43.0, then the 1.44.0 reserved-prefix bump and the 1.45.0 supply-cap bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "wallet-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "wallet-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "wallet-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "wallet-fee: lucklab sync patch-bump pin");
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
  ok(html.includes("js/rpc-core.js?v=1.36.0"), "mempool2: rpc-core.js cache key bumped for round 2");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "mempool2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "mempool2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "mempool2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "mempool2: lucklab sync patch-bump pin");
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
  ok(html.includes("js/app.js?v=1.50.0"), "airgap-fee: app.js cache key bumped for the fee (1.46.0, superseded by the 1.48.0 nonce-u32 bump and the 1.49.0 supply-cap bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "airgap-fee: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "airgap-fee: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "airgap-fee: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "airgap-fee: lucklab sync patch-bump pin");
}
// Batch 62 (2026-10-12 17:19): Vanity Forge case-aware pin + persisted-state
// boundary — case-sensitive matching is the page DEFAULT, but validatePattern
// folded the first pattern character to lowercase, so a case-sensitive "K…"
// prefix passed validation and quoted a finite difficulty even though the
// character after "qz" is ALWAYS lowercase j/k/m/n/o/p/q — the grind could
// never match. validatePattern is now case-aware (uppercase pinned letter
// rejected case-sensitively with the reason; case-insensitive folding kept),
// expectedAttempts returns Infinity for the impossible case-sensitive shape,
// and the localStorage vault/bench load through sanitizeVault/sanitizeBench
// (a poisoned vault record with an unknown scheme crashed renderVault at
// boot via SCHEMES[rec.scheme].label; records render via innerHTML).
{
  const core = read("pages/vanity-forge/js/vanity.js");
  ok(core.includes("export function validatePattern(raw, position = 'prefix', caseSensitive = true)"), "vanity: validator is case-aware");
  ok(core.includes("Case-sensitive matching can never find"), "vanity: case-sensitive pinned rejection explains itself");
  ok(core.includes("export function sanitizeVault(raw, opts = {})"), "vanity: vault sanitizer exported");
  ok(core.includes("export function sanitizeBench(raw)"), "vanity: bench sanitizer exported");
  ok(core.includes("export const SS58_189_RE = /^qz[1-9A-HJ-NP-Za-km-z]{47}$/;"), "vanity: strict SS58-189 shape pinned");
  ok(core.includes("export const MAX_PLAUSIBLE_RATE = 1_000_000;"), "vanity: bench rate plausibility cap pinned");
  const app = read("pages/vanity-forge/js/app.js");
  ok(app.includes("validatePattern($('pattern').value, pos, currentCase())"), "vanity: app passes the case mode into validation");
  ok(app.includes("sanitizeVault(JSON.parse(localStorage.getItem(VAULT_KEY)"), "vanity: vault load goes through the sanitizer");
  ok(app.includes("sanitizeBench(JSON.parse(localStorage.getItem(BENCH_KEY)"), "vanity: bench load goes through the sanitizer");
  ok(app.includes("const hay = cfg.caseSensitive ? address : address.toLowerCase();"), "vanity: suffix highlight searches the correctly-cased string");
  const html = read("pages/vanity-forge/index.html");
  ok(html.includes("js/app.js?v=1.27.0"), "vanity: app.js cache key bumped for the relations fix (1.26.0)");
  ok(html.includes('placeholder="e.g. kshot"'), "vanity: pattern placeholder is a base58-valid example");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "vanity: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "vanity: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "vanity: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "vanity: lucklab sync patch-bump pin");
}
// Batch 63 (2026-10-12 18:19): Address Toolkit Quantus-verdict relation —
// the Inspect verdict checked prefix + checksum alone, so a generic SS58
// string carrying prefix 189 over a 1/2/4/8/33-byte key (valid checksum)
// painted green as a "well-formed QTC mainnet address", and the page's own
// Encode tab minted such strings labeled "a mainnet QTC address". Real
// Quantus accounts are exactly 32-byte keys (36-byte payload, 49 chars).
// isQuantusAddress pins the relation; Inspect rejects the short-key 189
// shape, Encode warns on it, and ss58Decode rejects the reserved 10/11
// prefix framing instead of fabricating a 1-byte prefix (e.g. 192).
{
  const core = read("pages/address-toolkit/app.js");
  ok(core.includes("function isQuantusAddress(d)"), "addresstoolkit: Quantus relation helper present");
  ok(core.includes("d.key.length !== QUANTUS_KEY_LEN"), "addresstoolkit: inspect enforces the 32-byte key relation");
  ok(core.includes("Not a Quantus account address"), "addresstoolkit: short-key 189 verdict explains itself");
  ok(core.includes("Reserved SS58 prefix form"), "addresstoolkit: reserved prefix framing rejected");
  ok(core.includes("Encoded (not a QTC account)"), "addresstoolkit: encode warns on short-key 189");
  ok(core.includes("isQuantusAddress: isQuantusAddress"), "addresstoolkit: relation helper exported for tests");
  const html = read("pages/address-toolkit/index.html");
  ok(html.includes("app.js?v=1.10.0"), "addresstoolkit: app.js cache key bumped for the verdict fix (1.9.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "addresstoolkit: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "addresstoolkit: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "addresstoolkit: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "addresstoolkit: lucklab sync patch-bump pin");
}
// Batch 65 (2026-10-12 20:19): Proposal Studio draft-vault boundary — the
// draft vault loads from localStorage AND a user-imported JSON file, and
// both paths trusted the parsed value: a non-array crashed the save path,
// an unknown trackId crashed lifecycle(), a numeric created crashed
// .slice, null checks crashed checks[i], bad callHex crashed the pack
// builders via hexToBytes -> null, an over-4KiB call bypassed the chain
// cap the composer enforces, and a hash that disagreed with the call
// bytes produced a submit referencing a preimage that can never exist —
// and the import path PERSISTED the poison, crashing every later visit.
// gov-codec gains sanitizeDrafts (plain objects, real track, valid hex
// 2..4096B, hash == blake2b-256(callBytes) when a hash function is given,
// deduped ids, capped strings, exactly-5 boolean checks) and both load
// paths route through it; the import sanitizes BEFORE it saves and
// reports the kept count honestly.
{
  const codec = read("pages/proposal-studio/js/gov-codec.js");
  ok(codec.includes("function sanitizeDrafts(raw, hashOf)"), "proposalstudio: draft sanitizer present");
  ok(codec.includes("sanitizeDrafts: sanitizeDrafts"), "proposalstudio: sanitizer exported");
  ok(codec.includes("hashOf(bytes) !== hash"), "proposalstudio: hash/call relation enforced in sanitizer");
  ok(codec.includes("bytes.length > MAX_PROPOSAL"), "proposalstudio: 4 KiB proposal cap enforced in sanitizer");
  const app = read("pages/proposal-studio/js/app.js");
  ok(app.includes("C.sanitizeDrafts(JSON.parse(localStorage.getItem(VKEY)"), "proposalstudio: localStorage load goes through the sanitizer");
  ok(app.includes("var clean = C.sanitizeDrafts(arr, draftHashOf);"), "proposalstudio: JSON import sanitizes before saving");
  ok(app.includes("take.length + \" of \" + arr.length"), "proposalstudio: import toast reports the kept count");
  const html = read("pages/proposal-studio/index.html");
  ok(html.includes("js/gov-codec.js?v=1.45.0"), "proposalstudio: gov-codec cache key bumped for the boundary fix (1.44.0)");
  ok(html.includes("js/app.js?v=1.45.0"), "proposalstudio: app.js cache key bumped for the boundary fix (1.44.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "proposalstudio: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "proposalstudio: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "proposalstudio: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "proposalstudio: lucklab sync patch-bump pin");
}

// Batch 64 (2026-10-12 19:19): Legacy Vault untrusted-plan boundary — the
// beneficiary plan loads from localStorage AND from a user-imported JSON
// file, and both paths only checked Array.isArray: a null beneficiary
// crashed validateBeneficiaries/buildLetter/renderers (TypeError), a
// numeric deadmanText crashed planForLetter's .trim(), and the import path
// persisted the poison so every later boot crashed too. plan-logic gains
// sanitizePlan (plain-object entries only, string fields only, known
// checklist ids, 100-entry caps, numeric sharePct stringified) and both
// load paths route through it; the validators and letter builder are
// hardened to report/placeholder instead of throwing on any entry shape.
{
  const logic = read("pages/legacy-vault/js/plan-logic.js");
  ok(logic.includes("function sanitizePlan(raw)"), "legacyvault: plan sanitizer present");
  ok(logic.includes("sanitizePlan, validateBeneficiaries"), "legacyvault: sanitizer exported");
  ok(logic.includes("const MAX_BENEFICIARIES = 100;"), "legacyvault: beneficiary cap pinned");
  ok(logic.includes("known.has(id)"), "legacyvault: checklist ids whitelisted in sanitizer");
  const app = read("pages/legacy-vault/js/app.js");
  ok(app.includes("const clean = LOGIC.sanitizePlan(p);"), "legacyvault: localStorage load goes through the sanitizer");
  ok(app.includes("plan = LOGIC.sanitizePlan(p);"), "legacyvault: JSON import goes through the sanitizer");
  const html = read("pages/legacy-vault/index.html");
  ok(html.includes("js/plan-logic.js?v=1.29.0"), "legacyvault: plan-logic cache key bumped for the boundary fix (1.28.0)");
  ok(html.includes("js/app.js?v=1.29.0"), "legacyvault: app.js cache key bumped for the boundary fix (1.28.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "legacyvault: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "legacyvault: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "legacyvault: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "legacyvault: lucklab sync patch-bump pin");
}
// Batch 66 (2026-10-12 21:19): Contact Vault persisted-state boundary —
// the vault loaded from localStorage with only `c && c.address` as a
// filter: a numeric address crashed refreshContactSelects (.slice) at
// boot and blanked the whole address book, a string checkphrase crashed
// chipsHTML (.map), a numeric addedAt crashed renderVaultList (.slice),
// an invalid/non-Quantus address painted as a saved contact in the
// poisoning-alarm app itself, and an id containing a quote broke out of
// the data-id attribute into innerHTML. The import path had the same
// class in miniature: parseImportPayload passed addedAt through raw and
// String()-coerced checkphrase elements, so a poisoned backup persisted
// a vault the next boot could not render. vault-logic gains
// sanitizeVault (plain objects, add-form-grade address validation,
// address+id dedupe with safe-charset id reassignment, capped strings,
// strict trusted, parseable-date addedAt, exactly-5-strings checkphrase
// shape, 500 cap); loadVault routes through it and persists the clean
// copy; parseImport/buildExport share the field cleaners; and the boot
// backfill now verifies EVERY stored checkphrase against a fresh
// derivation — the phrase is a derived field, so a mismatch is corrected
// and announced, never painted as truth.
{
  const logic = read("pages/contact-vault/js/vault-logic.js");
  ok(logic.includes("function sanitizeVault(raw)"), "contactvault: vault sanitizer present");
  ok(logic.includes("sanitizeVault: sanitizeVault"), "contactvault: sanitizer exported");
  ok(logic.includes("seenAddrs[v.address]"), "contactvault: sanitizer dedupes by address");
  ok(logic.includes("var MAX_CONTACTS = 500;"), "contactvault: vault cap pinned");
  const app = read("pages/contact-vault/js/app.js");
  ok(app.includes("var clean = LOGIC.sanitizeVault(parsed);"), "contactvault: localStorage load goes through the sanitizer");
  ok(app.includes("render the clean copy anyway"), "contactvault: clean copy persisted after sanitize");
  ok(app.includes("did not match its address"), "contactvault: backfill corrects a mismatched stored checkphrase");
  ok(app.includes('data-id="\' + esc(c.id)'), "contactvault: contact id escaped in the card attribute");
  const html = read("pages/contact-vault/index.html");
  ok(html.includes("js/vault-logic.js?v=1.29.0"), "contactvault: vault-logic cache key bumped for the boundary fix (1.28.0)");
  ok(html.includes("js/app.js?v=1.30.0"), "contactvault: app.js cache key bumped for the boundary fix (1.29.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "contactvault: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "contactvault: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "contactvault: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "contactvault: lucklab sync patch-bump pin");
}

// Batch 67 (2026-10-12 22:19): Pay Desk persisted-state boundary — the
// invoice register (the fleet's disclosed-fee carrier) loaded from
// localStorage with only Array.isArray as a check: a garbage usdCents
// threw inside BigInt() in renderRegister and bricked init, a garbage
// created threw in exportCsv's toISOString, and renderRequest painted
// inv.serviceFeeAddress verbatim and drew the payment QR from
// inv.address, so a stored entry could redirect the disclosed service
// fee — or the whole payment — to an address the merchant never
// entered. app.js gains sanitizeRegister (plain objects, add-form-grade
// address validation, canonical integer-string money fields, and every
// derived field recomputed: qtc from (usdCents, rate), the fee split
// from (plancks, bps) via splitServiceFee, the fee address pinned to
// SERVICE_FEE_ADDRESS; pre-fee-era invoices normalize to fee-less; ids
// deduped; 500 cap); loadRegister routes through it and persists the
// clean copy; loadRate now requires an exact-decimal rate + finite ts.
{
  const app = read("pages/pay-desk/js/app.js");
  ok(app.includes("function sanitizeRegister(raw, isValidAddress, nowMs)"), "paydesk-boundary: register sanitizer present");
  ok(app.includes("sanitizeRegister: sanitizeRegister"), "paydesk-boundary: sanitizer exported");
  ok(app.includes("if (inv.serviceFeeAddress !== (feePlancks > 0n ? SERVICE_FEE_ADDRESS : \"\")) continue;"), "paydesk-boundary: fee address pinned to the service address");
  ok(app.includes("inv.qtc !== centsToQtcString(usdCents, inv.rate)"), "paydesk-boundary: qtc recomputed from (usdCents, rate)");
  ok(app.includes("var clean = sanitizeRegister(raw, validator);"), "paydesk-boundary: localStorage load goes through the sanitizer");
  ok(app.includes("render the clean copy anyway"), "paydesk-boundary: clean copy persisted after sanitize");
  ok(app.includes("var REGISTER_CAP = 500;"), "paydesk-boundary: register cap pinned");
  const html = read("pages/pay-desk/index.html");
  ok(html.includes("js/app.js?v=1.51.0"), "paydesk-boundary: app.js cache key bumped for the boundary fix (1.48.0, superseded by the 1.49.0 rate-grammar bump and the 1.50.0 csv-formula bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "paydesk-boundary: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "paydesk-boundary: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "paydesk-boundary: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "paydesk-boundary: lucklab sync patch-bump pin");
}

// Batch 68 (2026-10-12 23:19): Chain Console history persisted-state
// boundary — loadHistory returned the parsed localStorage array as-is:
// a null entry crashed renderHistory at h.ok and blanked the panel, a
// garbage ms painted "NaN ms", and worst, paramsPreview is display-only
// while re-run executes params — a stored entry previewing "[]" could
// carry author_submitExtrinsic params, and one re-run click broadcast
// a signed extrinsic with none of the gated recipe path's review +
// acknowledgement. core.js gains sanitizeHistory (plain objects only,
// bounded method charset incl. the composite 'system_* (×5)', finite
// non-negative ms or drop, strict ok, failure-only capped error, the
// historyEntry 8192-char params cap re-enforced with demotion to null
// — never truncation — broadcast methods ALWAYS demoted to null, and
// the derived paramsPreview recomputed from the kept params);
// loadHistory routes through it and persists the clean copy; app.js
// refuses history re-runs of broadcast methods outright.
{
  const core = read("pages/chain-console/js/core.js");
  ok(core.includes("export function sanitizeHistory(raw)"), "console-boundary: sanitizeHistory() defined in core.js");
  ok(core.includes("!BROADCAST_METHODS.includes(h.method)"), "console-boundary: broadcast params demoted in the sanitizer");
  ok(core.includes("paramsPreview: params ? shortHex(JSON.stringify(params), 40) : '(params not stored)'"), "console-boundary: preview recomputed from kept params");
  ok(core.includes("const clean = sanitizeHistory(parsed);"), "console-boundary: loadHistory routes through the sanitizer");
  ok(core.includes("render the clean copy anyway"), "console-boundary: clean copy persisted after sanitize");
  const app = read("pages/chain-console/js/app.js");
  ok(app.includes("Broadcasts are not re-run from history"), "console-boundary: app refuses broadcast re-runs from history");
  const html = read("pages/chain-console/index.html");
  ok(html.includes("js/app.js?v=1.49.0"), "console-boundary: app.js cache key bumped for the boundary fix (1.46.0, superseded by the 1.47.0 reserved-prefix bump and the 1.48.0 supply-cap bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "console-boundary: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "console-boundary: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "console-boundary: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "console-boundary: lucklab sync patch-bump pin");
}

// Batch 69 (2026-10-13 00:19): Mempool Desk persisted-watcher boundary —
// loadSaved kept any stored watcher whose address was a string, while
// the add form enforces checkAddress (checksum + prefix 189), a 40-char
// label cap, and dedupe: a bad-checksum or another chain's address from
// hand-edited storage or an older build got subscribed and rendered as
// a watched Quantus address, and duplicates double-subscribed.
// rpc-core gains sanitizeWatchers (plain objects only, strict SS58-189
// shape AND checkAddress, dedupe, label capped at the form's 40, list
// capped at MAX_WATCHERS=50); loadSaved routes through it and persists
// the clean copy via saveWatchers.
{
  const core = read("pages/mempool-desk/js/rpc-core.js");
  ok(core.includes("function sanitizeWatchers(raw, decodeFn)"), "mempool-watchers: sanitizeWatchers() defined in rpc-core");
  ok(core.includes("if (!SS58_189_RE.test(addr)) continue;"), "mempool-watchers: strict SS58-189 shape enforced at load");
  ok(core.includes("if (!checkAddress(addr, decodeFn).ok) continue;"), "mempool-watchers: checksum + prefix enforced at load");
  ok(core.includes("var MAX_WATCHERS = 50;"), "mempool-watchers: watcher list capped");
  const app = read("pages/mempool-desk/js/app.js");
  ok(app.includes("C.sanitizeWatchers(w, decodeAddr)"), "mempool-watchers: loadSaved routes through the sanitizer");
  ok(app.includes("persist the clean copy so the poison does not reload"), "mempool-watchers: clean copy persisted after sanitize");
  const html = read("pages/mempool-desk/index.html");
  ok(html.includes("js/rpc-core.js?v=1.36.0"), "mempool-watchers: rpc-core.js cache key bumped for the boundary fix (1.36.0)");
  ok(html.includes("js/app.js?v=1.38.0"), "mempool-watchers: app.js cache key bumped for the boundary fix (1.38.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "mempool-watchers: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "mempool-watchers: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "mempool-watchers: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "mempool-watchers: lucklab sync patch-bump pin");
}

// Batch 70 (2026-10-13 01:19): Web Wallet keystore vault-blob boundary —
// the encrypted vault (Tier 1) was parsed with presence checks only:
// importVaultFile accepted any v:1 blob with salt/iv/ciphertext present
// and wrote it straight over the existing vault (a shaped-but-garbage
// backup destroyed the working vault), and openVault's hexToBytes
// silently mapped non-hex to 0 bytes, so a corrupt stored blob failed
// AES-GCM and was reported as "wrong password". keystore gains exported
// validateVaultBlob (plain object, v 1, scheme 65/87, pinned kdf/cipher/
// iterations when present, salt exactly 32 hex chars, iv exactly 24,
// ciphertext even hex within a 64 KiB ceiling); both reads route
// through parseVaultBlob so shape failures say the vault is corrupted,
// "wrong password" is reserved for a well-formed blob whose GCM tag
// fails, and import validates BEFORE persisting and stores only the
// known fields.
{
  const ks = read("pages/web-wallet/js/keystore.js");
  ok(ks.includes("export function validateVaultBlob(blob)"), "wallet-keystore: validateVaultBlob() defined in keystore");
  ok(ks.includes("blob.salt.length !== SALT_HEX_LEN"), "wallet-keystore: salt length pinned at load");
  ok(ks.includes("blob.iv.length !== IV_HEX_LEN"), "wallet-keystore: iv length pinned at load");
  ok(ks.includes("const blob = parseVaultBlob(raw);"), "wallet-keystore: openVault routes through the validator");
  ok(ks.includes("const blob = parseVaultBlob(text);"), "wallet-keystore: import validates before persisting");
  ok(ks.includes("stray fields is stored clean"), "wallet-keystore: import persists only the known fields");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './keystore.js?v=1.1.0'"), "wallet-keystore: keystore import carries the module cache pin");
  const html = read("pages/web-wallet/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "wallet-keystore: app.js cache key bumped for the keystore boundary fix (1.43.0, superseded by the 1.44.0 reserved-prefix bump and the 1.45.0 supply-cap bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "wallet-keystore: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "wallet-keystore: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "wallet-keystore: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "wallet-keystore: lucklab sync patch-bump pin");
}

// Batch 71 (2026-10-13 02:19): Ledger Desk stored-state relations round 3 —
// rounds 1-2 shape-checked the vault and relation-checked the SNAPSHOTS,
// but the stored state itself only shape-checked: sanitizeState kept any
// non-empty string as a vault address (the add form requires SS58 decode +
// checksum + prefix 189 + 32-byte key and refuses duplicates), kept any
// string list as the checkphrase (a derived field — a wrong 5-word set was
// painted beside the address as truth), kept duplicate event ids (the
// match key for delete and CSV dedupe), amounts above the whole 21M QTC
// supply, and price days like 2026-02-31 that matched the date regex but
// are not calendar dates. sanitizeState now takes a validateAddress
// option (app supplies the full decoder; core falls back to the strict
// SS58-189 shape), dedupes addresses and event ids (first wins), bounds
// quantities by MAX_SUPPLY_PLANCKS, requires event addresses to validate
// or be empty, keeps words only as exactly 5 strings, round-trips price
// days to real dates and dedupes them last-wins (priceLookup semantics),
// and caps the lists; load() persists the clean copy, verifyStoredWords
// re-derives every stored checkphrase at boot and corrects mismatches
// with an announcement, and CSV import enforces the same relations.
{
  const core = read("pages/ledger-desk/ledger-core.js");
  ok(core.includes("function sanitizeState(raw, opts)"), "ledger3: sanitizeState takes the validator option");
  ok(core.includes("qty > MAX_SUPPLY_PLANCKS"), "ledger3: event quantities bounded by the 21M supply");
  ok(core.includes("duplicate match key: drop, first wins"), "ledger3: duplicate event ids dropped, first wins");
  ok(core.includes("dt.toISOString().slice(0, 10) !== p.day"), "ledger3: price days round-trip to real calendar dates");
  ok(core.includes("MAX_VAULT_ADDRESSES: MAX_VAULT_ADDRESSES"), "ledger3: vault cap exported");
  const app = read("pages/ledger-desk/app.js");
  ok(app.includes("function validVaultAddress(a)"), "ledger3: app supplies the full SS58 validator");
  ok(app.includes("L.sanitizeState(parsed, { validateAddress: validVaultAddress })"), "ledger3: load routes through the strict validator");
  ok(app.includes("function verifyStoredWords()"), "ledger3: boot checkphrase re-derivation defined");
  ok(app.includes("Corrected the stored checkphrase for "), "ledger3: correction is announced in the vault panel");
  ok(app.includes("qty > L.MAX_SUPPLY_PLANCKS"), "ledger3: CSV import enforces the supply bound");
  const html = read("pages/ledger-desk/index.html");
  ok(html.includes("ledger-core.js?v=1.7.0"), "ledger3: ledger-core cache key bumped for the round-3 fix (1.3.0, superseded by the 1.4.0 internal-inflow bump and the 1.5.0 csv-formula bump)");
  ok(html.includes("app.js?v=1.10.0"), "ledger3: app.js cache key bumped for the round-3 fix (1.7.0, superseded by the 1.8.0 csv-formula bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "ledger3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "ledger3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "ledger3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "ledger3: lucklab sync patch-bump pin");
}

// Batch 72 (2026-10-13 03:19): MultiSig Vault proposal-board relations —
// the board's shape round lived in app.js and checked shapes only, so a
// stored entry could carry an inner call no builder in the fleet would
// ever produce (every encode* in msig-core rejects calls over
// MAX_CALL_SIZE = 10240 bytes, yet the board rendered and blake2b-hashed
// a stored call of any size on every boot), a threshold above
// MAX_SIGNERS = 100 (deriveMultisigAddress caps the signer count there
// and threshold at the count — no such vault can exist), a proposal id
// beyond u32 (encodeApprove's isU32 rejects it), an expiry beyond any
// plausible chain height, two rows describing the SAME (vault, id)
// on-chain proposal with different calls/statuses, and an unbounded
// entry count (renderBoard paints + hashes every entry at boot).
// sanitizeBoard moved into msig-core (testable pure logic) and now
// enforces the producers' relations: call <= MAX_CALL_SIZE, threshold
// floored then bounded by MAX_SIGNERS, id within u32, expiry within
// 1..MAX_BOARD_BLOCK (10,000,000, the fleet height ceiling), (vault, id)
// dedupe first-wins, approvals clamped to threshold, board capped at
// MAX_BOARD_ENTRIES = 500; loadBoard routes through it and persists the
// clean copy. Fractional expiry/threshold are floored, not dropped —
// the board form itself can write them.
{
  const core = read("pages/multisig-vault/js/msig-core.js");
  ok(core.includes("function sanitizeBoard(raw)"), "msig-board: sanitizeBoard defined in the core");
  ok(core.includes("callBytes.length > MAX_CALL_SIZE"), "msig-board: stored inner calls bounded by MAX_CALL_SIZE");
  ok(core.includes("threshold > MAX_SIGNERS"), "msig-board: threshold bounded by MAX_SIGNERS");
  ok(core.includes("id > 4294967295"), "msig-board: proposal id bounded by u32");
  ok(core.includes("expiry > MAX_BOARD_BLOCK"), "msig-board: expiry bounded by the plausible-height ceiling");
  ok(core.includes("MAX_BOARD_ENTRIES = 500"), "msig-board: board entry cap pinned at 500");
  ok(core.includes("seen[key]"), "msig-board: (vault, id) dedupe first-wins");
  ok(core.includes("sanitizeBoard: sanitizeBoard"), "msig-board: sanitizer exported");
  const app = read("pages/multisig-vault/js/app.js");
  ok(app.includes("C.sanitizeBoard(raw)"), "msig-board: loadBoard routes through the core sanitizer");
  ok(!app.includes("function sanitizeBoard(raw)"), "msig-board: app.js shape-only copy removed");
  const html = read("pages/multisig-vault/index.html");
  ok(html.includes("js/msig-core.js?v=1.30.0"), "msig-board: msig-core cache key bumped for the board fix (1.25.0, superseded by the 1.27.0 reserved-prefix bump and the 1.27.0 supply-cap bump)");
  ok(html.includes("js/app.js?v=1.28.0"), "msig-board: app.js cache key bumped for the board fix (1.25.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "msig-board: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "msig-board: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "msig-board: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "msig-board: lucklab sync patch-bump pin");
}

// Batch 73 (2026-10-13 04:19): Notary Desk vault relations round 3 —
// rounds 1-2 checked shapes and the envelope relations, but the
// sanitizer accepted values the only producer (the Build button)
// could never write: a remark payload of any size (messages are
// capped at MAX_MESSAGE_BYTES = 4096, envelopes far below), a feeQTC
// that is DERIVED (totalBytes x LENGTH_FEE_PER_BYTE in formatQTC's
// canonical decimal — the achievable totals for a call are two
// disjoint 4-wide intervals, one per scheme x nonce widths 1-4, so
// an invented fee like the old fixture's own 0.0005354 for a
// 47-byte call was unproducible), a label on a message anchor
// (builds write null), a created stamp before the chain's Sept-2026
// launch or in the future, duplicate callHex rows (the call IS the
// anchor's identity) and duplicate ids, and no entry cap.
// sanitizeVault now enforces the producer relations via
// validFeeForCall, dedupes by call (first-wins) and by id
// (reassignment), caps at MAX_VAULT_ENTRIES = 500, and loadVault
// persists the clean copy.
{
  const codec = read("pages/notary-desk/js/notary-codec.js");
  ok(codec.includes("function validFeeForCall(feeQTC, callLen)"), "notary3: validFeeForCall defined in the codec");
  ok(codec.includes("payloadBytes.length > MAX_MESSAGE_BYTES"), "notary3: stored payload bounded by the producer cap");
  ok(codec.includes("plancks % LENGTH_FEE_PER_BYTE !== 0n"), "notary3: fee plancks must be a whole number of signed bytes");
  ok(codec.includes("nonceBytes === 1 || nonceBytes === 2 || nonceBytes === 4"), "notary3: fee total must land in a scheme x nonce interval");
  ok(codec.includes("MAX_VAULT_ENTRIES = 500"), "notary3: vault entry cap pinned at 500");
  ok(codec.includes("seenCalls.has(callKey)"), "notary3: duplicate anchors deduped by call, first wins");
  ok(codec.includes("createdMs < VAULT_EPOCH_MS"), "notary3: created bounded by the chain launch and the future skew");
  ok(codec.includes("a.label !== null && a.label !== undefined) continue"), "notary3: message anchors carry no label");
  ok(codec.includes("MAX_VAULT_ENTRIES: MAX_VAULT_ENTRIES"), "notary3: cap exported for the unit suite");
  const app = read("pages/notary-desk/js/app.js");
  ok(app.includes("JSON.stringify(clean) !== raw"), "notary3: loadVault persists the clean copy");
  const html = read("pages/notary-desk/index.html");
  ok(html.includes("js/notary-codec.js?v=1.51.0"), "notary3: notary-codec cache key bumped for the relations fix (1.50.0)");
  ok(html.includes("js/app.js?v=1.55.0"), "notary3: app.js cache key bumped for the relations fix (1.54.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "notary3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "notary3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "notary3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "notary3: lucklab sync patch-bump pin");
}

// Batch 74 (2026-10-13 05:19): Watchtower stored-state relations
// round 3 (Tier 2) — rounds 1-2 (Batches 16/54) shape-checked the
// stored state and relation-checked the chain payloads, but the
// stored watchlist/alerts/baselines accepted values no producer
// could write: a checkphrase of ANY length (the derivation always
// yields exactly 5 words, and only a null phrase backfilled, so a
// wrong stored phrase painted forever as the address's phrase),
// nick/note past the add form's maxlengths, duplicate alert ids
// (read toggles and scan dedupe match on id), alert timestamps any
// parseable date (2020/2999 are not scan times), alert addresses
// that are not Quantus addresses, uncapped title/detail and no feed
// cap, baseline keys that are not addresses at all (they persist
// forever — evaluation only advances ruled addresses), baseline
// balances above the whole 21M supply, a stall head above the fleet
// height ceiling, and governance counts of any size. sanitizeWatchlist
// moves into watch-core (the app supplies its full-grade validator)
// and enforces exactly-5-or-null phrases, form caps, dedupe and a
// 500 cap; sanitizeAlerts dedupes first-wins, requires chainTimeMs
// timestamps, pins addresses to the SS58-189 shape or null, caps
// fields and the feed at 500; sanitizeBaselines drops non-address
// keys, nulls over-supply balances, bounds the stall head by
// validChainHeight and the gov counts by MAX_GOV_COUNT. The app
// persists the clean copy, the rule repair pass uniquifies duplicate
// rule ids and dedupes content-identical rules (persisting on ANY
// change), the import loop skips poisoned rows instead of failing
// the whole import, and init verifies every stored checkphrase
// against a fresh derivation, replacing mismatches with an
// announcement.
{
  const core = read("pages/watchtower/js/watch-core.js");
  ok(core.includes("function sanitizeWatchlist(rows, validateFn)"), "watchtower3: sanitizeWatchlist defined in watch-core");
  ok(core.includes("x.checkphrase.length === 5"), "watchtower3: stored checkphrase must be exactly the derived 5 words or null");
  ok(core.includes("x.nick.slice(0, 40)"), "watchtower3: nick capped at the add form's maxlength");
  ok(core.includes("MAX_WATCHLIST = 500"), "watchtower3: watchlist capped at 500");
  ok(core.includes("if (seen[a.id]) return;"), "watchtower3: duplicate alert ids count once, first wins");
  ok(core.includes("if (chainTimeMs(a.ts) === null) return;"), "watchtower3: alert timestamps must be real chain-era scan times");
  ok(core.includes("SS58_189_RE.test(a.address) ? a.address : null"), "watchtower3: alert addresses pinned to Quantus shape or null");
  ok(core.includes("out.slice(0, MAX_ALERTS)"), "watchtower3: alert feed capped at the scan path's 500");
  ok(core.includes("if (!SS58_189_RE.test(addr)) return;"), "watchtower3: baseline keys must be real Quantus addresses");
  ok(core.includes("bal <= MAX_SUPPLY_PLANCKS ? bal.toString() : null"), "watchtower3: over-supply baseline balances read unknown, never fact");
  ok(core.includes("validChainHeight(raw.chain.stallFiredHead)"), "watchtower3: stall head bounded by the fleet height ceiling");
  ok(core.includes("sanitizeWatchlist: sanitizeWatchlist,"), "watchtower3: sanitizeWatchlist exported");
  const app = read("pages/watchtower/js/app.js");
  ok(app.includes("if (storedLoaded) save();"), "watchtower3: load persists the sanitized copy");
  ok(app.includes("seenIds[r.id] ? r.id : nextRuleId()"), "watchtower3: duplicate rule ids reassigned, never dropped");
  ok(app.includes("if (seenSig[sig]) return;"), "watchtower3: content-identical stored rules deduped");
  ok(app.includes("entry.checkphrase.join(\" \") !== w.join(\" \")"), "watchtower3: stored checkphrases verified against a fresh derivation at init (in queuePhraseFill since Batch 129)");
  ok(app.includes("one poisoned row must not fail the whole import"), "watchtower3: import skips poisoned watchlist rows");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/watch-core.js?v=1.36.0"), "watchtower3: watch-core cache key bumped for the relations fix (1.33.0)");
  ok(html.includes("js/app.js?v=1.38.0"), "watchtower3: app.js cache key bumped for the relations fix (1.36.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "watchtower3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "watchtower3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "watchtower3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "watchtower3: lucklab sync patch-bump pin");
}

// ---- 75. Emission Lab: snapshot-boundary hardening round 2 (relations) ----
// Batch 2 shape-checked each block alone and FILTERED failures out, so a
// mixed-date snapshot (height gap, interior timestamp out of order, one
// reward far from the quantized cluster, status disagreeing with the block
// list) still anchored every figure on the surviving rows, and a fetched_at
// from 2999 painted as the snapshot time. Round 2 moves anchorFromSnapshot
// into pure exported logic and enforces the producer's relations
// (scripts/fetch-chain-data.mjs: latest <=15 blocks, height desc).
{
  const src = read("pages/emission-lab/app.js");
  ok(src.includes("function anchorFromSnapshot(data, nowMs)"), "emission2: anchorFromSnapshot() defined as pure logic with an injectable clock");
  ok(src.includes("anchorFromSnapshot: anchorFromSnapshot,"), "emission2: anchor exported for the unit suite");
  ok(src.includes("blocks.length < 2 || blocks.length > 15"), "emission2: window is the producer's 2..15 blocks (block time always observed)");
  ok(src.includes("heights[j - 1] - heights[j] !== 1"), "emission2: heights strictly descending and consecutive");
  ok(src.includes("h > MAX_CHAIN_HEIGHT"), "emission2: heights bounded by the fleet ceiling");
  ok(src.includes("rw % LEAF_PLANCKS !== 0"), "emission2: rewards are exact leaf-quantum multiples (minted shape)");
  ok(src.includes("cluster.length < Math.ceil(rewards.length / 2)"), "emission2: base cluster must be the window majority (round 3 producer semantics: payout = base + fees)");
  ok(src.includes("sh !== heights[0]"), "emission2: status block_height must equal the top block (same moment)");
  ok(src.includes("times[0] > fetchedMs + 60000"), "emission2: newest block cannot be newer than its snapshot");
  ok(src.includes("fm >= GENESIS_FLOOR_MS && fm <= now + 3600000"), "emission2: fetched_at held to fleet capture-time bounds");
  ok(!src.includes("data.blocks.filter(function(b)"), "emission2: no filter-and-anchor-on-survivors path remains");
  const html = read("pages/emission-lab/index.html");
  ok(html.includes("app.js?v=1.17.0"), "emission2: app.js cache key bumped for the round-3 fix (1.17.0)");
}


// ---- 76. Fleet SS58 reserved-prefix sweep ----
// Address Toolkit's round (Batch 63) taught its own decoder to reject the
// reserved SS58 prefix forms (first-byte top bits 10/11), but the fix never
// propagated to the 22 other vendored decoder copies. A hand-built payload
// starting 0xBD carries a valid checksum over its own bytes and every other
// copy read it as a 1-byte prefix — fabricating prefix 189, a "genuine"
// Quantus address that spec-compliant decoders and the chain reject.
// Every decoder in the fleet now rejects the reserved forms explicitly.
{
  const okFiles = [
    "pages/safesend/js/ss58.js", "pages/contact-vault/js/ss58.js",
    "pages/distribution-planner/js/ss58.js", "pages/flow-tracer/js/ss58.js",
    "pages/watchtower/js/ss58.js", "pages/portfolio-desk/js/ss58.js",
    "pages/vesting-desk/js/ss58.js", "pages/mempool-desk/js/ss58.js",
    "pages/extrinsic-lab/js/vendor/ss58.js", "pages/pay-desk/js/ss58.js",
    "pages/cli-forge/js/ss58.js", "pages/multisig-vault/js/msig-core.js",
    "pages/reversal-desk/js/reversal-core.js", "pages/exposure-lab/js/exposure-core.js",
    "pages/scale-lab/js/vendor/scale-crypto.js", "pages/proposal-studio/js/vendor/scale-crypto.js",
    "pages/whale-watch/app.js",
  ];
  for (const f of okFiles)
    ok(read(f).includes("Reserved SS58 prefix form"), "ss58res: " + f + " rejects the reserved prefix forms");
  const esmFiles = [
    "pages/key-forge/js/quantus-crypto.js", "pages/web-wallet/js/quantus-crypto.js",
    "pages/airgap-desk/js/lib/quantus-crypto.js", "pages/chain-console/js/lib/quantus-crypto.js",
    "pages/zktree-desk/js/quantus-crypto.js",
  ];
  for (const f of esmFiles) {
    ok(read(f).includes("Reserved SS58 prefix form"), "ss58res: " + f + " rejects the reserved prefix forms");
    ok(read(f).includes("(raw[0] & 0xc0) !== 0x40"), "ss58res: " + f + " branches on the full top-bit pair, not bit 6 alone");
  }
  ok(read("pages/safesend/index.html").includes("js/ss58.js?v=1.2.0"), "ss58res: safesend ss58 cache key bumped (1.1.0)");
  ok(read("pages/contact-vault/index.html").includes("js/ss58.js?v=1.27.0"), "ss58res: contact-vault ss58 cache key bumped (1.26.0)");
  ok(read("pages/ledger-desk/index.html").includes("../contact-vault/js/ss58.js?v=1.27.0"), "ss58res: ledger cross-loads the bumped contact-vault ss58 (1.26.0)");
  ok(read("pages/pay-desk/index.html").includes("js/ss58.js?v=1.46.0"), "ss58res: pay-desk ss58 cache key bumped (1.45.0)");
  ok(read("pages/cli-forge/index.html").includes("js/ss58.js?v=1.47.0"), "ss58res: cli-forge ss58 cache key bumped (1.46.0)");
  ok(read("pages/extrinsic-lab/index.html").includes("js/vendor/ss58.js?v=1.42.0"), "ss58res: extrinsic-lab ss58 cache key bumped (1.41.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/msig-core.js?v=1.30.0"), "ss58res: msig-core cache key bumped (1.27.0)");
  ok(read("pages/reversal-desk/index.html").includes("js/reversal-core.js?v=1.55.0"), "ss58res: reversal-core cache key bumped (1.54.0)");
  ok(read("pages/exposure-lab/index.html").includes("js/exposure-core.js?v=1.58.0"), "ss58res: exposure-core cache key bumped (1.55.0)");
  ok(read("pages/scale-lab/index.html").includes("js/vendor/scale-crypto.js?v=1.43.0"), "ss58res: scale-lab scale-crypto cache key bumped (1.42.0)");
  ok(read("pages/proposal-studio/index.html").includes("js/vendor/scale-crypto.js?v=1.44.0"), "ss58res: proposal-studio scale-crypto cache key bumped (1.43.0)");
  ok(read("pages/whale-watch/index.html").includes("app.js?v=1.25.0"), "ss58res: whale-watch app.js cache key bumped (superseded by the 1.24.0 round-4 bump)");
  ok(read("pages/key-forge/index.html").includes("js/app.js?v=1.5.0"), "ss58res: key-forge entry cache key bumped (1.4.0)");
  ok(read("pages/web-wallet/index.html").includes("js/app.js?v=1.46.0"), "ss58res: web-wallet entry cache key bumped (1.44.0)");
  ok(read("pages/airgap-desk/index.html").includes("js/app.js?v=1.50.0"), "ss58res: airgap entry cache key bumped (1.48.0)");
  ok(read("pages/chain-console/index.html").includes("js/app.js?v=1.49.0"), "ss58res: chain-console entry cache key bumped (1.47.0)");
  ok(read("pages/zktree-desk/index.html").includes("js/app.js?v=1.51.0"), "ss58res: zktree entry cache key bumped (1.49.0, superseded by the 1.50.0 proof-bounds bump)");
}

// Batch 77 (2026-10-13 09:19): Vanity Forge vault stored-state relations —
// sanitizeVault shape-checked stored finds only, so a poisoned qvf-vault-v1
// could paint records no grind could ever have produced: an address that
// does not match its claimed pattern (onFound fires only when
// addressMatches passes), a pattern the forge itself would refuse or
// stores unnormalized (impossible pinned first char, case-sensitive
// uppercase pinned char, unstripped leading qz), a bad-checksum address
// (shape regex only), a secretHex of any length (the noble secret key is
// scheme-pinned: 8064 hex chars for ML-DSA-65, 9792 for ML-DSA-87 — a
// 4-char "secret" painted as a find would strand funds), a date before
// the chain existed or in the future, an attempts/ms pair implying a
// grind rate above the bench plausibility cap, and duplicate rows for
// one address. sanitizeVault now enforces the producer relations (with
// opts.validateAddress supplying the full SS58 decode in the app) and
// load persists the clean copy.
{
  const core = read("pages/vanity-forge/js/vanity.js");
  ok(core.includes("export const SECRET_HEX_LEN = { '65': 8064, '87': 9792 };"), "vanityrel: secret length pinned per scheme");
  ok(core.includes("export const VAULT_DATE_FLOOR_MS = Date.parse('2026-09-01T00:00:00.000Z');"), "vanityrel: find-date floor pinned to chain era");
  ok(core.includes("const v = validatePattern(rec.pattern, rec.position, caseSensitive);"), "vanityrel: stored pattern re-validated under its own mode");
  ok(core.includes("if (!v.ok || v.pattern !== rec.pattern) continue;"), "vanityrel: unnormalized pattern dropped");
  ok(core.includes("if (!addressMatches(rec.address, rec.pattern, { caseSensitive, position: rec.position })) continue;"), "vanityrel: address must match its claimed pattern");
  ok(core.includes("if (validateAddress && !validateAddress(rec.address)) continue;"), "vanityrel: app-supplied decoder gates the address");
  ok(core.includes("if (seen.has(rec.address)) continue;"), "vanityrel: duplicate address rows dropped");
  ok(core.includes("if (t < VAULT_DATE_FLOOR_MS || t > now + 5 * 60 * 1000) continue;"), "vanityrel: date held to the find window");
  ok(core.includes("rec.secretHex.length !== SECRET_HEX_LEN[rec.scheme]) continue;"), "vanityrel: secret length held to the scheme pin");
  ok(core.includes("if (attempts * 1000 > MAX_PLAUSIBLE_RATE * (ms + 1)) continue;"), "vanityrel: implied grind rate capped");
  const app = read("pages/vanity-forge/js/app.js");
  ok(app.includes("const validQuantusAddress = (a) => {"), "vanityrel: app defines the full-grade address validator");
  ok(app.includes("d.prefix === 189 && d.accountId.length === 32"), "vanityrel: validator pins prefix 189 + 32-byte key");
  ok(app.includes("{ validateAddress: validQuantusAddress }"), "vanityrel: vault load supplies the validator");
  ok(app.includes("if (rawVault !== null && rawVault !== JSON.stringify(vault)) saveVault();"), "vanityrel: load persists the clean vault copy");
  ok(read("pages/vanity-forge/index.html").includes("js/app.js?v=1.27.0"), "vanityrel: app.js cache key bumped (1.26.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "vanityrel: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "vanityrel: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "vanityrel: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "vanityrel: lucklab sync patch-bump pin");
}

// Batch 78 (2026-10-13 10:19): Portfolio Desk vault stored-state relations —
// rounds 1-2 (Batches 17 + portfolio2) relation-checked the snapshot
// sanitizers, but sanitizeVaultEntries accepted any non-empty string as an
// address (the strict SS58-189 shape floor the snapshot paths use was
// missing in the core; only the app's load filter caught junk, and the
// dropped poison was never persisted away) and any safe integer as
// addedAt (a 1970 or 2999 stamp exported as the date an address was
// added). The sanitizer now enforces the producer relations (addToVault
// is fed only by the SS58-validated add form and writes Date.now()):
// shape floor, the app-supplied full validator via opts.validateAddress,
// and the addedAt window [GENESIS_FLOOR_MS, now + 5m] with out-of-window
// stamps replaced by now. Load persists the clean copy byte-compared;
// the import skips invalid rows and reports the dropped count instead
// of rejecting the whole backup over one poisoned row.
{
  const core = read("pages/portfolio-desk/js/desk-core.js");
  ok(core.includes("function sanitizeVaultEntries(rows, opts)"), "portfoliorel: sanitizeVaultEntries takes the validator opts");
  ok(core.includes("if (!SS58_189_RE.test(address) || seen[address]) return;"), "portfoliorel: strict SS58-189 shape floor in the vault sanitizer");
  ok(core.includes("if (validate && !validate(address)) return;"), "portfoliorel: app-supplied validator gates stored addresses");
  ok(core.includes("if (addedAt === null || addedAt < GENESIS_FLOOR_MS || addedAt > nowCeil) addedAt = Date.now();"), "portfoliorel: addedAt held to the producer window");
  ok(core.includes("function parseVaultJson(text, opts)"), "portfoliorel: parseVaultJson threads the opts through");
  const app = read("pages/portfolio-desk/js/app.js");
  ok(app.includes("validateAddress: function (a) { return validateQuantusAddress(a).ok; }"), "portfoliorel: vault load supplies the full validator");
  ok(app.includes("if (JSON.stringify(v) !== raw) saveVault();"), "portfoliorel: load persists the clean vault copy");
  ok(app.includes("dropped — not valid Quantus addresses."), "portfoliorel: import reports dropped rows honestly");
  ok(read("pages/portfolio-desk/index.html").includes("js/desk-core.js?v=1.36.0"), "portfoliorel: desk-core.js cache key bumped (1.36.0)");
  ok(read("pages/portfolio-desk/index.html").includes("js/app.js?v=1.37.0"), "portfoliorel: app.js cache key bumped (1.37.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "portfoliorel: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "portfoliorel: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "portfoliorel: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "portfoliorel: lucklab sync patch-bump pin");
}

// Batch 79 (2026-10-13 11:19): Proposal Studio draft-vault stored-state
// relations — the Batch ~63 sanitizer shape-checked stored drafts and
// enforced the hash relation, but accepted values the only producer
// (dv-save, fed by the composer) could never write: a callName that
// disagrees with its callHex (callName is DERIVED — the composer sets
// it from the built template / inspectCall — so a poisoned name painted
// and loaded into the pack a false proposal label), a track-1
// (fast_upgrade) draft carrying any call other than
// System.authorize_upgrade (the composer locks that track to the
// upgrade template; the runtime honors the FastUpgrade origin for
// nothing else, so such a draft can never execute), and a created
// stamp from 2020 or 2999 (dv-save stamps new Date().toISOString()).
// sanitizeDrafts now re-derives callName from the bytes, drops
// track-1 non-upgrade drafts, and holds created to
// [2026-09-01, now + 5m] or "" ("date unknown"); loadDrafts persists
// the clean copy byte-compared so poison does not survive the visit.
{
  const codec = read("pages/proposal-studio/js/gov-codec.js");
  ok(codec.includes("if (x.trackId === 1 && !(insp.ok && insp.palletIndex === 0 && insp.callIndex === 9)) continue;"), "proposalrel: track-1 drafts must be authorize_upgrade");
  ok(codec.includes("var callName = insp.ok ? insp.palletName + \".\" + insp.callName : \"call\";"), "proposalrel: callName re-derived from the call bytes");
  ok(codec.includes("createdMs >= CREATED_FLOOR_MS"), "proposalrel: created held to the producer window");
  ok(codec.includes("var CREATED_FLOOR_MS = Date.UTC(2026, 8, 1);"), "proposalrel: created floor is the Sept-2026 launch era");
  const app = read("pages/proposal-studio/js/app.js");
  ok(app.includes("if (raw && JSON.stringify(clean) !== raw) saveDrafts(clean);"), "proposalrel: load persists the clean draft copy");
  ok(read("pages/proposal-studio/index.html").includes("js/gov-codec.js?v=1.45.0"), "proposalrel: gov-codec cache key bumped (1.44.0)");
  ok(read("pages/proposal-studio/index.html").includes("js/app.js?v=1.45.0"), "proposalrel: app.js cache key bumped (1.44.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "proposalrel: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "proposalrel: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "proposalrel: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "proposalrel: lucklab sync patch-bump pin");
}

// Batch 80 (2026-10-13 12:19): Pay Desk register time/id relations —
// the Batch ~67 boundary recomputed every money relation (qtc, fee
// split, fee address) but held time/id to shape checks only: created
// needed merely be finite and > 0, so a 2020 or 2999 invoice painted
// and CSV-exported as fact; the id needed only a loose charset, though
// createInvoice derives it via makeInvoiceId from the SAME instant it
// stamps as created (the id's UTC stamp is a derived field); expiresAt
// accepted any offset >= created, though the producer writes only the
// expiry select's 15/30/60/1440 minutes; rateTs accepted any positive
// stamp, though it is the saveRate time from BEFORE the invoice; and
// loadRate's stored ts was likewise unbounded. sanitizeRegister now
// drops out-of-window created, requires the producer id form with its
// stamp equal to created, coerces non-producer expiry offsets to
// created (already expired, never live), and falls rateTs back to
// created outside [floor, created + 5m]; loadRate rejects stored
// stamps outside [floor, now + 5m] and is exported for tests.
{
  const app = read("pages/pay-desk/js/app.js");
  ok(app.includes("function sanitizeRegister(raw, isValidAddress, nowMs)"), "paydeskrel: sanitizer takes an injectable now");
  ok(app.includes("var REGISTER_FLOOR_MS = Date.UTC(2026, 8, 1);"), "paydeskrel: stamp floor is the Sept-2026 desk era");
  ok(app.includes("inv.created < REGISTER_FLOOR_MS || inv.created > now + 5 * 60 * 1000"), "paydeskrel: created held to the producer window");
  ok(app.includes("/^INV-\\d{8}-\\d{6}-[0-9A-Z]{3}$/"), "paydeskrel: id must be in the producer's exact form");
  ok(app.includes("inv.id.slice(0, 20) !== makeInvoiceId(inv.created).slice(0, 20)"), "paydeskrel: id stamp re-derived from created");
  ok(app.includes("var REGISTER_EXPIRY_OFFSETS_MS = [15, 30, 60, 1440].map"), "paydeskrel: expiry offsets are the select's producer set");
  ok(app.includes("REGISTER_EXPIRY_OFFSETS_MS.indexOf(inv.expiresAt - inv.created) >= 0"), "paydeskrel: non-producer expiry coerces to created");
  ok(app.includes("inv.rateTs >= REGISTER_FLOOR_MS && inv.rateTs <= inv.created + 5 * 60 * 1000"), "paydeskrel: rateTs held to [floor, created + 5m]");
  ok(app.includes("function loadRate(nowMs)"), "paydeskrel: loadRate takes an injectable now");
  ok(app.includes("r.ts < REGISTER_FLOOR_MS || r.ts > now + 5 * 60 * 1000"), "paydeskrel: stored rate stamp held to the producer window");
  ok(app.includes("loadRate: loadRate,"), "paydeskrel: loadRate exported");
  ok(read("pages/pay-desk/index.html").includes("js/app.js?v=1.51.0"), "paydeskrel: app.js cache key bumped (1.48.0, superseded by the 1.49.0 rate-grammar bump and the 1.50.0 csv-formula bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "paydeskrel: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "paydeskrel: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "paydeskrel: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "paydeskrel: lucklab sync patch-bump pin");
}

// Batch 81 (2026-10-13 13:19): Legacy Vault plan stored-state
// relations — the Batch ~63 boundary shape-checked the stored plan,
// but sanitizePlan accepted values its only producer (the plan form)
// can never write: sharePct passed any string of <= 32 chars, though
// it is written solely from an <input type="number"> whose .value is
// "" or an HTML float-grammar string (the browser itself refuses to
// hold "abc", "1.2.3", " 50", "50%", "0x10", "+50", "1e"), so a
// poisoned qlv-plan-v1 painted a nonsense share in the row, the
// export, and the printed letter; and deadmanChoice accepted any
// string, though the #deadman-radios radios write exactly
// trusted|lawyer|checkin|shares. pctStr now holds shares to the
// float grammar (finite numbers stringify first, as before) with ""
// (unassigned) as the neutral, deadmanChoice is held to the radio
// set, and loadPlan persists the clean copy byte-compared so poison
// does not survive the visit.
{
  const logic = read("pages/legacy-vault/js/plan-logic.js");
  ok(logic.includes("const FLOAT_STR_RE = /^-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/;"), "legacyrel: share held to the number input's float grammar");
  ok(logic.includes("return FLOAT_STR_RE.test(s) ? s : \"\";"), "legacyrel: non-producer share falls to '' (unassigned)");
  ok(logic.includes("const DEADMAN_CHOICES = [\"trusted\", \"lawyer\", \"checkin\", \"shares\"];"), "legacyrel: dead-man choices are the radio producer set");
  ok(logic.includes("deadmanChoice: deadmanChoiceStr(p.deadmanChoice),"), "legacyrel: deadmanChoice sanitized through the radio relation");
  const app = read("pages/legacy-vault/js/app.js");
  ok(app.includes("if (raw && JSON.stringify(clean) !== raw)"), "legacyrel: load persists the clean plan copy byte-compared");
  ok(read("pages/legacy-vault/index.html").includes("js/plan-logic.js?v=1.29.0"), "legacyrel: plan-logic cache key bumped (1.28.0)");
  ok(read("pages/legacy-vault/index.html").includes("js/app.js?v=1.29.0"), "legacyrel: app.js cache key bumped (1.28.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "legacyrel: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "legacyrel: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "legacyrel: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "legacyrel: lucklab sync patch-bump pin");
}

// Batch 83 (2026-10-13 15:19): Airgap Desk ticket nonce u32 bound —
// decodeTicket bounded spec/txv to u32 (round 2) and head to the fleet
// chain-height ceiling, but the nonce was checked only as a
// non-negative integer, though the issuer's own parseNonce
// (system_accountNextIndex) can only ever produce a u32. A crafted or
// corrupted ticket with nonce >= 2^32 compact-encoded a value the
// account can never hold, and a non-safe integer (>= 2^53) did not
// even survive JSON.parse — the ticket text and the signed value
// silently disagreed, self-consistently (reverify derives both from
// the same wrong number). decodeTicket now holds the nonce to the
// producer's u32 grammar, exactly like spec/txv.
{
  const ag = read("pages/airgap-desk/js/airgap.js");
  ok(ag.includes("if (!Number.isSafeInteger(obj.nonce) || obj.nonce > 0xFFFFFFFF)"), "airgapnonce: nonce held to safe-integer u32 in decodeTicket");
  ok(ag.includes("ticket: nonce must fit u32 (<= 4294967295)"), "airgapnonce: nonce u32 refusal message present");
  ok(read("pages/airgap-desk/index.html").includes("js/app.js?v=1.50.0"), "airgapnonce: app.js cache key bumped (1.48.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "airgapnonce: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "airgapnonce: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "airgapnonce: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "airgapnonce: lucklab sync patch-bump pin");
}

// Batch 84 (2026-10-13 16:19): Pay Desk stored-rate grammar + decimal
// parser exponent bound — loadRate and sanitizeRegister String()-coerced
// the stored rate, so a numeric rate, ".5", or an exponent form survived
// though the rate-save handler (the only producer) writes only a string
// matching /^\d+(\.\d+)?$/; and the exponent form reached
// parseDecimalRational, which computed 10n ** exponent unbounded — the
// 11-char stored "1e100000000" hung the desk at state init on every
// load. Both reads now hold the rate to the producer grammar, and the
// parser bounds |exponent|/|scale| at 1000 (past every JS-number
// stringification, e308 / 5e-324, and no real money decimal).
{
  const app = read("pages/pay-desk/js/app.js");
  ok(app.includes("var PRODUCER_RATE_RE = /^\\d+(\\.\\d+)?$/;"), "payrate: producer rate grammar defined once");
  ok(app.includes("var MAX_DECIMAL_SCALE = 1000;"), "payrate: decimal scale bound defined");
  ok(app.includes("if (!Number.isFinite(exp) || Math.abs(exp) > MAX_DECIMAL_SCALE) return null;"), "payrate: parser refuses an out-of-bound exponent instead of computing it");
  ok(app.includes("if (typeof r.usdPerQtc !== \"string\" || !PRODUCER_RATE_RE.test(r.usdPerQtc)) return null;"), "payrate: loadRate holds the stored rate to the producer string grammar");
  ok(app.includes("if (typeof inv.rate !== \"string\" || !PRODUCER_RATE_RE.test(inv.rate)) continue;"), "payrate: register holds inv.rate to the producer string grammar");
  ok(app.includes("if (!PRODUCER_RATE_RE.test(v) || Number(v) <= 0)"), "payrate: rate-save handler uses the shared grammar");
  ok(read("pages/pay-desk/index.html").includes("js/app.js?v=1.51.0"), "payrate: app.js cache key bumped (1.49.0, superseded by the 1.50.0 csv-formula bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "payrate: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "payrate: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "payrate: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "payrate: lucklab sync patch-bump pin");
}

// Batch 85 (2026-10-13 18:19): Governance Tracker snapshot relations
// round 2 — round 1 shape-checked each row alone, but the board's math
// assumes relations no shape check sees: tallies are TechCollective
// MEMBER counts (cap 13, one vote per member, bare ayes a subset of ayes,
// the Tally struct all-or-none), every row timestamp is a chain time
// inside the capture (genesis floor .. fetched_at + 60s), one referendum
// lives on one track with each lifecycle type once, track_name is derived
// from track and origin is pinned per track, the preimage hash and
// block_id must be real, and extrinsic success/index are typed. The
// boundary moved from app.js into gov-core as testable pure logic.
{
  const core = read("pages/governance-tracker/js/gov-core.js");
  ok(core.includes("function chainTimeMs(v, fetchedMs)"), "govrel: row timestamps held to chain times inside the capture");
  ok(core.includes("ms > fetchedMs + 60000"), "govrel: rows dated after the capture (+60s slack) drop");
  ok(core.includes("tally.tally_ayes + tally.tally_nays > GOV.max_member_count"), "govrel: ayes+nays bounded by the member cap (one vote per member)");
  ok(core.includes("tally.tally_bare_ayes > tally.tally_ayes"), "govrel: bare ayes bounded by ayes (no-conviction subset)");
  ok(core.includes("present && present !== tallyFields.length"), "govrel: partial tallies drop (the Tally struct is all-or-none)");
  ok(core.includes("groupTrack[k] !== undefined && groupTrack[k] !== r.track"), "govrel: one track per referendum — later track-flips drop");
  ok(core.includes("seenType[k + \"|\" + r.type]"), "govrel: one row per lifecycle type per referendum");
  ok(core.includes("track_name: trackObj.name"), "govrel: track_name re-derived from track");
  ok(core.includes("origin !== trackObj.origin) origin = null"), "govrel: origin pinned per track, foreign origins nulled");
  ok(core.includes("isPreimageHash(raw.proposal_preimage_hash) ? raw.proposal_preimage_hash : null"), "govrel: preimage hash must be a real 32-byte hash");
  ok(core.includes("function cleanBlockId(v)"), "govrel: block ids must carry a plausible height");
  ok(core.includes('raw.success === true ? true : raw.success === false ? false : null'), "govrel: extrinsic success is a boolean or null");
  ok(read("pages/governance-tracker/index.html").includes("js/gov-core.js?v=1.25.0"), "govrel: gov-core cache key bumped (1.25.0)");
  ok(read("pages/governance-tracker/index.html").includes("js/app.js?v=1.46.0"), "govrel: app.js cache key bumped (1.46.0)");
}

// Batch 86 (2026-10-13 19:19): exact-parser DoS bound (Tier 2, white-hat
// track) — qtcToPlancksExact, the standardized exact decimal parser
// copied in the Fee Lab and Tokenomics, computed its scale unbounded:
// "1e100000000" made "0".repeat(scale) try to build a 100-million-digit
// string and hang the pane on every keystroke (both panes call the
// parser on `input` with the raw value), and a several-hundred-digit
// exponent overflowed parseInt to Infinity and threw in repeat().
// Both copies now refuse inputs over 512 chars and non-finite or
// |exp| > 1000 exponents with 0n — the parser's junk convention —
// far past JS-number forms (exp [-324, 308]) and the 20-digit supply.
{
  const fee = read("pages/fee-throughput-lab/app.js");
  const tok = read("pages/tokenomics/app.js");
  ok(fee.includes("if (s.length > 512) return 0n;"), "exactbound: fee parser refuses over-long inputs");
  ok(tok.includes("if (s.length > 512) return 0n;"), "exactbound: tokenomics parser refuses over-long inputs");
  ok(fee.includes("if (!isFinite(exp) || exp > 1000 || exp < -1000) return 0n;"), "exactbound: fee parser bounds the exponent");
  ok(tok.includes("if (!isFinite(exp) || exp > 1000 || exp < -1000) return 0n;"), "exactbound: tokenomics parser bounds the exponent");
  ok(fee.includes("var point = (m[2] || \"\").length - lead + exp; // digits left of the decimal point"), "exactbound: fee point uses the bounded exponent");
  ok(tok.includes("var point = (m[2] || \"\").length - lead + exp;"), "exactbound: tokenomics point uses the bounded exponent");
  ok(read("pages/fee-throughput-lab/index.html").includes("app.js?v=1.15.0"), "exactbound: fee app.js cache key bumped (1.15.0)");
  ok(read("pages/tokenomics/index.html").includes("app.js?v=1.12.0"), "exactbound: tokenomics app.js cache key bumped (1.11.0)");
}

// Batch 87 (2026-10-13 20:19): Distribution Planner total-supply cap —
// parseAmountToPlancks accepted ANY positive decimal: 21,000,000.000000000001
// (one planck over every QTC that will ever exist), 150M, even 10^21 QTC
// validated as clean plannable rows, got batch files + a run script, and
// would only fail on-chain — mid-run, after earlier batches had paid.
// The parser now refuses plancks > MAX_SUPPLY_PLANCKS (21M QTC, the same
// cap SafeSend enforces; exactly the cap stays valid), which also covers
// the per-batch tip path (same parser), and validateRows warns once, on
// the crossing row, when the plan's running total crosses the cap.
{
  const core = read("pages/distribution-planner/js/core.js");
  ok(core.includes('var MAX_SUPPLY_PLANCKS = BigInt("21000000") * PLANCKS_PER_QTC;'), "distsupply: supply cap constant defined from the 21M hard cap");
  ok(core.includes("if (plancks > MAX_SUPPLY_PLANCKS)"), "distsupply: parser refuses amounts over the cap");
  ok(core.includes("amount exceeds the total QTC supply cap of 21,000,000"), "distsupply: refusal names the supply cap");
  ok(core.includes("plan total through this line exceeds the total QTC supply of 21,000,000"), "distsupply: cumulative plan-total warning on the crossing row");
  ok(core.includes("MAX_SUPPLY_PLANCKS: MAX_SUPPLY_PLANCKS,"), "distsupply: cap exported for tests/callers");
  ok(read("pages/distribution-planner/index.html").includes("js/core.js?v=1.25.0"), "distsupply: core.js cache key bumped (1.23.0, superseded by 1.24.0)");
}

// Batch 88 (2026-10-13 21:19): signing-path supply-cap sweep — Batch 87
// capped the Distribution Planner's parser, and its run lesson said to grep
// EVERY money parser for the definitional bound in the same run. The
// signing fleet failed it: the identical vendored qtcToPlancks in the Web
// Wallet, Airgap Desk and Chain Console scale.js copies, and the Multisig
// Vault's qtcToPlancks, accepted 25,000,000 QTC — more than will ever
// exist. Airgap has NO balance check anywhere (cold side signs offline),
// so an extra-zero typo would be reviewed and signed as-is. All four
// parsers now refuse plancks > MAX_SUPPLY_PLANCKS (exactly the cap stays
// valid), the scale family throwing with the cap named, multisig keeping
// its null convention, and the multisig builder message naming the cap.
{
  const ww = read("pages/web-wallet/js/scale.js");
  const ag = read("pages/airgap-desk/js/lib/scale.js");
  const cc = read("pages/chain-console/js/lib/scale.js");
  for (const [name, src] of [["web-wallet", ww], ["airgap", ag], ["chain-console", cc]]) {
    ok(src.includes("export const MAX_SUPPLY_PLANCKS = 21000000n * PLANCKS_PER_QTC;"), `supplycap: ${name} scale defines the cap from the 21M hard cap`);
    ok(src.includes("if (plancks > MAX_SUPPLY_PLANCKS) throw new Error('amount exceeds the 21,000,000 QTC total supply"), `supplycap: ${name} parser refuses over-cap amounts naming the cap`);
  }
  const ms = read("pages/multisig-vault/js/msig-core.js");
  ok(ms.includes("var MAX_SUPPLY_PLANCKS = 21000000n * PLANCKS;"), "supplycap: multisig core defines the cap");
  ok(ms.includes("if (plancks > MAX_SUPPLY_PLANCKS) return null;"), "supplycap: multisig parser refuses over-cap amounts (null convention)");
  ok(read("pages/multisig-vault/js/app.js").includes("no larger than the 21,000,000 QTC total supply"), "supplycap: multisig builder message names the cap");
  ok(read("pages/web-wallet/index.html").includes("js/app.js?v=1.46.0"), "supplycap: web-wallet entry cache key bumped (1.45.0)");
  ok(read("pages/web-wallet/js/app.js").includes("from './scale.js?v=1.2.0'"), "supplycap: web-wallet app pins the bumped scale module (1.2.0)");
  ok(read("pages/web-wallet/js/rpc.js").includes("from './scale.js?v=1.2.0'"), "supplycap: web-wallet rpc pins the bumped scale module (1.2.0)");
  ok(read("pages/airgap-desk/index.html").includes("js/app.js?v=1.50.0"), "supplycap: airgap entry cache key bumped (1.49.0)");
  ok(read("pages/chain-console/index.html").includes("js/app.js?v=1.49.0"), "supplycap: chain-console entry cache key bumped (1.48.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/msig-core.js?v=1.30.0"), "supplycap: multisig core cache key bumped (1.27.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/app.js?v=1.28.0"), "supplycap: multisig app cache key bumped (1.27.0)");
}

// Batch 89 (2026-10-13 22:19): Network Dashboard daily relations round 3
// (Tier 2) — rounds 1-2 shape-checked each daily row and held order and
// active<=accounts, but the series' own relations were unchecked: a
// missing day passed (Oct 10 + Oct 8 painted as a consecutive series,
// and the activity chart spaces rows by index so the gap silently
// compressed time), and the newest row could be days stale — or after
// the capture — beside fresh status/blocks, while renderStats paints
// its tx_count as "txs in last 24h". Kept daily rows must now step by
// exactly one UTC day (a gap is payload-level poison, like the
// ascending break), and the newest row must sit in the capture's era
// (its UTC day or the day before, for the midnight-opening lag),
// anchored to fetchedMs so an honestly old snapshot still passes.
{
  const app = read("pages/network-dashboard/app.js");
  ok(app.includes("dateMs !== Date.parse(daily[daily.length - 1].date) - 86400000"), "netdash3: kept daily rows must be consecutive UTC days");
  ok(app.includes("if (newestDayMs < captureDayMs - 86400000 || newestDayMs > captureDayMs) return null;"), "netdash3: newest daily row must belong to the capture era");
  ok(app.includes("var captureDayMs = Math.floor(fetchedMs / 86400000) * 86400000;"), "netdash3: capture era anchored to fetchedMs, not view time");
  const html = read("pages/network-dashboard/index.html");
  ok(html.includes("app.js?v=1.12.0"), "netdash3: app.js cache key bumped for the round-3 fix");
}

// Batch 90 (2026-10-13 23:19): Vesting Desk last-claim relations round 4
// (Tier 2) — rounds 1-3 shape-checked each schedule and bound the
// capture time, but last_claim_at_ms held only the msStr 2000..2100
// shape: a stamp on a schedule that never claimed, a stamp before the
// cliff (vested is identically 0 before it, so no claim can have
// paid), or a stamp after the capture painted in the detail panel as
// claim history. The stamp now holds the producer relations — exists
// only when claimed > 0, >= cliff, <= the capture anchor + 60s skew
// (the Governance round-2 tolerance) — anchored to the payload's own
// capture on the snapshot path and load time on the live path, never
// view time; a violating stamp sanitizes to null (cosmetic field, the
// row is kept), and no date is ever fabricated for a missing stamp.
{
  const app = read("pages/vesting-desk/app.js");
  ok(app.includes("function validSchedule(raw, seenIds, anchorMs)"), "vesting4: validator takes the capture anchor");
  ok(app.includes("if (BigInt(claimed) === 0n || BigInt(last) < BigInt(cliff) || BigInt(last) > BigInt(anchor) + 60000n) last = null;"), "vesting4: last-claim relations enforced (claimed>0, >= cliff, <= anchor+60s)");
  ok(app.includes("validateSchedules(raw.schedules, Number(fetchedMs))"), "vesting4: snapshot path anchors to its own capture time");
  ok(app.includes("validateSchedules(rows.map((s) => ({") && app.includes("})), Number(nowMs));"), "vesting4: live path anchors to load time");
  const html = read("pages/vesting-desk/index.html");
  ok(html.includes("app.js?v=1.33.0"), "vesting4: app.js cache key bumped for the round-4 fix");
}

// Batch 91 (2026-10-14 00:19): Whale Watch move-list relations round 3
// (Tier 2) — rounds 1-2 shape-checked each move and held its time/amount
// contracts, but the lists' own producer relations were unchecked: a
// move could exceed the total supply (the genesis rows in the same
// function already held that bound); an exact duplicate painted twice
// (the producer query has no joins — each transfer arrives once); the
// tabs' printed order contracts were trusted, not held ("Largest
// all-time" renders in list order, "Recent" newest-first); a shuffled
// genesis list failed the round-2 pool identity, which reads row 0 as
// THE allocation recipient; and a list longer than the producer's
// 40-row cap painted as if it were producer data. Pin: moves drop over
// the supply bound, dedupe first-wins, orders are rebuilt from the
// survivors (alltime amount desc, recent timestamp desc, genesis
// amount desc), and an over-cap cleaned list fails the snapshot.
{
  const src = read("pages/whale-watch/app.js");
  ok(src.includes("if (supplyTotal !== null && BigInt(amount) > supplyTotal) return null;"), "whale3: a move cannot exceed the total supply");
  ok(src.includes("var MOVES_CAP = 40;"), "whale3: producer 40-row cap defined");
  ok(src.includes("if (seenMove[key]) return; // dedupe first-wins"), "whale3: exact duplicate moves dedupe first-wins");
  ok(src.includes("if (out.length > MOVES_CAP) return null;"), "whale3: an over-cap cleaned list fails the snapshot");
  ok(src.includes("genesis.sort(function(a, b){"), "whale3: genesis order rebuilt largest-first before the pool check");
  ok(src.includes("if (movesAll === null || movesRecent === null) return null; // round 3 cap"), "whale3: cap failure propagates to the snapshot verdict");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.25.0"), "whale3: app.js cache key bumped for the round-3 fix (superseded by the 1.24.0 round-4 bump)");
}

// Batch 92 (2026-10-14 01:19): Watchtower stamp era relations round 4
// (Tier 2) — rounds 1-3 era-held the blocks, transfers and alerts, but
// three stamps whose only producers stamp "now" held mere
// parseability: the watchlist addedAt (watch form + backup import both
// write new Date().toISOString()), the stored lastScan (scanNow stamps
// now; a 2999 stamp painted "Last scan: just now" forever), and the
// snapshots' fetched_at (a 2999 capture defeated the staleness badge).
// Pin: eraTs (the chainTimeMs window) gates all three; a violating
// stamp nulls — the row/scan state is kept, never a fabricated date.
{
  const core = read("pages/watchtower/js/watch-core.js");
  ok(core.includes("function eraTs(v)"), "watchtower4: eraTs() defined in watch-core");
  ok(core.includes("addedAt: eraTs(x.addedAt)"), "watchtower4: watchlist addedAt era-held, not merely parseable");
  const app = read("pages/watchtower/js/app.js");
  ok(app.includes("state.lastScan = QWATCH.eraTs(parsed.lastScan);"), "watchtower4: stored lastScan era-held at load");
  ok(app.includes("var fetchedAt = src ? QWATCH.eraTs(src.fetched_at) : null;"), "watchtower4: snapshot fetched_at era-held");
  ok(app.includes("govFetchedAt: bundle.gov ? QWATCH.eraTs(bundle.gov.fetched_at) : null,"), "watchtower4: governance fetched_at era-held");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/watch-core.js?v=1.36.0"), "watchtower4: watch-core cache key bumped for the round-4 fix");
  ok(html.includes("js/app.js?v=1.38.0"), "watchtower4: app.js cache key bumped for the round-4 fix");
}

// Batch 93 (2026-10-14 02:19): Flow Tracer producer-relations round 3
// (Tier 2) — rounds 1-2 shape-checked each row and held it against the
// snapshot's head/dust/capture, but a row's own identity and the block
// time it claims were unchecked: any string passed as an id or
// extrinsic_id, and two rows at one height could carry two different
// timestamps. Verified on the real snapshot (capture 221,996) before
// being held: every indexer id embeds its row's block height in its
// first segment (6,091/6,091), genesis-N ids sit only at block 1, every
// extrinsic_id is a bare hash or a hash suffixed with an own-id naming
// the same block (1 such row), and all non-null timestamps at one
// height are identical with block time never running backwards (0
// conflicts / 3,658 heights). RED first (probe 9/19, controls green)
// -> GREEN 19/19 incl. the real snapshot passing unchanged.
{
  const core = read("pages/flow-tracer/js/flow-core.js");
  ok(core.includes("function cleanExtrinsicId(v, height)"), "flowtracer3: cleanExtrinsicId() defined in flow-core");
  ok(core.includes("if (m[1] != null && Number(m[1]) !== height) return null;"), "flowtracer3: suffixed extrinsic id must name this row's block");
  ok(core.includes("if (m) return Number(m[1]) === r.block_height;"), "flowtracer3: indexer id segment must equal the row's block height");
  ok(core.includes("if (set.size > 1) badTime.add(h);"), "flowtracer3: a height with two different stamps has no agreed block time");
  ok(core.includes("if (ms < maxMs) badTime.add(h);"), "flowtracer3: block time never runs backwards as height grows");
  const html = read("pages/flow-tracer/index.html");
  ok(html.includes("js/flow-core.js?v=1.33.0"), "flowtracer3: flow-core.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "flowtracer3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "flowtracer3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "flowtracer3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "flowtracer3: lucklab sync patch-bump pin");
}

// Batch 94 (2026-10-14 03:19): Consensus Lab producer-recompute relations
// round 3 (Tier 2) — round 2 held the snapshot's tails and the block-time
// window's order-blind stats, but an interior recent point carried no
// relation at all: a difficulty inflated between two honest neighbours
// (tails still == current, stats still consistent) painted as consensus
// history, a +5s interior timestamp shift at a wide-gap index passed
// every shape check, and swapping two window entries passed because the
// stats summarize a SORTED copy. Verified on the real snapshot (capture
// 222,221) before being held: all 1,499 recent transitions recompute
// exactly via calculateDifficulty over their own timestamp deltas (block
// 2 uses the 12s target, mirroring fetch-consensus-data.mjs, which walks
// the indexed sequence so the recurrence holds across missing-height
// gaps too), and the window's last 1,499 entries ARE the recent series'
// own deltas (both windows end at the head transition). RED first (probe
// qa-consensus-round3 3 poisons accepted, relations green on the real
// snapshot) -> GREEN 5/5. Consensus unit tests 65 -> 68.
{
  const core = read("pages/consensus-lab/consensus-core.js");
  ok(core.includes("calculateDifficulty(prevD, delta).difficulty !== thisD"), "consensus3: every recent difficulty must be the exact retarget of its predecessor");
  ok(core.includes("const delta = rec[i][0] === 2 ? TARGET_MS"), "consensus3: block 2 retargets over the 12s target, mirroring the producer");
  ok(core.includes("const overlap = Math.min(last.length, rec.length - 1);"), "consensus3: window/recent overlap is bounded by both windows");
  ok(core.includes("if (last[last.length - overlap + k] !== rd) return false;"), "consensus3: the block-time window's tail must be the recent series' own deltas");
  const html = read("pages/consensus-lab/index.html");
  ok(html.includes("app.js?v=1.39.0"), "consensus3: app.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "consensus3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "consensus3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "consensus3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "consensus3: lucklab sync patch-bump pin");
}

// Batch 95 (2026-10-14 04:19): Reversal Desk lifecycle relations round 3
// (Tier 2) — rounds 1-2 shape-checked each list and held the totals, but
// the lists are ONE lifecycle and a scheduled row's money figures held
// no bound: a 100M QTC scheduled amount painted as chain fact (over the
// 21M hard cap), a terminal row timestamped BEFORE its own scheduled
// row painted as history, and a tx claiming both cancelled and executed
// painted in both queues. Verified on the real snapshot (capture
// 222,688) before being held: all 25 terminal rows whose tx also
// appears in the scheduled list are stamped at/after it (0 violations),
// cancelled ∩ executed is empty, and amounts sit far under the cap.
// Scheduled amount/fee now drop over MAX_SUPPLY_PLANCKS (exactly the
// cap stays valid); a predated terminal row drops (the scheduled fact
// stands); a tx in both terminal lists fails the snapshot. RED first
// (probe qa-reversal-round3: controls green, 5/5 poisons accepted) ->
// GREEN 8/8. Reversal unit tests 124 -> 131.
{
  const core = read("pages/reversal-desk/js/reversal-core.js");
  ok(core.includes("var MAX_SUPPLY_PLANCKS = 21000000n * 1000000000000n;"), "reversal3: the 21M hard cap is the scheduled-money bound");
  ok(core.includes("if (BigInt(r.amount) > MAX_SUPPLY_PLANCKS || BigInt(r.fee) > MAX_SUPPLY_PLANCKS) continue;"), "reversal3: over-cap amount or fee drops its scheduled row");
  ok(core.includes("return !(r.tx_id in schedMs) || Date.parse(r.timestamp) >= schedMs[r.tx_id];"), "reversal3: a terminal row may not predate its scheduled row");
  ok(core.includes("if (inExecuted[cancelled[ci].tx_id]) return null;"), "reversal3: one tx claiming both terminal states fails the snapshot");
  const html = read("pages/reversal-desk/index.html");
  ok(html.includes("js/reversal-core.js?v=1.55.0"), "reversal3: reversal-core.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "reversal3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "reversal3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "reversal3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "reversal3: lucklab sync patch-bump pin");
}

// Batch 96 (2026-10-14 05:19): Mining Observatory all-time relations
// round 4 (Tier 2) — rounds 1-3 shape-checked the all-time list and
// held its sum against chain height, but the list's producer cap and
// its relation to the window view were unchecked: a 101st row painted
// as producer data (fetch-miner-data.mjs emits the top 100 only), and
// an address credited with fewer all-time blocks than window blocks
// painted two contradictory verdicts from one capture (the window is
// a subset of all blocks; verified on the real snapshot, captures
// 222,688 and 222,930: 35 of 40 window miners appear in all_time, 0
// violations). Both now fail the snapshot wholesale. RED first (probe
// qa-minobs-round4: controls green, 2/2 poisons accepted) -> GREEN 8/8.
// Observatory unit tests 42 -> 46.
{
  const app = read("pages/mining-observatory/app.js");
  ok(app.includes("if (!Array.isArray(at) || !at.length || at.length > 100) bad(\"all_time\");"), "minobs4: the all-time list is held to the producer's top-100 cap");
  ok(app.includes("if (wm[r.address] !== undefined && n < wm[r.address])"), "minobs4: an all-time count below the same address's window count fails the snapshot");
  const html = read("pages/mining-observatory/index.html");
  ok(html.includes("app.js?v=1.20.0"), "minobs4: app.js cache key bumped for round 4");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "minobs4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "minobs4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "minobs4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "minobs4: lucklab sync patch-bump pin");
}

// Batch 97 (2026-10-14 06:19): Supply Audit aggregate-summand relations
// round 3 (Tier 2) — rounds 1-2 shape-checked every figure and held the
// cross-field relations, but balances.free is the indexer's SUM(free)
// over EVERY account and two of its own summands travel in the same
// payload unchecked: the vesting pool's free balance and the mint
// sentinel's. The pool (genesis row 0's recipient) and the sentinel
// (every genesis transfer's sender, never its own recipient) are two
// distinct accounts in that sum, so pool_free + sentinel_free <= free
// definitionally — a pool balance above the aggregate, or two balances
// each within it but summing past it, painted as audit evidence.
// Verified on the real snapshot (capture 223,172) before being held:
// pool + sentinel sit 356,416 QTC under the aggregate. RED first (probe
// qa-supply-round3: controls green, 3/3 poisons accepted) -> GREEN 6/6.
// Supply unit tests 87 -> 92.
{
  const core = read("pages/supply-audit/js/audit-core.js");
  ok(core.includes("pool + sentinel free balances exceed the balances.free aggregate"), "supply4: pool + sentinel free held against the balances.free aggregate they are summands of");
  ok(core.includes("var summands = BigInt(sentinelFree) + (poolFree !== null ? BigInt(poolFree) : 0n);"), "supply4: a null pool balance makes only the pool summand vacuous");
  const html = read("pages/supply-audit/index.html");
  ok(html.includes("js/audit-core.js?v=1.32.0"), "supply4: audit-core cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "supply4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "supply4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "supply4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "supply4: lucklab sync patch-bump pin");
}

// Batch 98 (2026-10-14 07:19): Exposure Lab money-figure relations
// round 3 (Tier 2) — rounds 1-2 shape-checked the BTC/ETH API payloads
// and held their count relations, but a BTC balance held no bound: a
// forged answer claiming 30M BTC on one address (more than will ever
// exist) painted as audit evidence and fed the USD at-risk figure.
// sanitizeBtcApi now refuses balance_sats over the 21M BTC hard cap
// (2.1e15 sats; exactly the cap stays valid). The same round fixes an
// evidence misstatement: analyzeETH rendered n_tx — ALL transactions,
// sends and receives (live BlockCypher: vitalik.eth n_tx 130,419 vs
// nonce 5,969 sends) — as "sent X in N transaction(s)"; the evidence
// now states the sent total with n_tx named as the combined count.
// Considered and dropped (verified live 2026-10-14): ETH sent <=
// received and balance <= received — BlockCypher's real answer for
// vitalik.eth has total_sent > total_received (internal flows and
// rewards are not in total_received), so neither is definitional.
// RED first (probe qa-exposure-round3: controls green, 4/4 poisons
// accepted/misstated) -> GREEN 9/9. Exposure unit tests 56 -> 58.
{
  const core = read("pages/exposure-lab/js/exposure-core.js");
  ok(core.includes("if (bal > 2100000000000000) return null;"), "exposure3: BTC balance held to the 21M hard cap in sats");
  ok(core.includes("sends and receives combined"), "exposure3: ETH sent evidence names n_tx as the combined count");
  const html = read("pages/exposure-lab/index.html");
  ok(html.includes("js/exposure-core.js?v=1.58.0"), "exposure3: exposure-core cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "exposure3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "exposure3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "exposure3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "exposure3: lucklab sync patch-bump pin");
}

// Batch 99 (2026-10-14 08:19): Exposure Lab exact-total recovery
// round 4 (Tier 2) — rounds 1-3 shape-checked and relation-held the
// BTC/ETH payloads, but the ETH PRIMARY path could never render for
// a real active address: BlockCypher writes total_sent /
// total_received / final_balance as plain integer literals of 20+
// digits, JSON.parse converts them to inexact floats past 2^53 wei
// (~0.009 ETH), and sanitizeEthApi rightly refuses floats — so every
// real verdict fell through to the Blockscout fallback, which knows
// THAT an address sent but never how much. Verified live 2026-10-14
// (vitalik.eth raw text: total_sent 87589693563485660527532 exact;
// JSON.parse renders it 8.758969356348566e+22). exposure-core gains
// extractTopLevelInts, a conservative depth-1 scanner that recovers
// exact digit strings from the raw response text: nested values and
// string contents are tokenized and skipped (a txref's ref_balance
// or a string embedding a fake key can never be picked up), only a
// plain integer literal recovers (decimal/exponent/string/duplicate
// keys mark the field inexact and the parsed path — which refuses
// floats — owns it), and malformed text yields null wholesale.
// fetchETH now reads the BlockCypher answer via fetchRawJSON (raw
// text + parsed body) and prefers recovered strings for the three
// totals; responses without .text() degrade to the pre-round-4
// parsed-only behavior. RED first (probe qa-exposure-round4:
// controls green incl. JSON.parse mangling the live total, extractor
// absent) -> GREEN 24/24. Exposure unit tests 58 -> 65.
{
  const core = read("pages/exposure-lab/js/exposure-core.js");
  const src = read("pages/exposure-lab/js/app.js");
  ok(core.includes("function extractTopLevelInts(text, keys)"), "exposure4: exact-integer extractor lives in the core");
  ok(core.includes("out[key] = seen[key] ? null : val.plain;"), "exposure4: a duplicated top-level key is inexact, never guessed");
  ok(src.includes("fetchRawJSON"), "exposure4: the BlockCypher answer is read as raw text + parsed body");
  ok(src.includes("C.extractTopLevelInts(raw.text,"), "exposure4: fetchETH recovers totals from the raw text");
  ok(src.includes('pick("total_sent", b.total_sent)'), "exposure4: recovered strings are preferred, parsed floats stay the fallback");
  const html = read("pages/exposure-lab/index.html");
  ok(html.includes("js/exposure-core.js?v=1.58.0"), "exposure4: exposure-core cache key bumped for round 4");
  ok(html.includes("js/app.js?v=1.55.0"), "exposure4: app.js cache key bumped for round 4");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "exposure4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "exposure4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "exposure4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "exposure4: lucklab sync patch-bump pin");
}

// Batch 100 (2026-10-14 09:19): Block Explorer producer identity
// relations round 3 (Tier 1) — rounds 1-2 shape-checked and
// relation-held the indexer payloads, but a row's own indexer id
// was never held against the block it claims: a transfer could
// carry any string id at any height, an extrinsic's block_id could
// name a different block than its block object, and the extrinsic
// view painted any event the answer contained (its query filtered
// by extrinsic_id but did not even select the field). Verified live
// 2026-10-14: transfer ids are <10-digit padded height>-<5 lower
// hex>-<6 digits> with the segment EQUAL to block_height (200/200
// sampled incl. genesis), block_id 0000223865-388d8 restates
// block.height 223865, and the extrinsic's events all restate the
// queried id. cleanTransferRow now drops non-producer or
// height-contradicting ids, cleanExtrinsic rejects a malformed or
// mismatched block_id, the extrinsic query selects extrinsic_id,
// and cleanExtrinsicEvents keeps only the queried extrinsic's
// events, deduped. RED first (probe qa-explorer-round3: controls
// green, 9/9 poisons accepted) -> GREEN 16/16. Explorer unit
// tests 27 -> 30.
{
  const src = read("pages/block-explorer/app.js");
  ok(src.includes("var TRANSFER_ID_RE = /^(\\d{10})-[0-9a-f]{5}-\\d{6}$/;"), "explorer3: transfer id producer grammar pinned");
  ok(src.includes("if (!idm || Number(idm[1]) !== height) return null;"), "explorer3: transfer id segment must restate block_height");
  ok(src.includes("function cleanExtrinsicEvents(rawList, xid)"), "explorer3: extrinsic events cleaner defined");
  ok(src.includes("if (e.extrinsic_id !== xid) return;"), "explorer3: foreign events drop from the extrinsic view");
  ok(src.includes("{ id type extrinsic_id }"), "explorer3: the events query selects the field it filters on");
  ok(src.includes("cleanExtrinsicEvents(d.ev, id)"), "explorer3: extrinsic view gates on cleanExtrinsicEvents");
  const html = read("pages/block-explorer/index.html");
  ok(html.includes("app.js?v=1.5.0"), "explorer3: app.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "explorer3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "explorer3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "explorer3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "explorer3: lucklab sync patch-bump pin");
}

// Batch 101 (2026-10-14 10:19): Extrinsic Lab SCALE bool
// discriminant round 3 (Tier 1) — rounds 1-2 validated the RPC
// answers and their relations, but the call decoder's own bool
// shape coerced any byte to a boolean: !!r.u8() painted byte
// 0x02/0x80/0xFF as a clean `true` keep_alive (Balances
// transfer_all/burn) or aye (Referenda vote). SCALE bool is a
// one-byte discriminant — parity-scale-codec decodes 0x00/0x01
// and errors on every other byte, and the runtime rejects such
// an extrinsic outright; every other discriminant in the same
// decoder (Option, MultiAddress, signature scheme, era) was
// already held to its producer set. decodeShape's bool case now
// throws 'bad bool encoding' for bv > 1. RED first (probe
// qa-extrinsiclab-discriminant: controls green, 6/6 poisons
// accepted) -> GREEN 10/10. Extrinsic unit tests 21 -> 24.
{
  const src = read("pages/extrinsic-lab/js/decode.js");
  ok(src.includes("if (bv > 1) throw new Error('bad bool encoding"), "extrinsic3: bool byte above 1 throws a bool error");
  ok(src.includes("v = bv === 1;"), "extrinsic3: bool value comes from the 0x01 byte only");
  ok(!src.includes("case 'bool': v = !!r.u8();"), "extrinsic3: truthiness coercion is gone");
  const html = read("pages/extrinsic-lab/index.html");
  ok(html.includes("js/decode.js?v=1.41.0"), "extrinsic3: decode.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "extrinsic3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "extrinsic3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "extrinsic3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "extrinsic3: lucklab sync patch-bump pin");
}

// Batch 102 (2026-10-14 11:19): Governance Tracker lifecycle +
// proposal-identity relations round 3 (Tier 2) — rounds 1-2 shape-
// checked each event and held its tallies/track, but the events of one
// referendum were never held to the lifecycle they form: a CONFIRMED
// stamped BEFORE the SUBMITTED painted the board Confirmed over a
// timeline that confirms a referendum before it exists, an event after
// a terminal painted after finality, and a TIMED_OUT coexisted with
// the DECISION_STARTED it by definition never had. All events also
// restate one proposal — a later event carrying a different preimage
// hash, size or upgrade flag painted in the same referendum's timeline.
// validateSnapshot now drops prerequisite-violating events first (a
// predated terminal ends nothing), then events after a surviving
// terminal, then identity flips (null hash/size = absence, kept).
// RED first (probe qa-governance-round3: controls green, 10 poisons
// accepted) -> GREEN 16/16. Governance unit tests 36 -> 42.
{
  const core = read("pages/governance-tracker/js/gov-core.js");
  ok(core.includes("var STAGE = { SUBMITTED: 0, DECISION_STARTED: 1, CONFIRM_STARTED: 2,"), "gov3: lifecycle stage ranks defined");
  ok(core.includes("if (os < stage && ot > t) return false;"), "gov3: events stamped before a prerequisite drop");
  ok(core.includes('r.type === "TIMED_OUT" && o.type === "DECISION_STARTED" && ot <= t'), "gov3: TIMED_OUT never coexists with DECISION_STARTED");
  ok(core.includes("if (STAGE[o.type] === 3 && Date.parse(o.timestamp) < t) return false;"), "gov3: events after a surviving terminal drop");
  ok(core.includes("r.proposal_preimage_hash !== idHash) return;"), "gov3: preimage-hash identity held per referendum");
  ok(core.includes("r.proposal_size_bytes !== idSize) return;"), "gov3: proposal-size identity held per referendum");
  ok(core.includes("r.is_runtime_upgrade !== idUpgrade) return;"), "gov3: upgrade-flag identity held per referendum");
  ok(core.includes("every claimed event violated its lifecycle"), "gov3: wholesale lifecycle failure fails the load honestly");
  const html = read("pages/governance-tracker/index.html");
  ok(html.includes("js/gov-core.js?v=1.25.0"), "gov3: gov-core cache key bumped for round 3");
  ok(html.includes("js/app.js?v=1.46.0"), "gov3: app.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "gov3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "gov3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "gov3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "gov3: lucklab sync patch-bump pin");
}

// Batch 103 (2026-10-14 12:19): Energy Observatory trend relations
// round 3 (Tier 2) — rounds 1-2 shape-checked each trend point and held
// the snapshot cross-checks, but the trend's own producer chain was
// unchecked: fetch-consensus-data.mjs samples the height-ordered block
// walk every 100 and pushes the head stamp last, yet a 2999 or 2020
// stamp, a shuffled/duplicate height, a backwards stamp, or a tail
// naming another block all painted as chain history (daily buckets and
// the history chart). cleanTrend now drops points breaking strict
// height/timestamp increase against the previous kept point or the
// chain-lifetime window, and deriveSnapshotState voids a trend whose
// cleaned tail is not [head, current.difficulty]. Verified on the real
// snapshot (capture 224,637) before being held: 2,248 points strictly
// monotonic, tail == head. RED first (probe qa-energy-round3: controls
// green, 9 poisons accepted) -> GREEN 11/11. Energy unit tests
// 127 -> 137 (the synthetic fixtures' pre-genesis 2025 stamps corrected
// to the era the heights belong to).
{
  const app = read("pages/energy-observatory/js/app.js");
  ok(app.includes('var TREND_FLOOR_MS = Date.parse("2026-09-01T00:00:00Z");'), "energy3: trend stamps held to the chain-lifetime floor");
  ok(app.includes("p[1] >= TREND_FLOOR_MS && p[1] <= Date.now() + 3600000"), "energy3: trend stamps held to the era window");
  ok(app.includes("if (prev && (h <= prev[0] || ts <= prev[1])) continue;"), "energy3: trend heights and stamps strictly increase against the previous kept point");
  ok(app.includes("out.trend[out.trend.length - 1][0] !== hh ||"), "energy3: trend tail must name the head block");
  ok(app.includes("out.trend[out.trend.length - 1][2] !== diff)) out.trend = [];"), "energy3: trend tail must carry the current difficulty, else the trend voids");
  const html = read("pages/energy-observatory/index.html");
  ok(html.includes("js/app.js?v=1.51.98"), "energy3: app.js cache key rolled for round 3 + sync");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "energy3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "energy3: pooldesk sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "energy3: lucklab sync patch-bump pin");
}

// Batch 104 (2026-10-14 13:19): Luck Lab recent-window tail relations
// round 3 (Tier 2) — rounds 1-2 held the window's INTERNAL shape
// (consecutive heights, strictly increasing stamps, plausible average)
// and the snapshot cross-checks, but the window was never held to the
// capture it claims to measure: fetch-consensus-data.mjs emits recent
// as the LAST <=1500 entries of the height-ordered block walk, so its
// tail IS the head block, yet a window ending 500 blocks early, a tail
// carrying another block's difficulty, or a window stamped in 2999 /
// before genesis (same spacing, same pace value) all painted as the
// current observed pace feeding blocks/day. deriveSnapshotState now
// accepts a pace only when recentTailAnchored holds: tail height ==
// head, tail difficulty == current difficulty, first stamp at/after
// the 2026-09-01 chain-lifetime floor, tail stamp at/before the
// capture + 60s producer skew. Only the pace falls — difficulty, head
// and reward anchor independently. Verified on the real snapshot
// (capture 224,878) before being held: 1,500 consecutive rows, tail ==
// [head, current difficulty]. RED first (probe qa-lucklab-round3:
// controls green, 5 poisons accepted) -> GREEN 9/9. Luck unit tests
// 82 -> 88 (tail-identity + era matrices; the synthetic fixtures'
// pre-genesis 2025 stamps corrected to the era their heights belong
// to, mirroring the Energy round-3 fixture correction).
{
  const app = read("pages/luck-lab/js/app.js");
  ok(app.includes("function recentTailAnchored(rec, headHeight, diffStr, fetchedMs)"), "luck3: recentTailAnchored() defined (the pace window's tail identity)");
  ok(app.includes("if (validHeight(last[0]) !== headHeight) return false;"), "luck3: window tail must name the head block");
  ok(app.includes("if (tailDiff == null || BigInt(tailDiff) !== BigInt(diffStr)) return false;"), "luck3: window tail must carry the current difficulty");
  ok(app.includes("if (fTs < RECENT_GENESIS_FLOOR_MS) return false;"), "luck3: window stamps held to the chain-lifetime floor");
  ok(app.includes("if (lTs > fetchedMs + RECENT_TAIL_SKEW_MS) return false;"), "luck3: window tail held to the capture time (+60s producer skew)");
  ok(app.includes("if (avg != null && recentTailAnchored(con.recent, hh, diff, Date.parse(consAt))) {"), "luck3: pace accepted only from a tail-anchored window");
  const html = read("pages/luck-lab/index.html");
  ok(html.includes("app.js?v=1.48.98"), "luck3: app.js cache key rolled for round 3 + sync");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "luck3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "luck3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "luck3: energy sync patch-bump pin");
}

// Batch 105 (2026-10-14 14:19): pace recompute relations round 3
// (Tier 2 sweep — mining-calculator, mining-studio, pool-desk) — rounds
// 1-2 held the pace's SHAPE (integer avg_ms in a sane band, sample >=
// 100 of the fetch script's up-to-3,000 blocks), but avg_ms was never
// held to the window it claims to summarize: fetch-consensus-data.mjs
// DEFINES avg_ms as Math.round(mean(last)) over its own delta array
// and sample as that array's length, so a tampered avg_ms of 2,000
// beside an honest 14,000 window painted 43,200 blocks/day (~7x the
// honest pace) in all three earnings tools reading the snapshot.
// Consensus Lab already recomputed exactly this; the three pace
// consumers now hold the same standard via paceAvgMs: last present,
// every delta a non-negative safe integer, sample === last.length,
// avg_ms === Math.round(mean(last)) — only the pace falls (each app
// keeps its dated static/target fallback and says so). Verified on
// the real snapshot (capture 225,164) before being held: sample
// 3,000 == last.length, avg 14,862 == round(mean(last)). RED first
// (probe qa-pace-recompute: controls green incl. the real snapshot,
// 27/27 poisons accepted across the three apps) -> GREEN 36/36.
// Unit tests: miningcalc 21 -> 22, mining-studio 99 -> 105,
// pool-desk 145 -> 152.
{
  const mc = read("pages/mining-calculator/app.js");
  ok(mc.includes("function paceAvgMs(bt){"), "pace3: miningcalc paceAvgMs() defined (the producer recompute)");
  ok(mc.includes("if (!Array.isArray(last) || last.length !== sample) return null;"), "pace3: miningcalc sample must equal the window length");
  ok(mc.includes("return Math.round(sum / last.length) === avg ? avg : null;"), "pace3: miningcalc avg must recompute from its window");
  ok(mc.includes("var avg = paceAvgMs(consensus.block_times_ms);"), "pace3: miningcalc pace accepted only via the recompute");
  const st = read("pages/mining-studio/app.js");
  ok(st.includes("function paceAvgMs(bt) {"), "pace3: studio paceAvgMs() defined (the producer recompute)");
  ok(st.includes("var avg = paceAvgMs(consensus.block_times_ms);"), "pace3: studio pace accepted only via the recompute");
  const pool = read("pages/pool-desk/js/app.js");
  ok(pool.includes("function paceAvgMs(bt) {"), "pace3: pooldesk paceAvgMs() defined (the producer recompute)");
  ok(pool.includes("var avgMs = consensus && consensus.block_times_ms ? paceAvgMs(consensus.block_times_ms) : null;"), "pace3: pooldesk pace accepted only via the recompute");
  ok(read("pages/mining-studio/index.html").includes("app.js?v=1.5.0"), "pace3: studio app.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "pace3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "pace3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "pace3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "pace3: lucklab sync patch-bump pin");
}

// Batch 106 (2026-10-14 15:19): Portfolio Desk mined-count +
// schedule relations round 3 (Tier 2) — rounds 1-2 shape-checked the
// counts and held the window/all_time overlap, but a count was never
// held to the chain it claims: a forged miners.json painted 9,999,999
// blocks mined on a 225k chain, and a duplicated vesting schedule row
// double-counted locked/claimable (producer ids are globally unique,
// verified 48/48). sanitizeMinedCounts now takes the snapshot's own
// bounds: each all_time <= chain_height, the kept all_time SUM <=
// chain_height (else the list is void, window floors stand), each
// window count <= window block_count — verified on the real snapshot
// (capture 225,165: all_time max 95,851, sum 225,021, window max
// 10,390 of 15,000). dedupeScheduleList holds schedule identity +
// the per-beneficiary supply cap in sanitizeSchedules AND the
// rollup. RED first (probe qa-portfolio-round3: controls 4/4 green,
// 7/7 poisons accepted) -> GREEN 11/11. Portfolio unit tests 19 -> 21.
{
  const core = read("pages/portfolio-desk/js/desk-core.js");
  ok(core.includes("function dedupeScheduleList(list)"), "portfolio3: dedupeScheduleList() defined in desk-core");
  ok(core.includes("if (total + t > MAX_SUPPLY_PLANCKS) return;"), "portfolio3: per-beneficiary schedule totals held to the supply cap");
  ok(core.includes("if (chainHeight === null || sum <= chainHeight)"), "portfolio3: all_time list void when its sum passes chain height");
  ok(core.includes("if (windowBlocks !== null && v > windowBlocks) return;"), "portfolio3: window counts held to the window's own block count");
  ok(core.includes("dedupeScheduleList(rawScheds.map(sanitizeSchedule).filter(Boolean))"), "portfolio3: the rollup dedupes schedules from any ctx producer");
  const app = read("pages/portfolio-desk/js/app.js");
  ok(app.includes("windowBlocks: miners.window && miners.window.block_count,"), "portfolio3: app passes the producer window bound at load");
  const html = read("pages/portfolio-desk/index.html");
  ok(html.includes("js/desk-core.js?v=1.36.0"), "portfolio3: desk-core.js cache key bumped for round 3");
  ok(html.includes("js/app.js?v=1.37.0"), "portfolio3: app.js cache key bumped for round 3");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "portfolio3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "portfolio3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "portfolio3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "portfolio3: lucklab sync patch-bump pin");
}

// Batch 107 (2026-10-14 16:19): Emission Lab base-cluster relations
// round 3 (Tier 2) — rounds 1-2 held the window's shape and its reward
// cluster spread (<= 0.03 QTC), but the producer's payout is "Total
// reward (base + fees)" (subsquid generated types), so fee-carrying
// blocks legitimately pay whole quanta above base (live 2026-10-14:
// 10/300 blocks at 0.32-0.42) and the round-2 anchor rejected the REAL
// snapshot (spread 0.08) — the page failed ~1/3 of windows. The anchor
// now derives R0 from the base cluster alone (payouts within 1 quantum
// of the window minimum; cluster must be the majority; fee blocks are
// counted and displayed, never anchoring), and holds the cluster R0 to
// the chain: R0 <= MINING_EMISSIONS + one quantum of bias, and implied
// minted past that tolerance <= height x the genesis-era reward.
// Verified on the real snapshot (capture 225,627: cluster 13/15, mean
// 0.30615, R0 15,307,692, feeBlocks 2). RED first (probe
// qa-emission-round3: live control + fee controls failed, 0.35/0.20
// poisons accepted) -> GREEN 9/9. Emission unit tests 18 -> 21.
{
  const src = read("pages/emission-lab/app.js");
  ok(src.includes("x <= rMin + LEAF_QUANTUM_QTC + 1e-9"), "emission3: base cluster = payouts within one quantum of the window minimum");
  ok(src.includes("cluster.length < Math.ceil(rewards.length / 2)"), "emission3: base cluster must be the majority of the window");
  ok(src.includes("R0 > MINING_EMISSIONS + R0_QUANTUM_TOLERANCE"), "emission3: R0 held to the mining emissions plus one quantum of bias");
  ok(src.includes("heights[0] * (MINING_EMISSIONS / EMISSION_DIVISOR)"), "emission3: implied minted held to height x genesis-era reward");
  ok(src.includes("feeBlocks: rewards.length - cluster.length"), "emission3: fee blocks counted on the anchor, excluded from its mean");
  ok(!src.includes("MAX_REWARD_SPREAD_QTC"), "emission3: the round-2 whole-window spread bound is gone (producer pays base + fees)");
  const html = read("pages/emission-lab/index.html");
  ok(html.includes("app.js?v=1.17.0"), "emission3: app.js cache key bumped for round 3 (1.17.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "emission3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "emission3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "emission3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "emission3: lucklab sync patch-bump pin");
}

// Batch 108 (2026-10-14 17:19): Vesting Desk aggregate containment
// round 5 (Tier 2) — rounds 1-4 held each schedule row alone (per-row
// total <= the whole genesis mint), but the SET was never held to the
// genesis it claims: individually-valid rows could sum past the 27%
// mint, a cohort could exceed its mainnet_vesting.rs allocation, and
// grant value could shift into the fully-vested liquidity cohort
// while every row passed. validateSchedules now sums the validated
// set and fails it WHOLESALE (empty -> honest unavailable state) when
// a cohort sum passes its genesis cap or the grand sum passes the
// mint. Verified on the real snapshot (48 schedules, cohort sums
// 5,417,940 / 42,000 / 210,000, grand sum 5,669,940 <= 5,670,000).
// RED first (probe qa-vesting-round5: controls green, 5/5 poisons
// accepted) -> GREEN 7/7. Vesting unit tests 35 -> 39.
{
  const src = read("pages/vesting-desk/app.js");
  ok(src.includes("const COHORT_CAPS = {"), "vesting5: cohort caps derived from the core genesis constants");
  ok(src.includes("if (sums[k] > COHORT_CAPS[k]) return [];"), "vesting5: a cohort sum over its genesis total fails the set wholesale");
  ok(src.includes("if (total > VC.GENESIS_MINT_QTC * Q) return [];"), "vesting5: a grand sum over the genesis mint fails the set wholesale");
  ok(src.includes("grant: VC.GRANT_TOTAL_QTC * Q, intents: VC.INTENTS_TOTAL_QTC * Q"), "vesting5: grant + intents caps pinned to the core constants");
  ok(src.includes("liquidity: VC.LIQUIDITY_TOTAL_QTC * Q"), "vesting5: liquidity cap pinned to the core constant");
  const html = read("pages/vesting-desk/index.html");
  ok(html.includes("app.js?v=1.33.0"), "vesting5: app.js cache key bumped for round 5 (1.33.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "vesting5: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "vesting5: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "vesting5: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "vesting5: lucklab sync patch-bump pin");
}

// Batch 109 (2026-10-14 18:19): Whale Watch genesis aggregate
// containment round 4 (Tier 2) — rounds 1-3 held each genesis row
// alone (amount <= the whole supply), but the producer emits at most
// 3 block-1 rows (limit:3 in fetch-whale-data.mjs) and their sum is
// part of the supply that exists: a 4th valid row, an exact duplicate,
// or a set summing past the whole supply all painted. validateSnapshot
// now dedupes genesis rows first-wins (the move-list precedent),
// fails the snapshot WHOLESALE past GENESIS_CAP rows, and fails it
// when the genesis sum passes the capture's supply total. Verified on
// the real snapshot (3 rows, sum 5,669,946 QTC <= supply). RED first
// (probe qa-whales-genesis-round4: controls green, 3/3 poisons
// accepted) -> GREEN 6/6. Whale unit tests 37 -> 40.
{
  const src = read("pages/whale-watch/app.js");
  ok(src.includes("var GENESIS_CAP = 3;"), "whale4: genesis producer cap pinned (limit:3)");
  ok(src.includes("if (genesis.length > GENESIS_CAP) return null;"), "whale4: a genesis list past the producer cap fails wholesale");
  ok(src.includes("if (genesisSum > supplyTotal) return null;"), "whale4: a genesis sum past the whole supply fails wholesale");
  ok(src.includes("if (seenGenesis[gkey]) return;"), "whale4: exact duplicate genesis rows dedupe first-wins");
  const html = read("pages/whale-watch/index.html");
  ok(html.includes("app.js?v=1.25.0"), "whale4: app.js cache key bumped for round 4 (1.24.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "whale4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "whale4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "whale4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "whale4: lucklab sync patch-bump pin");
}

// Batch 110 (2026-10-14 19:19): Network Dashboard daily aggregate
// containment round 4 (Tier 2) — rounds 1-3 shape-checked each daily
// row and held its order, consecutiveness and capture era, but a
// row's blocks_count held no bound against the chain it slices: the
// daily_chain_stats rows partition the chain by UTC day, so a single
// day claiming 200,001 blocks on a 200,000-block chain — or three
// days summing past it — painted the activity chart. sanitizeData
// now sums the kept daily blocks_counts and fails the payload
// wholesale past the status height. Verified on the real snapshot
// (capture 226,103: 14 rows, max 6,639, sum 83,453 <= height). RED
// first (probe qa-netdash-round4: controls green, 3/3 poisons
// accepted) -> GREEN 6/6. Dashboard unit tests 59 -> 62.
{
  const src = read("pages/network-dashboard/app.js");
  ok(src.includes("var dailyBlocksSum = 0;"), "netdash4: daily blocks sum computed over the kept rows");
  ok(src.includes("if (dailyBlocksSum > height) return null;"), "netdash4: a daily sum past the chain height fails the payload wholesale");
  ok(src.includes("daily.forEach(function(d){ dailyBlocksSum += d.blocks_count; });"), "netdash4: sum built from the validated daily rows");
  const html = read("pages/network-dashboard/index.html");
  ok(html.includes("app.js?v=1.12.0"), "netdash4: app.js cache key bumped for round 4 (1.12.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "netdash4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "netdash4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "netdash4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "netdash4: lucklab sync patch-bump pin");
}

// Batch 111 (2026-10-14 20:19): Watchtower governance-count relations
// round 5 (Tier 2) — rounds 1-4 era-held the tower's stamps and held
// its blocks/transfers, but sanitizeGovernance counted the governance
// payload's ROWS: the producer writes tech_referendum_event lifecycle
// rows (one referendum = many events), so the real snapshot's 4 events
// of referendum #0 painted "Referenda: 4" and armed the new_referendum
// baseline with the event count — a stage transition would fire a
// false "new referendum" alert. The count is now the distinct
// referendum_index set; any index-less/over-ceiling row makes the
// counts UNKNOWN (null) wholesale, and runtime_upgrade rows are held
// to their producer grammar (extrinsic-id form, block_id the id's
// prefix, chain-era stamp) with exact duplicates deduped. Verified on
// the real snapshot (4 events -> 1 referendum, 1 upgrade). RED first
// (probe qa-watchtower-govcount: controls green, 15 poisons accepted)
// -> GREEN 20/20. Watchtower unit tests 33 -> 36.
{
  const core = read("pages/watchtower/js/watch-core.js");
  ok(core.includes("var seenRef = {}, refs = 0;"), "watchtower5: referendum count built from the distinct index set");
  ok(core.includes("if (idx === null || idx > MAX_GOV_COUNT) return null;"), "watchtower5: an index-less or over-ceiling event row makes the counts unknown wholesale");
  ok(core.includes("var UPGRADE_ID_RE = /^\\d{10}-[0-9a-f]{5}-\\d{6}$/;"), "watchtower5: upgrade id held to the producer grammar");
  ok(core.includes("if (seenUp[u.id]) continue;"), "watchtower5: exact duplicate upgrade ids dedupe first-wins");
  const html = read("pages/watchtower/index.html");
  ok(html.includes("js/watch-core.js?v=1.36.0"), "watchtower5: watch-core.js cache key bumped for round 5 (1.35.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "watchtower5: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "watchtower5: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "watchtower5: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "watchtower5: lucklab sync patch-bump pin");
}

// Batch 112 (2026-10-14 21:19): Node Desk command-builder injection +
// sync/snapshot relations round 2 (Tier 2, white-hat track) — the
// builder's other ports were validatePortNumber-held and its file
// paths shq-quoted, but the miner metrics port was String()-
// interpolated RAW into a command operators copy and run ("9900;
// curl …|sh", "9900 --cuda-gpu", "$(id)" landed verbatim), the worker
// counts went through Math.floor (prose painted "--cpu-workers NaN",
// a negative silently became 1), syncProgress Number()-coerced its
// heights (fractional heights painted, a local head ABOVE the network
// head painted "synced"), and parseSnapshot's head held no fleet
// ceiling (999,999,999,999 painted as the network head). Counts and
// the metrics port are now validated like every other port (an
// invalid miner option blocks both commands); heights are integer/
// digit-string grammar under MAX_CHAIN_HEIGHT with local <= network
// or no measurement; the snapshot head is ceiling-held. RED first
// (probe qa-nodedesk-round2: controls 7/7 green, 21/21 poisons
// accepted) -> GREEN 28/28. Node unit tests 100 -> 126.
{
  const core = read("pages/node-desk/node-core.js");
  ok(core.includes('const xp = validatePortNumber(m.metricsPort, "Miner metrics port");'), "nodedesk2: miner metrics port held to the same port validation as every other port");
  ok(core.includes("if (!xp.ok) errors.push(xp.error); else mc.push(\"--metrics-port\", String(xp.value));"), "nodedesk2: only the validated metrics port value is interpolated");
  ok(!core.includes("String(m.metricsPort)"), "nodedesk2: no raw metrics-port interpolation remains");
  ok(core.includes("if (!Number.isSafeInteger(n) || n < 1) { errors.push(`${label}: must be a positive integer`); return null; }"), "nodedesk2: worker counts are positive integers or an error (no NaN, no silent clamp)");
  ok(!core.includes("Math.floor(m.cpuWorkers)"), "nodedesk2: no floored-coercion count remains");
  ok(core.includes("export const MAX_CHAIN_HEIGHT = 10000000;"), "nodedesk2: fleet height ceiling exported");
  ok(core.includes("if (l === null || n === null || n <= 0 || l > n) return null;"), "nodedesk2: a local head above the network head is no measurement, never 'synced'");
  ok(core.includes("S.head <= MAX_CHAIN_HEIGHT"), "nodedesk2: snapshot head held to the fleet ceiling");
  const html = read("pages/node-desk/index.html");
  ok(html.includes("app.js?v=1.42.0"), "nodedesk2: app.js cache key bumped for round 2 (1.42.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "nodedesk2: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "nodedesk2: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "nodedesk2: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "nodedesk2: lucklab sync patch-bump pin");
}

// Batch 113 (2026-10-14 22:19): Ledger Desk internal-inflow relation
// (Tier 1) — the cost-basis engine honored the internal flag only on
// OUTFLOWS ("neither disposal nor acquisition"), but the scan's
// both-mine detection emits exactly ONE event for a transfer between
// two vault addresses: a transfer_in flagged internal. The inflow
// branch booked it as a fresh zero-basis lot, so inventory doubled,
// a "review basis" warning fired for the user's own move, and a
// later sale matched the phantom lot at $0 basis — booking the full
// proceeds as a gain that never happened, with no shortfall raised.
// The inflow branch now honors internal exactly like the outflow
// branch. RED first (probe qa-ledgerdesk-internal: controls 4/4
// green, 7 poison checks accepted) -> GREEN 11/11. Ledger unit
// tests 43 -> 45.
{
  const core = read("pages/ledger-desk/ledger-core.js");
  ok(core.includes("if (ev.internal) return;\n      var unitCost = null"), "ledger4: an internal inflow is neither an acquisition nor income (no phantom lot)");
  ok(core.includes("minted a phantom zero-basis lot here"), "ledger4: the phantom-lot relation is documented at the gate");
  const html = read("pages/ledger-desk/index.html");
  ok(html.includes("ledger-core.js?v=1.7.0"), "ledger4: ledger-core.js cache key bumped for the internal-inflow fix (1.4.0, superseded by the 1.5.0 csv-formula bump)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "ledger4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "ledger4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "ledger4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "ledger4: lucklab sync patch-bump pin");
}

// Batch 114 (2026-10-14 23:19): Web Wallet activity height-era
// relations round 3 (Tier 1) — round 2 held an activity row's
// timestamp only against the calendar (genesis floor, now+1h), so a
// transfer at block 1 dated today, or at height 203,723 dated the
// chain's first week, painted as this wallet's history at a time that
// block never existed; and a higher block carrying an earlier
// timestamp than a lower block below it painted under "Recent
// transfers". A timestamp is now held to the era its height can
// occupy (genesis 2026-09-09; sustained average block interval in
// [6s, 30s] ± 1 day — a gross band; the observed average is ~14.3s)
// and kept timestamps must not run backwards against the height
// order, else the payload is malformed wholesale. RED first (probe
// qa-wallet-activity-era: controls 5/5 green, 5/5 poisons accepted)
// -> GREEN 10/10. Wallet unit tests 56 -> 58.
{
  const val = read("pages/web-wallet/js/rpc-validate.js");
  ok(val.includes("export const CHAIN_GENESIS_MS = Date.UTC(2026, 8, 9);"), "wallet3: the height-era gate anchors at the fleet-verified genesis (2026-09-09)");
  ok(val.includes("function timestampFitsHeight(t, height)"), "wallet3: a timestamp is held to the era its block height can occupy");
  ok(val.includes("activityTimestampOk(t.timestamp, nowMs, height)"), "wallet3: the sanitizer passes each row's height into its timestamp gate");
  ok(val.includes("if (lastTs !== null && t > lastTs) return null;"), "wallet3: kept timestamps must not contradict the newest-first height order");
  const rpc = read("pages/web-wallet/js/rpc.js");
  ok(rpc.includes("rpc-validate.js?v=1.2.0"), "wallet3: rpc.js pins the round-3 rpc-validate module");
  const app = read("pages/web-wallet/js/app.js");
  ok(app.includes("from './rpc-validate.js?v=1.2.0'"), "wallet3: app.js imports the sanitizer from the round-3 module");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "wallet3: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "wallet3: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "wallet3: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "wallet3: lucklab sync patch-bump pin");
}

// Batch 115 (2026-10-15 00:19): Distribution Planner comma-amount
// field-splitting relation (Tier 2 money tool) — parseAmountToPlancks
// accepts comma thousand separators ("1,000.25" is a pinned grammar),
// but parseInput cut every line at EVERY comma: a CSV row
// "addr,1,500" planned 1 QTC instead of 1,500 (the ",500" field was
// silently dropped and the row validated OK), a spaced/tabbed
// "addr 1,500" glued the fragment onto the address and failed with a
// base58 error, and extra fields ("addr 10 extra") were silently
// ignored. The splitter now splits a field-separating comma at the
// FIRST comma only (the remainder is the amount, commas and all) and
// extra whitespace-separated fields are an explicit error row. RED
// first (probe qa-distribution-comma: controls 5/5 green, 6/6 poisons
// accepted) -> GREEN 12/12. Distribution unit tests 24 -> 26.
{
  const core = read("pages/distribution-planner/js/core.js");
  ok(core.includes("parts = [csv[1], csv[2].trim()]"), "distcomma: a field-separating comma splits at the first comma only, the remainder is the whole amount");
  ok(core.includes("the WHOLE amount token to it in every separator form"), "distcomma: the splitter/parser amount relation is documented at the gate");
  ok(core.includes("if (parts.length !== 2) {"), "distcomma: extra fields are an explicit error row, never a silent drop");
  ok(!core.includes('line.split(",")'), "distcomma: no every-comma split remains");
  const html = read("pages/distribution-planner/index.html");
  ok(html.includes("js/core.js?v=1.25.0"), "distcomma: core.js cache key bumped for the comma-amount fix (1.24.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "distcomma: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "distcomma: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "distcomma: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "distcomma: lucklab sync patch-bump pin");
}

// Batch 116 (2026-10-15 01:19): Block Explorer block-id identity
// relation round 4 (Tier 1) — rounds 1-3 held transfer ids and
// extrinsic block_ids to the producer grammar, but cleanBlock never
// looked at the block row's OWN indexer id, even though qBlock
// selects it: a block answer whose id named a different block (or no
// producer form at all) painted as the requested block. When present,
// the id must be <10-digit height>-<5 lowercase hex> with the segment
// restating the block's height (verified live 2026-10-15: head
// 0000227858-c315a @ 227,858; genesis 0000000001-cb81a @ 1); absent
// keeps the old path (home rows carry no id). RED first (probe
// qa-explorer-blockid: controls 3/3 green, 7/7 poisons accepted) ->
// GREEN 10/10. Explorer unit tests 30 -> 31.
{
  const src = read("pages/block-explorer/app.js");
  ok(src.includes("if (raw.id !== null && raw.id !== undefined){"), "explorer4: the block row's own id is gated when present");
  ok(src.includes("BLOCK_ID_RE.exec(raw.id)"), "explorer4: the block id must take the producer block-id form");
  ok(src.includes("Number(bidm[1]) !== base.height"), "explorer4: the block id's height segment must restate the block's height");
  ok(src.includes("the block row's own producer identity"), "explorer4: the block-identity relation is documented at the gate");
  const html = read("pages/block-explorer/index.html");
  ok(html.includes("app.js?v=1.5.0"), "explorer4: app.js cache key bumped for the round-4 fix (1.5.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "explorer4: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "explorer4: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "explorer4: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "explorer4: lucklab sync patch-bump pin");
}

// Batch 117 (2026-10-15 02:19): Dev Hub JSON-RPC curl shell-quote
// injection (white-hat track) — buildJsonRpc wrapped the compact JSON
// payload in single quotes for the copy-paste curl command but never
// escaped single quotes inside user params, so a storage-key param
// carrying ' broke out of the -d quoting and the rest ran as shell
// commands ('; echo …; ' executed; a lone ' broke the command). The
// payload now goes through the fleet shellQuote standard (CLI Forge /
// Distribution Planner): every ' is written as '\'' so the payload
// reaches curl byte-identical and nothing else runs. Verified by
// executing the generated line in bash with curl stubbed (probe
// qa-devhub-curlquote: controls 4/4 green, 5 poisons accepted ->
// GREEN 13/13). Dev Hub unit tests 15 -> 17.
{
  const src = read("pages/dev-hub/app.js");
  ok(src.includes("function shellQuote(s){"), "devhub: the curl builder carries the fleet shellQuote");
  ok(src.includes("String(s).replace(/'/g, \"'\\\\''\")"), "devhub: shellQuote writes each embedded quote as '\\''");
  ok(src.includes("shellQuote(JSON.stringify({ jsonrpc: \"2.0\", id: 1, method: method, params: params }))"), "devhub: the -d payload is shell-quoted, never raw-interpolated");
  ok(src.includes("The curl command below is copy-paste code"), "devhub: the injection relation is documented at the gate");
  ok(!src.includes("\"curl -s -H 'Content-Type: application/json' -d '\" +"), "devhub: no raw single-quote -d interpolation remains");
  const html = read("pages/dev-hub/index.html");
  ok(html.includes("app.js?v=1.43.0"), "devhub: app.js cache key bumped for the shell-quote fix (1.43.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "devhub: miningcalc sync patch-bump pin");
  ok(read("pages/pool-desk/index.html").includes("app.js?v=1.48.98"), "devhub: pooldesk sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "devhub: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "devhub: lucklab sync patch-bump pin");
}

// Batch 118 (2026-10-15 03:19): Pool Desk command-builder validation
// gate (Tier 2, white-hat track) — buildCommand interpolated the payout
// address and worker RAW into copy-paste mining commands while the
// validators were display-only: render() showed the warning and still
// built (and offered for copy) a runnable command, so an "address"
// carrying '; … ;#' or a worker carrying '$()' executed on paste
// (probe qa-pooldesk-cmdgate: controls 6/6 green, all poisons accepted
// incl. two executed marker injections). The builder now enforces the
// validators itself: a hard-invalid address (empty / non-qz / outside
// Base58) or an invalid worker builds NO command in any branch; the
// soft length warning stays a warning (pure Base58 is shell-safe and
// pinned fixtures rely on it). validateWorker also requires an
// alphanumeric first character — '--gpu-devices' matched the old
// charset and would have ridden after --worker as a smuggled flag.
// Pool Desk unit tests 152 -> 162.
{
  const src = read("pages/pool-desk/js/app.js");
  ok(src.includes("if (!va.ok && !va.soft) return { ok: false, msg: va.msg };"), "pooldesk-gate: builder refuses a hard-invalid address (soft length stays a warning)");
  ok(src.includes("if (!vw.ok) return { ok: false, msg: vw.msg };"), "pooldesk-gate: builder refuses an invalid worker");
  ok(src.includes("The command built below is copy-paste code"), "pooldesk-gate: the injection relation is documented at the gate");
  ok(src.includes("/^[a-z0-9][a-z0-9.\\-_]{0,31}$/"), "pooldesk-gate: worker grammar requires an alphanumeric first character (no flag smuggle)");
  const html = read("pages/pool-desk/index.html");
  ok(html.includes("js/app.js?v=1.48.98"), "pooldesk-gate: app.js cache key bumped for the gate fix (sync roll .73 -> .74)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "pooldesk-gate: miningcalc sync patch-bump pin");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "pooldesk-gate: energy sync patch-bump pin");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "pooldesk-gate: lucklab sync patch-bump pin");
}

// Batch 119 (2026-10-15 04:19): Tokenomics fmtQTC rounding carry —
// the formatter rounded the fraction independently of the floored
// integer part, so a fraction rounding up to a whole unit never
// carried: 1.999 painted "1.00", 5.995 "5.00", 999999.9999
// "999,999.00"; negatives were malformed outright (-1.5 -> "-2..50":
// floor steps down while % keeps the sign and the sliced fraction
// kept its own minus), and digits=0 painted "9." for 9.9. fmtQTC
// now rounds on the magnitude with an explicit carry and re-applies
// the sign. Tokenomics unit tests 29 -> 31. Sync roll .74 -> .75.
{
  const src = read("pages/tokenomics/app.js");
  ok(src.includes("if (frac >= pow){ whole += 1; frac = 0; }"), "fmtqtc: a fraction rounding up to a whole unit carries into the integer part");
  ok(src.includes('var sign = n < 0 ? "-" : "";'), "fmtqtc: sign is applied once, after rounding the magnitude");
  ok(src.includes("var mag = Math.abs(n);"), "fmtqtc: rounding works on the magnitude (no floor/% sign split)");
  ok(read("pages/tokenomics/index.html").includes("app.js?v=1.12.0"), "fmtqtc: tokenomics app.js cache key bumped (1.12.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "fmtqtc: miningcalc sync patch-bump pin (.75)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "fmtqtc: pool-desk sync patch-bump pin (.75)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "fmtqtc: energy sync patch-bump pin (.75)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "fmtqtc: lucklab sync patch-bump pin (.75)");
}

// Batch 120 (2026-10-15 05:19): CSV spreadsheet formula injection
// (white-hat track) — every CSV exporter in the fleet quoted its cells
// but never guarded the value inside them: a parsed cell beginning
// (after spaces/tabs) with =, +, - or @ is EVALUATED as a formula/DDE
// by Excel/Sheets when the file opens, and quoting is file syntax that
// is stripped before the value reaches the cell. The free-text cells
// were the poison paths: Ledger Desk eventsToCsv carried id/source/
// ref/note (all reachable from a shared ledger file or a CSV import),
// Pay Desk's register export carried the invoice reference, and
// Portfolio Desk's csvExport carried the address nickname (importable
// via a shared vault JSON) — "quoted" with JSON.stringify, which is
// not CSV quoting at all and mangled nicks carrying quotes/commas
// (probe qa-csvformula: controls green, 19 poisons accepted + 1
// quoting corruption). All three exporters now guard text cells with
// a leading single quote (spreadsheet apps render the text without
// it and never evaluate it); producer numeric cells are untouched so
// figures stay numbers. Ledger's importer applies the exact inverse
// (csvUnguardText) so its exports still round-trip byte-identically
// and the id/ref dedupe keeps matching. Ledger tests 45 -> 47, Pay
// Desk 141 -> 151, Portfolio 21 -> 22.
{
  const core = read("pages/ledger-desk/ledger-core.js");
  ok(core.includes("function csvGuardText(s)"), "csvformula: ledger-core defines the formula guard");
  ok(core.includes("function csvUnguardText(s)"), "csvformula: ledger-core defines the import inverse");
  ok(core.includes("csvGuardText(e.source), csvGuardText(e.ref)"), "csvformula: ledger export guards source and ref");
  ok(core.includes("csvGuardText((e.note || \"\")"), "csvformula: ledger export guards the note");
  ok(core.includes("csvGuardText: csvGuardText, csvUnguardText: csvUnguardText"), "csvformula: ledger guard pair is exported for tests/import");
  const lapp = read("pages/ledger-desk/app.js");
  ok(lapp.includes("L.csvUnguardText(String(r[idx(\"id\")] || \"\").trim())"), "csvformula: ledger import unguards the id dedupe key");
  ok(lapp.includes("L.csvUnguardText(String(r[idx(\"ref\")] || \"\").trim())"), "csvformula: ledger import unguards the ref dedupe key");
  const lhtml = read("pages/ledger-desk/index.html");
  ok(lhtml.includes("ledger-core.js?v=1.7.0"), "csvformula: ledger-core cache key bumped (1.5.0)");
  ok(lhtml.includes("app.js?v=1.10.0"), "csvformula: ledger app.js cache key bumped (1.8.0)");
  const pay = read("pages/pay-desk/js/app.js");
  ok(pay.includes("function csvGuardText(s)"), "csvformula: pay desk defines the formula guard");
  ok(pay.includes("var s = csvGuardText(String(v));"), "csvformula: pay csvEscape guards before quoting");
  ok(read("pages/pay-desk/index.html").includes("js/app.js?v=1.51.0"), "csvformula: pay app.js cache key bumped (1.50.0)");
  const pcore = read("pages/portfolio-desk/js/desk-core.js");
  ok(pcore.includes("function csvTextCell(s)"), "csvformula: portfolio defines a real CSV text cell");
  ok(pcore.includes("csvTextCell(r.nick || \"\")"), "csvformula: portfolio nickname goes through the guarded CSV cell");
  ok(!pcore.includes("JSON.stringify(r.nick || \"\")"), "csvformula: portfolio no longer JSON-quotes the nickname");
  ok(read("pages/portfolio-desk/index.html").includes("js/desk-core.js?v=1.36.0"), "csvformula: portfolio desk-core cache key bumped (1.36.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "csvformula: miningcalc sync patch-bump pin (.75)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "csvformula: pool-desk sync patch-bump pin (.75)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "csvformula: energy sync patch-bump pin (.75)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "csvformula: lucklab sync patch-bump pin (.75)");
}

// Batch 121 (2026-10-15 06:19): Supply Audit fmtQtc decimals contract +
// signed deltas (Tier 2) — fmtQtc appended "." + frac unconditionally,
// so dec=0 (the supply-curve canvas labels, called on every load)
// painted "5,818,356." with a bare trailing dot, and out-of-contract
// dec values (negative, NaN) sliced the fraction away to the same bare
// dot. dec is now floored and clamped to 0..12 (non-finite falls back
// to the default 4) and dec=0 omits the dot. The renderers also
// hard-prefixed "+" on the gap and fee wedge — differences of
// independent aggregates with no sanitize relation forcing them
// positive — so a negative delta painted "+-1,000.0000"; both now go
// through fmtSignedQtc, whose sign comes from the value (probe
// qa-supply-fmtqtc: controls 6/6 green, 10 poisons accepted incl. a
// sanitized negative gap of -100,000.6100 QTC -> GREEN 24/24).
// Supply unit tests 93 -> 105.
{
  const core = read("pages/supply-audit/js/audit-core.js");
  ok(core.includes("dec = Math.max(0, Math.min(12, Math.floor(dec)));"), "supplyfmt: fmtQtc floors and clamps dec to 0..12");
  ok(core.includes('return (neg ? "-" : "") + int + (dec > 0 ? "." + frac : "");'), "supplyfmt: dec=0 omits the dot");
  ok(core.includes("function fmtSignedQtc(p, dec)"), "supplyfmt: signed delta formatter defined");
  ok(core.includes("fmtQtc: fmtQtc, fmtSignedQtc: fmtSignedQtc"), "supplyfmt: signed formatter exported");
  const app = read("pages/supply-audit/app.js");
  ok(!app.includes('"+" + A.fmtQtc(a.gap)'), "supplyfmt: no hard-coded plus on the gap");
  ok(!app.includes('"+" + A.fmtQtc(a.feeWedge)'), "supplyfmt: no hard-coded plus on the fee wedge");
  ok(app.includes("A.fmtSignedQtc(a.gap)"), "supplyfmt: gap painted signed");
  ok(app.includes("A.fmtSignedQtc(a.feeWedge)"), "supplyfmt: fee wedge painted signed");
  const html = read("pages/supply-audit/index.html");
  ok(html.includes("js/audit-core.js?v=1.32.0"), "supplyfmt: audit-core cache key bumped (1.32.0)");
  ok(html.includes("app.js?v=1.33.0"), "supplyfmt: app.js cache key bumped (1.33.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "supplyfmt: miningcalc sync patch-bump pin (.77)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "supplyfmt: pool-desk sync patch-bump pin (.77)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "supplyfmt: energy sync patch-bump pin (.77)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "supplyfmt: lucklab sync patch-bump pin (.77)");
}

// Batch 122 (2026-10-15 07:19): CLI Forge global camera-index validation
// gate (white-hat track) — GLOBALS declares cameraIndex as kind "uint"
// u:32 and the command-level camera-index field is held to isValidUint,
// but buildCommand parseInt-coerced the GLOBAL straight into the
// command: "abc" painted --camera-index NaN, "-1" and 2^32 emitted a
// u32 flag the CLI rejects, and "2.9" / "1; anything" were silently
// truncated to their integer prefix — a copied command naming a camera
// the user never chose, with problems empty so the Copy / Download .sh
// gates (which read problems only) stayed open. The builder now
// enforces the uint grammar itself: invalid -> a cameraIndex problem
// and NO flag emitted; valid values emit canonically via BigInt
// ("007" -> 7, as parseInt did) (probe qa-cliforge-cameragate:
// controls 7/7 green, 20 poison checks accepted -> GREEN 27/27).
// CLI Forge unit tests 117 -> 131.
{
  const app = read("pages/cli-forge/js/app.js");
  ok(app.includes('if (isValidUint(camRaw, 32)) parts.push("--camera-index", BigInt(camRaw).toString());'), "cliforge-cam: builder enforces the u32 grammar on the global camera index");
  ok(app.includes('problems.push({ field: "cameraIndex", msg: "unsigned integer, 0 – 2^32−1" })'), "cliforge-cam: invalid camera index is a blocking problem");
  ok(!app.includes("parseInt(globals.cameraIndex"), "cliforge-cam: no parseInt coercion of the global camera index");
  const html = read("pages/cli-forge/index.html");
  ok(html.includes("js/app.js?v=1.46.0"), "cliforge-cam: app.js cache key bumped (1.46.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "cliforge-cam: miningcalc sync patch-bump pin (.78)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "cliforge-cam: pool-desk sync patch-bump pin (.78)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "cliforge-cam: energy sync patch-bump pin (.78)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "cliforge-cam: lucklab sync patch-bump pin (.78)");
}

// Batch 123 (2026-10-15 08:19): ZKTree Desk proof bounds (white-hat
// track) — decodeMerkleProofRpc trusted the level count in a response
// from a user-supplied node endpoint: a 14-byte body declaring
// 2,000,000 levels looped ~5.5s building empty triples (slices past
// the end) before the trailing-bytes check fired, 33 levels decoded
// happily though the pallet caps depth at MAX_TREE_DEPTH 32, and a
// truncated leaf_index died as a BigInt(undefined) TypeError.
// verifyProof folded pasted JSON with no shape gate at all: a
// 2,000-level proof burned ~4.1s of Poseidon before answering false,
// and a 1-byte sibling zero-padded into its 32-byte hash slot. Both
// entry points now hold the producer grammar BEFORE looping/hashing:
// levels <= 32, the exact byte budget (levels*96 + root + depth),
// per-level arity ARITY-1, 32-byte siblings; decodeCompact refuses
// reads past the end (probe qa-zktree-proofbounds: controls 3/3
// green, 7 poison checks failed -> GREEN 11/11). ZKTree unit tests
// 83 -> 93.
{
  const core = read("pages/zktree-desk/js/zktree-core.js");
  ok(core.includes("if (levels > BigInt(MAX_TREE_DEPTH))"), "zkbounds: RPC level count held to the chain max depth before the loop");
  ok(core.includes("truncated proof response: \" + levelsNum + \" levels need "), "zkbounds: RPC body byte-budgeted against its declared levels");
  ok(core.includes("if (b.length < 9) throw new Error(\"truncated proof response: missing leaf_index\")"), "zkbounds: truncated leaf_index is a clean decode error");
  ok(core.includes("throw new Error(\"truncated compact integer\")"), "zkbounds: compact reads past the end refused");
  ok(core.includes("malformed proof: \" + proof.siblings.length + \" levels exceeds the chain max depth "), "zkbounds: pasted proofs held to the chain max depth before hashing");
  ok(core.includes("sibling at level \" + li + \" must be 32 bytes"), "zkbounds: siblings held to Hash256 width");
  ok(read("pages/zktree-desk/index.html").includes("js/app.js?v=1.51.0"), "zkbounds: zktree entry cache key bumped (1.50.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "zkbounds: miningcalc sync patch-bump pin (.79)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "zkbounds: pool-desk sync patch-bump pin (.79)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "zkbounds: energy sync patch-bump pin (.79)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "zkbounds: lucklab sync patch-bump pin (.79)");
}

// Batch 124 (2026-10-15 09:19): SS58 input-length bound fleet sweep
// (white-hat track) — every fleet base58 decoder is quadratic in the
// input length (each character rescans the accumulated byte array; the
// quantus-crypto family rescales a growing BigInt instead), and none
// held a length gate before that loop: ss58Decode('z'.repeat(20000))
// took 1.3–5.2s per decoder and a 100k paste is a ~minute tab freeze
// in SafeSend / Web Wallet / Key Forge address fields, which
// re-validate on input. Producer grammar: a Quantus address is 49
// characters, the largest SS58 the fleet encoder emits is 51 — every
// decoder now refuses inputs over 128 characters BEFORE decoding
// (return-style: kind "length"; throwing family: "Address too long"),
// and the exported b58decode/base58Decode refuse the same bound
// directly (probe qa-ss58-lengthbound: controls 46/46 green, 41
// poison checks failed -> GREEN 87/87, rejections in 0–1ms).
{
  const OK_FILES = [
    "pages/safesend/js/ss58.js", "pages/contact-vault/js/ss58.js",
    "pages/distribution-planner/js/ss58.js", "pages/flow-tracer/js/ss58.js",
    "pages/watchtower/js/ss58.js", "pages/portfolio-desk/js/ss58.js",
    "pages/vesting-desk/js/ss58.js", "pages/mempool-desk/js/ss58.js",
    "pages/extrinsic-lab/js/vendor/ss58.js", "pages/pay-desk/js/ss58.js",
    "pages/cli-forge/js/ss58.js", "pages/multisig-vault/js/msig-core.js",
    "pages/reversal-desk/js/reversal-core.js", "pages/exposure-lab/js/exposure-core.js",
    "pages/scale-lab/js/vendor/scale-crypto.js", "pages/proposal-studio/js/vendor/scale-crypto.js",
    "pages/whale-watch/app.js", "pages/address-toolkit/app.js",
  ];
  for (const f of OK_FILES)
    ok(read(f).includes("Too long (") && read(f).includes("length > 128"), "ss58len: " + f + " refuses over-long input before decoding");
  const ESM_FILES = [
    "pages/key-forge/js/quantus-crypto.js", "pages/web-wallet/js/quantus-crypto.js",
    "pages/airgap-desk/js/lib/quantus-crypto.js", "pages/chain-console/js/lib/quantus-crypto.js",
    "pages/zktree-desk/js/quantus-crypto.js",
  ];
  for (const f of ESM_FILES)
    ok(read(f).includes("Address too long") && read(f).includes("Base58 input too long"), "ss58len: " + f + " refuses over-long input before decoding");
  ok(read("pages/safesend/index.html").includes("js/ss58.js?v=1.2.0"), "ss58len: safesend ss58 cache key bumped (1.2.0)");
  ok(read("pages/contact-vault/index.html").includes("js/ss58.js?v=1.27.0"), "ss58len: contact-vault ss58 cache key bumped (1.27.0)");
  ok(read("pages/ledger-desk/index.html").includes("../contact-vault/js/ss58.js?v=1.27.0"), "ss58len: ledger cross-loads the bumped contact-vault ss58 (1.27.0)");
  ok(read("pages/pay-desk/index.html").includes("js/ss58.js?v=1.46.0"), "ss58len: pay-desk ss58 cache key bumped (1.46.0)");
  ok(read("pages/cli-forge/index.html").includes("js/ss58.js?v=1.47.0"), "ss58len: cli-forge ss58 cache key bumped (1.47.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/msig-core.js?v=1.30.0"), "ss58len: msig-core cache key bumped (1.29.0)");
  ok(read("pages/reversal-desk/index.html").includes("js/reversal-core.js?v=1.55.0"), "ss58len: reversal-core cache key bumped (1.55.0)");
  ok(read("pages/exposure-lab/index.html").includes("js/exposure-core.js?v=1.58.0"), "ss58len: exposure-core cache key bumped (1.58.0)");
  ok(read("pages/whale-watch/index.html").includes("app.js?v=1.25.0"), "ss58len: whale-watch app.js cache key bumped (1.25.0)");
  ok(read("pages/address-toolkit/index.html").includes("app.js?v=1.10.0"), "ss58len: address-toolkit app.js cache key bumped (1.10.0)");
  ok(read("pages/key-forge/index.html").includes("js/app.js?v=1.5.0"), "ss58len: key-forge entry cache key bumped (1.5.0)");
  ok(read("pages/web-wallet/index.html").includes("js/app.js?v=1.46.0"), "ss58len: web-wallet entry cache key bumped (1.46.0)");
  ok(read("pages/airgap-desk/index.html").includes("js/app.js?v=1.50.0"), "ss58len: airgap entry cache key bumped (1.50.0)");
  ok(read("pages/chain-console/index.html").includes("js/app.js?v=1.49.0"), "ss58len: chain-console entry cache key bumped (1.49.0)");
  ok(read("pages/zktree-desk/index.html").includes("js/app.js?v=1.51.0"), "ss58len: zktree entry cache key bumped (1.51.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "ss58len: miningcalc sync patch-bump pin (.81)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "ss58len: pool-desk sync patch-bump pin (.81)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "ss58len: energy sync patch-bump pin (.81)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "ss58len: lucklab sync patch-bump pin (.81)");
}

// Batch 125 (2026-10-15 10:19): Swap Desk fee-lab quote bounds + live-asset
// grammar unification — illustrativeQuote clamped nothing: a slippage past
// 100 painted a NEGATIVE guaranteed minimum (≥ -499 USDC), a feeBps past
// 10000 made the fee exceed the offer, and a non-finite offer (the fee-offer
// number input accepts 1e999 -> Infinity) painted NaN figures. The inputs
// now hold their grammars (bps [0, 10000], slippage [0, 100], non-finite ->
// 0) and the returned rates are the clamped ones the render labels. The
// LIVE probe render also read the listed asset raw — its inline check
// bounded decimals but let any positive price paint — while the cached path
// enforced sanitizeCachedAsset's 1e6 ceiling; both paths now route through
// the one sanitizeAsset grammar (probe qa-swapdesk-quotebounds: controls
// 5/5 green, 9 poisons failed -> GREEN 14/14).
{
  ok(read("pages/swap-desk/app.js").includes("if (feeBps > 10000) feeBps = 10000"), "swapbounds: feeBps clamped to the bps grammar");
  ok(read("pages/swap-desk/app.js").includes("if (slippagePct > 100) slippagePct = 100"), "swapbounds: slippage clamped to the percent grammar");
  ok(read("pages/swap-desk/app.js").includes("var a = sanitizeAsset(res.result.asset) || {};"), "swapbounds: live render routes the asset through sanitizeAsset");
  ok(read("pages/swap-desk/index.html").includes("app.js?v=1.20.0"), "swapbounds: swap-desk app.js cache key bumped (1.20.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "swapbounds: miningcalc sync patch-bump pin (.81)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "swapbounds: pool-desk sync patch-bump pin (.81)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "swapbounds: energy sync patch-bump pin (.81)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "swapbounds: lucklab sync patch-bump pin (.81)");
}

// Batch 126 (2026-10-15 11:19): Contact Vault import cap (white-hat track) —
// parseImportPayload kept EVERY valid row of a pasted backup while
// sanitizeVault caps the vault at MAX_CONTACTS=500, and importContacts ran a
// 40,000-iteration PBKDF2 checkphrase derivation PER kept contact (~0.9–2.2s
// each measured): a 5,000-contact "backup" meant ~3 hours of derivations and
// a vault silently trimmed back to the first 500 on the next load. The logic
// gate now stops at the cap with ONE truncation notice, and the app importer
// never derives for a contact a full vault cannot hold (probe
// qa-contactvault-importcap: controls 3/3 green, 4 poisons failed -> GREEN 7/7).
{
  ok(read("pages/contact-vault/js/vault-logic.js").includes("if (contacts.length >= MAX_CONTACTS)"), "importcap: logic gate stops at MAX_CONTACTS");
  ok(read("pages/contact-vault/js/vault-logic.js").includes("beyond the vault cap of "), "importcap: truncation notice names the vault cap");
  ok(read("pages/contact-vault/js/app.js").includes("vault.length >= LOGIC.MAX_CONTACTS"), "importcap: app importer refuses to derive past a full vault");
  ok(read("pages/contact-vault/js/app.js").includes("not imported — vault cap of "), "importcap: import summary reports the capped count");
  ok(read("pages/contact-vault/index.html").includes("js/vault-logic.js?v=1.29.0"), "importcap: vault-logic cache key bumped (1.28.0)");
  ok(read("pages/contact-vault/index.html").includes("js/app.js?v=1.30.0"), "importcap: contact-vault app.js cache key bumped (1.29.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "importcap: miningcalc sync patch-bump pin (.82)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "importcap: pool-desk sync patch-bump pin (.82)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "importcap: energy sync patch-bump pin (.82)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "importcap: lucklab sync patch-bump pin (.82)");
}

// Batch 127 (2026-10-15 11:19, follow-up): Contact Vault checkphrase-fill
// serialization — renderVaultList launched one 40k-iteration PBKDF2
// derivation per missing-phrase contact ALL AT ONCE (and again per
// re-render; derivePhrase caches only on completion). The import-cap
// browser QA exposed it: a vault seeded with 499 phrase-less contacts left
// an import derivation unfinished after 97s (~500 interleaved chunk loops;
// a single derivation alone takes ~1.6s). The lazy fill now goes through
// queuePhraseFill — one at a time, deduped by contact id, like the boot
// backfill — so at most the backfill's + the filler's derivations run
// concurrently.
{
  ok(read("pages/contact-vault/js/app.js").includes("function queuePhraseFill(c)"), "fillqueue: serialized fill entry present");
  ok(read("pages/contact-vault/js/app.js").includes("list.forEach(function (c) { if (!c.checkphrase) queuePhraseFill(c); });"), "fillqueue: renderVaultList routes the lazy fill through the queue");
  ok(read("pages/contact-vault/js/app.js").includes("phraseFillActive[c.id]"), "fillqueue: fill deduped by contact id");
  ok(read("pages/contact-vault/index.html").includes("js/app.js?v=1.30.0"), "fillqueue: contact-vault app.js cache key bumped (1.29.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "fillqueue: miningcalc sync patch-bump pin (.82)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "fillqueue: pool-desk sync patch-bump pin (.82)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "fillqueue: energy sync patch-bump pin (.82)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "fillqueue: lucklab sync patch-bump pin (.82)");
}

// Batch 128 (2026-10-15 12:19): Ledger Desk CSV import cap (white-hat
// track, Tier 1) — sanitizeState caps the ledger at MAX_LEDGER_EVENTS=
// 10000 at LOAD, but importEventsCsv pushed rows straight onto
// state.events with no cap check: a large CSV grew the ledger far beyond
// its own cap in-session (every render walks it) and the next load
// silently trimmed the excess after the import alert claimed it all.
// The manual form and the scan's add-selected pushed uncapped too. All
// three creation paths now ask L.eventRoom(state.events.length) first;
// capped import rows are counted in the alert (probe
// qa-ledger-importcap: controls 3/3 green, 4 poisons failed -> GREEN;
// browser QA: 9,999-seeded ledger + 5-row CSV stops at exactly 10,000).
{
  ok(read("pages/ledger-desk/ledger-core.js").includes("function eventRoom(currentCount)"), "ledgercap: core eventRoom gate present");
  ok(read("pages/ledger-desk/ledger-core.js").includes("eventRoom: eventRoom"), "ledgercap: eventRoom exported");
  ok(read("pages/ledger-desk/app.js").includes("if (!L.eventRoom(state.events.length)) { capped++; continue; }"), "ledgercap: CSV importer counts capped rows at the gate");
  ok(read("pages/ledger-desk/app.js").includes("not imported — ledger cap of "), "ledgercap: import alert names the ledger cap");
  ok(read("pages/ledger-desk/app.js").includes("cappedDet++"), "ledgercap: scan add-selected counts capped candidates");
  ok(read("pages/ledger-desk/app.js").includes("Ledger is full — the ledger cap of "), "ledgercap: manual form refuses at the cap");
  ok(read("pages/ledger-desk/index.html").includes("ledger-core.js?v=1.7.0"), "ledgercap: ledger-core cache key bumped (1.6.0)");
  ok(read("pages/ledger-desk/index.html").includes("app.js?v=1.10.0"), "ledgercap: ledger app.js cache key bumped (1.9.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "ledgercap: miningcalc sync patch-bump pin (.83)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "ledgercap: pool-desk sync patch-bump pin (.83)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "ledgercap: energy sync patch-bump pin (.83)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "ledgercap: lucklab sync patch-bump pin (.83)");
}

// Batch 129 (2026-10-15 13:19): Watchtower watchlist import cap
// (white-hat track, Tier 2) — sanitizeWatchlist caps the watchlist at
// MAX_WATCHLIST=500 at LOAD, but the add form and the backup importer
// pushed with no cap check: a 5,000-address backup grew the list far
// beyond its cap in-session, the next load silently trimmed the excess
// after the import toast claimed them all, and the import/init backfills
// launched one 40,000-iteration PBKDF2 checkphrase derivation per
// phrase-less entry ALL AT ONCE (the Contact Vault herd). Both creation
// paths now ask QWATCH.watchRoom(state.watchlist.length) first — capped
// import rows are counted in the toast, the form refuses with a
// cap-named toast — and every checkphrase fill is serialized through
// queuePhraseFill (probe qa-watchtower-importcap: controls 2/2 green,
// 9 poisons failed -> GREEN 16/16; browser QA: 499-seeded watchlist +
// 5-address backup stops at exactly 500).
{
  ok(read("pages/watchtower/js/watch-core.js").includes("function watchRoom(currentCount)"), "watchcap: core watchRoom gate present");
  ok(read("pages/watchtower/js/watch-core.js").includes("watchRoom: watchRoom, MAX_WATCHLIST: MAX_WATCHLIST"), "watchcap: watchRoom + MAX_WATCHLIST exported");
  ok(read("pages/watchtower/js/app.js").includes("if (!QWATCH.watchRoom(state.watchlist.length)) { capped++; return; }"), "watchcap: importer counts capped rows at the gate");
  ok(read("pages/watchtower/js/app.js").includes("not imported — watchlist cap of "), "watchcap: import toast names the watchlist cap");
  ok(read("pages/watchtower/js/app.js").includes("Watchlist is full — the watchlist cap of "), "watchcap: add form refuses at the cap");
  ok(read("pages/watchtower/js/app.js").includes("function queuePhraseFill(entry, verify)"), "watchcap: serialized phrase-fill queue present");
  ok(read("pages/watchtower/js/app.js").includes("state.watchlist.forEach(function (x) { queuePhraseFill(x, true); });"), "watchcap: init backfill routes through the queue");
  ok(read("pages/watchtower/index.html").includes("js/watch-core.js?v=1.36.0"), "watchcap: watch-core cache key bumped (1.36.0)");
  ok(read("pages/watchtower/index.html").includes("js/app.js?v=1.38.0"), "watchcap: watchtower app.js cache key bumped (1.38.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "watchcap: miningcalc sync patch-bump pin (.84)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "watchcap: pool-desk sync patch-bump pin (.84)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "watchcap: energy sync patch-bump pin (.84)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "watchcap: lucklab sync patch-bump pin (.84)");
}


// Batch 130 (2026-10-15 14:19): Mempool Desk watcher creation cap
// (white-hat track) — sanitizeWatchers caps the persisted watcher list
// at MAX_WATCHERS=50 at LOAD, but addWatcher, the only creation path,
// pushed with no cap check: the form grew the list past its cap
// in-session, every watcher opening a live txWatch node subscription,
// and the next load silently trimmed the excess after the UI claimed
// "Added — subscribing…". addWatcher now asks the new core gate
// C.watcherRoom(state.watchers.length) first and refuses with a
// cap-named message (probe qa-mempool-watchcap: controls 3/3 green,
// 5 poisons failed -> GREEN 14/14; browser QA: 50 seeded watchers +
// one more add refused at exactly 50, control add below the cap works).
{
  ok(read("pages/mempool-desk/js/rpc-core.js").includes("function watcherRoom(currentCount)"), "mempoolcap: core watcherRoom gate present");
  ok(read("pages/mempool-desk/js/rpc-core.js").includes("watcherRoom: watcherRoom"), "mempoolcap: watcherRoom exported");
  ok(read("pages/mempool-desk/js/app.js").includes("if (C.watcherRoom(state.watchers.length) <= 0) {"), "mempoolcap: addWatcher asks the gate before the push");
  ok(read("pages/mempool-desk/js/app.js").includes("The watch list is full — the cap is "), "mempoolcap: refusal message names the watcher cap");
  ok(read("pages/mempool-desk/js/app.js").includes("each watcher is a live node subscription"), "mempoolcap: refusal explains the subscription cost");
  ok(read("pages/mempool-desk/index.html").includes("js/rpc-core.js?v=1.36.0"), "mempoolcap: rpc-core cache key bumped (1.36.0)");
  ok(read("pages/mempool-desk/index.html").includes("js/app.js?v=1.38.0"), "mempoolcap: mempool app.js cache key bumped (1.38.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "mempoolcap: miningcalc sync patch-bump pin (.85)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "mempoolcap: pool-desk sync patch-bump pin (.85)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "mempoolcap: energy sync patch-bump pin (.85)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "mempoolcap: lucklab sync patch-bump pin (.85)");
}

// Batch 131 (2026-10-15 15:19): Notary Desk vault creation cap
// (white-hat track, Tier 1) — sanitizeVault caps the vault at
// MAX_VAULT_ENTRIES=500 at LOAD, but the Save button, the only creation
// path, unshifted with no cap check: at a full vault the new anchor
// painted "✓ Saved" while the render's loadVault kept the first 500
// and silently evicted the OLDEST anchor. The save handler now asks
// the new core gate C.vaultRoom(v.length) first and refuses with a
// cap-named button message (probe qa-notary-vaultcap: controls 4/4
// green, 5 poisons failed -> GREEN 16/16; browser QA: 500 seeded
// anchors + one more save refused at exactly 500, oldest not evicted,
// control save below the cap succeeds).
{
  ok(read("pages/notary-desk/js/notary-codec.js").includes("function vaultRoom(currentCount)"), "notarycap: core vaultRoom gate present");
  ok(read("pages/notary-desk/js/notary-codec.js").includes("vaultRoom: vaultRoom"), "notarycap: vaultRoom exported");
  ok(read("pages/notary-desk/js/app.js").includes("if (C.vaultRoom(v.length) <= 0) {"), "notarycap: save handler asks the gate before the unshift");
  ok(read("pages/notary-desk/js/app.js").includes("Vault is full — the cap is "), "notarycap: refusal message names the vault cap");
  ok(read("pages/notary-desk/js/app.js").includes("Delete one before saving another."), "notarycap: refusal tells the user how to make room");
  ok(read("pages/notary-desk/index.html").includes("js/notary-codec.js?v=1.51.0"), "notarycap: notary-codec cache key bumped (1.51.0)");
  ok(read("pages/notary-desk/index.html").includes("js/app.js?v=1.55.0"), "notarycap: notary app.js cache key bumped (1.55.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "notarycap: miningcalc sync patch-bump pin (.86)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "notarycap: pool-desk sync patch-bump pin (.86)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "notarycap: energy sync patch-bump pin (.86)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "notarycap: lucklab sync patch-bump pin (.86)");
}
// Batch 132 (2026-10-15 16:19): Vanity Forge vault creation cap
// (white-hat track) — sanitizeVault caps the vault at MAX_VAULT_RECORDS=
// 200 at LOAD (first/newest wins), but onFound, the only creation path,
// unshifted with no cap check, saveVault persisted the over-cap list, and
// renderVault renders the in-memory array unsanitized — so the vault grew
// past 200 in-session and the NEXT load silently evicted the OLDEST finds,
// stored ML-DSA secret keys included. onFound now asks the new core gate
// vaultRoom(vault.length) first and at the cap skips ONLY the vault write:
// the find still lands on its card (that card is the keypair's only other
// copy) carrying a cap-named NOT-saved warning (probe qa-vanity-vaultcap:
// controls 4/4 green, 7 poisons failed -> GREEN 20/20; browser QA
// qa-vanity-vaultcap-browser 15/15: 199 seeded real-checksum finds + a
// real grind reached exactly 200; a second real grind at the cap stayed
// at 200, oldest seeded find not evicted, refused find never persisted).
{
  ok(read("pages/vanity-forge/js/vanity.js").includes("export function vaultRoom(currentCount)"), "vanitycap: core vaultRoom gate present");
  ok(read("pages/vanity-forge/js/vanity.js").includes("export const MAX_VAULT_RECORDS = 200;"), "vanitycap: vault cap constant pinned");
  ok(read("pages/vanity-forge/js/app.js").includes("const vaulted = vaultRoom(vault.length) > 0;"), "vanitycap: onFound asks the gate before the unshift");
  ok(read("pages/vanity-forge/js/app.js").includes("Vault is full — the cap is "), "vanitycap: card warning names the vault cap");
  ok(read("pages/vanity-forge/js/app.js").includes("NOT saved to the vault"), "vanitycap: card warning says the find was not saved");
  ok(read("pages/vanity-forge/js/app.js").includes("fc-capwarn"), "vanitycap: cap warning is rendered on the found card");
  ok(read("pages/vanity-forge/index.html").includes("js/app.js?v=1.27.0"), "vanitycap: vanity app.js cache key bumped (1.27.0)");
  ok(read("pages/vanity-forge/index.html").includes("styles.css?v=1.25.0"), "vanitycap: vanity styles.css cache key bumped (1.25.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "vanitycap: miningcalc sync patch-bump pin (.87)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "vanitycap: pool-desk sync patch-bump pin (.87)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "vanitycap: energy sync patch-bump pin (.87)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "vanitycap: lucklab sync patch-bump pin (.87)");
}

// Batch 133 (2026-10-15 17:19): MultiSig Vault board creation cap
// (white-hat track) — sanitizeBoard caps the board at
// MAX_BOARD_ENTRIES=500 at LOAD, first-wins, but bp-save, the only
// creation path, APPENDS with no cap check: at a full board the push
// made 501, saveBoard persisted 501, and renderBoard's loadBoard kept
// the first 500 — the NEW proposal vanished in the same paint under a
// "Proposal logged" toast. bp-save now asks the new core gate
// C.boardRoom(items.length) first and refuses with a cap-named message
// in bp-err; the form stays open with the entry intact (probe
// qa-multisig-boardcap: controls 5/5 green, 6 poisons failed -> GREEN
// 19/19; browser QA: 500 seeded proposals + one more save refused at
// exactly 500, oldest seeded proposal kept, refused proposal never
// persisted, control save below the cap succeeds).
{
  ok(read("pages/multisig-vault/js/msig-core.js").includes("function boardRoom(currentCount)"), "msigcap: core boardRoom gate present");
  ok(read("pages/multisig-vault/js/msig-core.js").includes("boardRoom: boardRoom"), "msigcap: boardRoom exported");
  ok(read("pages/multisig-vault/js/app.js").includes("if (C.boardRoom(items.length) <= 0) {"), "msigcap: bp-save asks the gate before the push");
  ok(read("pages/multisig-vault/js/app.js").includes("Board is full — the cap is "), "msigcap: refusal message names the board cap");
  ok(read("pages/multisig-vault/js/app.js").includes("Remove one before logging another."), "msigcap: refusal tells the user how to make room");
  ok(read("pages/multisig-vault/index.html").includes("js/msig-core.js?v=1.30.0"), "msigcap: msig-core cache key bumped (1.29.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/app.js?v=1.28.0"), "msigcap: multisig app.js cache key bumped (1.27.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "msigcap: miningcalc sync patch-bump pin (.88)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "msigcap: pool-desk sync patch-bump pin (.88)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "msigcap: energy sync patch-bump pin (.88)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "msigcap: lucklab sync patch-bump pin (.88)");
}

// Batch 134 (2026-10-15 18:19): Proposal Studio draft creation cap
// (white-hat track) — sanitizeDrafts caps the vault at MAX_DRAFTS=100 at
// LOAD, first-wins, but BOTH creation paths were uncapped: dv-save
// unshifted with no cap check (at a full vault the persisted 101st draft's
// next load silently evicted the OLDEST draft under a "Saved" note), and
// dv-import saved clean.concat(existing) — up to 200 persisted, the load
// trim then silently evicting EVERY existing draft past the cap while the
// toast claimed them all. dv-save now asks the new core gate
// C.draftRoom(d.length) first and refuses with a cap-named note (the form
// stays intact); dv-import takes only draftRoom-many cleaned drafts and
// counts the rest as not imported in the toast (probe
// qa-proposalstudio-draftcap: controls 6/6 green incl. both harm
// simulations, 8 poisons failed -> GREEN 23/23; browser QA 17/17: control
// save reaches exactly 100, at-cap save refused with the oldest draft
// kept and the name field intact, at-cap import takes 0 and counts 3,
// partial import after 2 deletes takes exactly 2 of 5 and counts 3).
{
  ok(read("pages/proposal-studio/js/gov-codec.js").includes("function draftRoom(currentCount)"), "pscap: core draftRoom gate present");
  ok(read("pages/proposal-studio/js/gov-codec.js").includes("draftRoom: draftRoom"), "pscap: draftRoom exported");
  ok(read("pages/proposal-studio/js/app.js").includes("if (C.draftRoom(d.length) <= 0) {"), "pscap: dv-save asks the gate before the unshift");
  ok(read("pages/proposal-studio/js/app.js").includes("Draft vault is full — the cap is 100 drafts."), "pscap: dv-save refusal names the cap");
  ok(read("pages/proposal-studio/js/app.js").includes("clean.slice(0, C.draftRoom(existing.length))"), "pscap: dv-import takes only the room");
  ok(read("pages/proposal-studio/js/app.js").includes("not imported — draft vault cap of 100 drafts reached"), "pscap: dv-import counts the capped drafts");
  ok(read("pages/proposal-studio/index.html").includes("js/gov-codec.js?v=1.45.0"), "pscap: gov-codec cache key bumped (1.45.0)");
  ok(read("pages/proposal-studio/index.html").includes("js/app.js?v=1.45.0"), "pscap: app.js cache key bumped (1.45.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "pscap: miningcalc sync patch-bump pin (.89)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "pscap: pool-desk sync patch-bump pin (.89)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "pscap: energy sync patch-bump pin (.89)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "pscap: lucklab sync patch-bump pin (.89)");
}

// Batch 135 (2026-10-15 20:19): Ledger Desk vault address creation cap
// (white-hat track, Tier 1) — sanitizeState caps the address vault at
// MAX_VAULT_ADDRESSES=500 at LOAD (first-wins), but the add-address flow —
// the only path that CREATES addresses — pushed with no cap check: the
// confirm handler pushed, save() persisted 501, and the next load's trim
// silently dropped the NEW address, the one whose checkphrase the user had
// just read back and confirmed, under a "✓ added to vault" message. The
// flow now asks the new core gate L.addressRoom(state.addresses.length)
// first TWICE: early in handleAddrSubmit (before the 40,000-round
// checkphrase derivation, so a full vault refuses without burning the KDF)
// and authoritatively at the confirm push, voiding the pin with a
// cap-named message (probe qa-ledger-addrcap: controls 3/3 green incl. the
// appended-501st harm simulation, 2 poisons failed -> GREEN 13/13; browser
// QA 12/12: 499 seeded render, a control add reaches exactly 500, an
// at-cap submit is refused with the oldest seeded address kept).
{
  ok(read("pages/ledger-desk/ledger-core.js").includes("function addressRoom(currentCount)"), "ledgeraddrcap: core addressRoom gate present");
  ok(read("pages/ledger-desk/ledger-core.js").includes("addressRoom: addressRoom"), "ledgeraddrcap: addressRoom exported");
  ok((read("pages/ledger-desk/app.js").match(/addressRoom\(state\.addresses\.length\)/g) || []).length >= 2, "ledgeraddrcap: creation path gated early + at confirm");
  ok(read("pages/ledger-desk/app.js").indexOf("addressRoom(state.addresses.length)") < read("pages/ledger-desk/app.js").indexOf("deriving checkphrase"), "ledgeraddrcap: early gate sits before the checkphrase derivation");
  ok(read("pages/ledger-desk/app.js").includes("Vault is full"), "ledgeraddrcap: refusal names the vault cap");
  ok(read("pages/ledger-desk/index.html").includes("ledger-core.js?v=1.7.0"), "ledgeraddrcap: ledger-core cache key bumped (1.7.0)");
  ok(read("pages/ledger-desk/index.html").includes("app.js?v=1.10.0"), "ledgeraddrcap: ledger app.js cache key bumped (1.10.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "ledgeraddrcap: miningcalc sync patch-bump pin (.90)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "ledgeraddrcap: pool-desk sync patch-bump pin (.90)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "ledgeraddrcap: energy sync patch-bump pin (.90)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "ledgeraddrcap: lucklab sync patch-bump pin (.90)");
}

console.log(`\n${pass} passed, ${fail} failed`);
// Batch 136 (2026-10-15 21:19): Legacy Vault plan creation caps
// (white-hat track) — sanitizePlan caps beneficiaries and holdings at
// MAX_BENEFICIARIES/MAX_HOLDINGS=100 at LOAD (first-wins), and the JSON
// import routes through the same sanitizer, but the two Add buttons — the
// only creation paths — pushed with no cap check: at a full plan the push
// persisted 101 and the next load silently trimmed the NEW row, a
// beneficiary or holding the owner had just added to their inheritance
// plan. Both handlers now ask the new core gates first
// (LOGIC.beneficiaryRoom / LOGIC.holdingRoom, exact fail-closed
// arithmetic) and refuse with a cap-named message on ben-msg/hold-msg
// (probe qa-legacyvault-plancap: controls 8/8 green incl. both
// appended-101st harm simulations, 11 poisons failed -> GREEN 31/31;
// Legacy unit tests 87 -> 92).
{
  ok(read("pages/legacy-vault/js/plan-logic.js").includes("function beneficiaryRoom(currentCount)"), "legacyplancap: core beneficiaryRoom gate present");
  ok(read("pages/legacy-vault/js/plan-logic.js").includes("beneficiaryRoom, holdingRoom"), "legacyplancap: room gates exported");
  ok(read("pages/legacy-vault/js/app.js").includes("beneficiaryRoom(plan.beneficiaries.length)"), "legacyplancap: ben-add gated on beneficiaryRoom");
  ok(read("pages/legacy-vault/js/app.js").includes("holdingRoom(plan.holdings.length)"), "legacyplancap: hold-add gated on holdingRoom");
  ok(read("pages/legacy-vault/js/app.js").includes("the cap is 100 beneficiaries"), "legacyplancap: beneficiary refusal names the cap");
  ok(read("pages/legacy-vault/js/app.js").includes("the cap is 100 items"), "legacyplancap: holding refusal names the cap");
  ok(read("pages/legacy-vault/index.html").includes("js/plan-logic.js?v=1.29.0"), "legacyplancap: plan-logic cache key bumped (1.29.0)");
  ok(read("pages/legacy-vault/index.html").includes("js/app.js?v=1.29.0"), "legacyplancap: app.js cache key bumped (1.29.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "legacyplancap: miningcalc sync patch-bump pin (.91)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "legacyplancap: pool-desk sync patch-bump pin (.91)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "legacyplancap: energy sync patch-bump pin (.91)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "legacyplancap: lucklab sync patch-bump pin (.91)");
}

// Batch 137 (2026-10-15 22:19): Contact Vault add-path creation cap
// (white-hat track) — sanitizeVault caps the vault at MAX_CONTACTS=500
// at LOAD (first-wins) and both import paths were already gated, but
// the single Add form — the remaining creation path — pushed with no
// cap check: at a full vault the push persisted 501 and the next load
// silently trimmed the NEW contact, the one whose checkphrase had just
// been derived (40,000 PBKDF2 iterations) and shown under a "✓ Saved"
// message. The form now asks the new core gate LOGIC.contactRoom
// twice: early, before the derivation (a full vault refuses without
// burning the KDF), and authoritatively inside the derivation
// callback before vault.push, refusing with a cap-named message on
// addMsg (probe qa-contactvault-addcap: controls 5/5 green incl. the
// appended-501st harm simulation, 6 poisons failed -> GREEN 18/18;
// Contact Vault unit checks +2, syntax-checked and verified standalone
// — the full 1,171-vector suite was not re-run this run).
{
  ok(read("pages/contact-vault/js/vault-logic.js").includes("function contactRoom(currentCount)"), "contactaddcap: core contactRoom gate present");
  ok(read("pages/contact-vault/js/vault-logic.js").includes("contactRoom: contactRoom"), "contactaddcap: contactRoom exported");
  ok((read("pages/contact-vault/js/app.js").match(/contactRoom\(vault\.length\)/g) || []).length === 2, "contactaddcap: add form gated early + authoritatively");
  ok(read("pages/contact-vault/js/app.js").indexOf("contactRoom(vault.length)") < read("pages/contact-vault/js/app.js").indexOf("derivePhrase(v.address).then(function (words) {\n    if (!LOGIC.contactRoom"), "contactaddcap: early gate sits before the derivation");
  ok(read("pages/contact-vault/js/app.js").includes("Vault is full"), "contactaddcap: refusal names the vault as full");
  ok(read("pages/contact-vault/js/app.js").includes("contacts. Remove one before adding another."), "contactaddcap: refusal names the cap remedy");
  ok(read("pages/contact-vault/index.html").includes("js/vault-logic.js?v=1.29.0"), "contactaddcap: vault-logic cache key bumped (1.29.0)");
  ok(read("pages/contact-vault/index.html").includes("js/app.js?v=1.30.0"), "contactaddcap: app.js cache key bumped (1.30.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "contactaddcap: miningcalc sync patch-bump pin (.92)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "contactaddcap: pool-desk sync patch-bump pin (.92)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "contactaddcap: energy sync patch-bump pin (.92)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "contactaddcap: lucklab sync patch-bump pin (.92)");
}

// Batch 138 (2026-10-15 23:19): Pay Desk register creation cap
// (white-hat track) — sanitizeRegister caps the register at
// REGISTER_CAP=500 at LOAD (first-wins; the register is newest-first),
// but createInvoice — the only creation path — unshifted with no cap
// check: at a full register the unshift persisted 501 and the next
// load silently evicted the OLDEST invoice, a merchant's payment
// record, while the new invoice's payment request painted as if
// everything was kept. createInvoice now asks the new core gate
// registerRoom(state.register.length) first and refuses with a
// cap-named message on inv-error (probe qa-paydesk-registercap:
// controls 5/5 green incl. the unshift-at-cap eviction simulation,
// 6 poisons failed -> GREEN 18/18; Pay Desk unit tests 151 -> 159;
// browser QA 13/13: 499 seeded invoices, a control create reaches
// exactly 500, an at-cap create is refused with the oldest seed intact
// and the displayed request unchanged, zero console errors).
{
  ok(read("pages/pay-desk/js/app.js").includes("function registerRoom(currentCount)"), "payregcap: core registerRoom gate present");
  ok(read("pages/pay-desk/js/app.js").includes("registerRoom: registerRoom"), "payregcap: registerRoom exported");
  ok(read("pages/pay-desk/js/app.js").includes("REGISTER_CAP: REGISTER_CAP"), "payregcap: REGISTER_CAP exported");
  ok(read("pages/pay-desk/js/app.js").includes("if (!registerRoom(state.register.length))"), "payregcap: createInvoice asks the gate first");
  ok(read("pages/pay-desk/js/app.js").indexOf("registerRoom(state.register.length)") < read("pages/pay-desk/js/app.js").indexOf("state.register.unshift"), "payregcap: gate sits before the unshift");
  ok(read("pages/pay-desk/js/app.js").includes("Register is full"), "payregcap: refusal names the register as full");
  ok(read("pages/pay-desk/js/app.js").includes("invoices. Export the register as CSV and clear it before creating another."), "payregcap: refusal names the cap remedy");
  ok(read("pages/pay-desk/index.html").includes("js/app.js?v=1.51.0"), "payregcap: app.js cache key bumped (1.51.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "payregcap: miningcalc sync patch-bump pin (.93)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "payregcap: pool-desk sync patch-bump pin (.93)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "payregcap: energy sync patch-bump pin (.93)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "payregcap: lucklab sync patch-bump pin (.93)");
}

// Batch 139 (2026-10-16 00:19): Mining Studio checklist localStorage
// sanitizer (white-hat track) — the persisted-collection sweep found
// the one localStorage load with NO sanitizer at all: renderSec and
// the toggle handler only caught JSON syntax errors, so valid-JSON
// "null" crashed renderSec (aborting init — the troubleshooter never
// rendered), "abc" counted 3 phantom hardened items off its string
// indices (a security checklist lying about posture), arrays counted,
// and unknown keys were preserved unbounded on every toggle save.
// Both load sites now rebuild through Studio.sanitizeSecDone (real
// SECURITY indices only, strict boolean true only) — probe
// qa-miningstudio-secsanitize: controls 5/5 green incl. the null-crash
// and string-phantom simulations -> GREEN 21/21; Mining Studio unit
// tests 105 -> 113.
{
  ok(read("pages/mining-studio/app.js").includes("Studio.sanitizeSecDone = function (raw)"), "studiosecclean: core sanitizeSecDone defined");
  ok(read("pages/mining-studio/app.js").includes("Array.isArray(raw)"), "studiosecclean: arrays rejected as checklist state");
  ok(read("pages/mining-studio/app.js").includes("if (raw[i] === true) out[i] = true;"), "studiosecclean: only strict boolean true survives");
  ok((read("pages/mining-studio/app.js").match(/sanitizeSecDone\(JSON\.parse\(localStorage\.getItem\(SEC_KEY\)/g) || []).length === 2, "studiosecclean: both load sites wrap the raw parse");
  ok(read("pages/mining-studio/index.html").includes("app.js?v=1.5.0"), "studiosecclean: app.js cache key bumped (1.5.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "studiosecclean: miningcalc sync patch-bump pin (.94)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "studiosecclean: pool-desk sync patch-bump pin (.94)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "studiosecclean: energy sync patch-bump pin (.94)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "studiosecclean: lucklab sync patch-bump pin (.94)");
}

// Batch 140 (2026-10-16 02:19): Distribution Planner checkphrase
// queue bound (white-hat track) — renderReview displays at most 500
// rows and a checkphrase is a display-only aid (batch JSON and the
// run script never carry one), but revalidate() queued EVERY unique
// valid address for a 40,000-iteration PBKDF2 derivation: a
// 600-recipient plan burned 600 derivations where at most 500 can
// ever be displayed, and a 100k-line paste queued 100k. cpQueued now
// comes from the new core gate checkphraseQueue(validated,
// DISPLAY_ROW_CAP) — deduped valid addresses among the first 500
// rows only, fail-closed on a bad cap — and the table-cap note
// discloses the bound. Probe qa-distribution-cpqueue: controls 5/5
// green incl. the uncapped-600 harm simulation -> GREEN 23/23.
{
  ok(read("pages/distribution-planner/js/core.js").includes("function checkphraseQueue(validated, cap)"), "distcpqueue: core checkphraseQueue gate present");
  ok(read("pages/distribution-planner/js/core.js").includes("DISPLAY_ROW_CAP: DISPLAY_ROW_CAP"), "distcpqueue: DISPLAY_ROW_CAP exported");
  ok(read("pages/distribution-planner/js/core.js").includes("checkphraseQueue: checkphraseQueue"), "distcpqueue: checkphraseQueue exported");
  ok(read("pages/distribution-planner/js/app.js").includes("cpQueued = core.checkphraseQueue(validated, core.DISPLAY_ROW_CAP);"), "distcpqueue: revalidate builds the queue through the gate");
  ok(read("pages/distribution-planner/js/app.js").includes("var CAP = core.DISPLAY_ROW_CAP;"), "distcpqueue: renderReview shares the same cap");
  ok(read("pages/distribution-planner/js/app.js").includes("checkphrases are computed for the shown rows only"), "distcpqueue: table-cap note discloses the phrase bound");
  ok(read("pages/distribution-planner/index.html").includes("js/core.js?v=1.25.0"), "distcpqueue: core.js cache key bumped (1.25.0)");
  ok(read("pages/distribution-planner/index.html").includes("js/app.js?v=1.23.0"), "distcpqueue: app.js cache key bumped (1.23.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "distcpqueue: miningcalc sync patch-bump pin (.96)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "distcpqueue: pool-desk sync patch-bump pin (.96)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "distcpqueue: energy sync patch-bump pin (.96)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "distcpqueue: lucklab sync patch-bump pin (.96)");
}

// Batch 141 (2026-10-16 03:19): MultiSig Vault signer parse window
// (white-hat track) — parseSigners runs on every 'input' event and
// SS58-decodes EVERY non-blank line (base58 + blake2b-512 each; per-line
// length-bounded at 128 chars, but the line count was unbounded): a
// 20,000-line paste decoded all 20,000 on the paste and again on every
// later keystroke, freezing the tab, though a vault takes at most
// MAX_SIGNERS=100 signers. The lines now pass through the new core gate
// signerParseWindow(lines, MAX_SIGNER_LINES=500) — 5x signer headroom
// for duplicate/invalid lines, fail-closed on a bad cap — and the hint
// discloses the skipped count with the cap named. Probe
// qa-multisig-signerwindow: harm controls green (incl. the uncapped
// 2,000-line decode-all simulation) -> GREEN 23/23; MultiSig unit
// tests 183 -> 204.
{
  ok(read("pages/multisig-vault/js/msig-core.js").includes("function signerParseWindow(lines, cap)"), "msigwin: core signerParseWindow gate present");
  ok(read("pages/multisig-vault/js/msig-core.js").includes("signerParseWindow: signerParseWindow"), "msigwin: signerParseWindow exported");
  ok(read("pages/multisig-vault/js/msig-core.js").includes("MAX_SIGNER_LINES: MAX_SIGNER_LINES"), "msigwin: MAX_SIGNER_LINES exported");
  ok(read("pages/multisig-vault/js/msig-core.js").includes("var MAX_SIGNER_LINES = 500;"), "msigwin: line cap is 500");
  ok(read("pages/multisig-vault/js/app.js").includes("var win = C.signerParseWindow(allLines, C.MAX_SIGNER_LINES);"), "msigwin: parseSigners asks the window first");
  ok(read("pages/multisig-vault/js/app.js").indexOf("signerParseWindow(allLines") < read("pages/multisig-vault/js/app.js").indexOf("win.parse.forEach"), "msigwin: window sits before the decode loop");
  ok(read("pages/multisig-vault/js/app.js").includes("not parsed — only the first"), "msigwin: hint discloses skipped lines");
  ok(read("pages/multisig-vault/index.html").includes("js/msig-core.js?v=1.30.0"), "msigwin: msig-core cache key bumped (1.30.0)");
  ok(read("pages/multisig-vault/index.html").includes("js/app.js?v=1.28.0"), "msigwin: app.js cache key bumped (1.28.0)");
  ok(read("pages/mining-calculator/index.html").includes("app.js?v=1.11.98"), "msigwin: miningcalc sync patch-bump pin (.97)");
  ok(read("pages/pool-desk/index.html").includes("js/app.js?v=1.48.98"), "msigwin: pool-desk sync patch-bump pin (.97)");
  ok(read("pages/energy-observatory/index.html").includes("app.js?v=1.51.98"), "msigwin: energy sync patch-bump pin (.97)");
  ok(read("pages/luck-lab/index.html").includes("app.js?v=1.48.98"), "msigwin: lucklab sync patch-bump pin (.97)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
