/* QTC Quantus-Muse-Builder — fleet fetch-timeout guard. Run: node tests/test-fetch-timeouts.js
 *
 * Guards the hung-fetch class (fixed fleet-wide 2026-10-02): a fetch() with
 * no AbortSignal never settles when the connection hangs — the promise
 * neither resolves nor rejects, so the app's catch/fallback path never runs
 * and the page strands on "Loading…" forever. Every fetch in app code must
 * carry a signal (AbortSignal.timeout, an AbortController, or the shared
 * timeoutSignal(ms) helper).
 *
 * Rules:
 *  1. Every fetch( in pages/** app code (vendor/ and tests/ excluded) must
 *     have "signal" in its options (checked in the 450 chars after fetch().
 *  2. The two remote-indexer fetches that motivated the pass stay guarded:
 *     web-wallet activity (SQUID, timeoutSignal(10000)) and supply-audit's
 *     pool-balance query (pctl.signal with an 8000ms abort timer).
 *  3. Every timeoutSignal definition must actually wire AbortSignal.timeout
 *     with an AbortController fallback (no stub helpers).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "pages");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label); }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "vendor" || e.name === "tests" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(PAGES_DIR, []);
let fetchCount = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  let idx = 0;
  while ((idx = src.indexOf("fetch(", idx)) !== -1) {
    fetchCount++;
    const window_ = src.slice(idx, idx + 450);
    ok(window_.includes("signal"), `bounded fetch :: ${rel} @${src.slice(0, idx).split("\n").length}`);
    idx += 6;
  }
  // Rule 3: helper definitions must be real.
  if (src.includes("function timeoutSignal(")) {
    ok(src.includes("AbortSignal.timeout") && src.includes("new AbortController()"),
      `timeoutSignal is a real abort helper :: ${rel}`);
  }
}
ok(fetchCount >= 30, `fleet fetch coverage :: ${fetchCount} fetch call sites scanned`);

// Rule 2: the remote-indexer fixes.
const wallet = fs.readFileSync(path.join(PAGES_DIR, "web-wallet/js/app.js"), "utf8");
const squidAt = wallet.indexOf("fetch(SQUID");
ok(squidAt !== -1 && wallet.slice(squidAt, squidAt + 450).includes("signal: timeoutSignal(10000)"),
  "web-wallet activity fetch :: SQUID bounded at 10000ms");
const audit = fs.readFileSync(path.join(PAGES_DIR, "supply-audit/app.js"), "utf8");
ok(audit.includes("signal: pctl.signal") && /pctl\.abort\(\); \}, 8000\)/.test(audit),
  "supply-audit pool query :: bounded at 8000ms via pctl");

// Rule 4 (2026-10-09): the timeout must cover the BODY, not just the headers.
// A manual AbortController helper that clears its timer in the headers stage
// (the .then on fetch, or right after `await fetch`) leaves res.json() with
// no timeout at all — a stalled body then hangs the load forever: no
// rejection, no catch, no snapshot fallback. Network Dashboard's fetchDirect
// was the first find; the same shape was then fixed in block-explorer,
// watchtower, portfolio-desk, luck-lab, supply-audit and vesting-desk.
// (a) The one-line copy-paste form must not exist anywhere in app code.
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  ok(!/clearTimeout\(\w+\);\s*if \(!\w+\.ok\) throw[^\n]*return \w+\.json\(\)/.test(src),
    `no clear-on-headers one-liner :: ${rel}`);
}
// (b) Per-site pins: in each fixed helper, the guarded .json() must come
//     BEFORE the first clearTimeout of that helper's timer.
function pin(file, fromMarker, jsonMarker, timerName, label) {
  const src = fs.readFileSync(path.join(PAGES_DIR, file), "utf8");
  const seg = src.slice(src.indexOf(fromMarker), src.indexOf(fromMarker) + 1600);
  const j = seg.indexOf(jsonMarker);
  const c = seg.indexOf(`clearTimeout(${timerName})`);
  ok(j !== -1 && c !== -1 && j < c, `body covered by timeout :: ${label}`);
}
pin("block-explorer/app.js", "function gql(query)", "return res.json()", "timer", "block-explorer gql");
pin("watchtower/js/app.js", "function fetchJson(url", "return r.json()", "t", "watchtower fetchJson");
pin("portfolio-desk/js/app.js", "function fetchJson(url", "return r.json()", "t", "portfolio-desk fetchJson");
pin("luck-lab/js/app.js", "function gql(query", "return r.json()", "to", "luck-lab gql");
pin("supply-audit/app.js", "async function loadSupply()", "await r.json()", "t", "supply-audit loadSupply main query");
pin("supply-audit/app.js", "var pq = await fetch", "await pq.json()", "pt", "supply-audit loadSupply pool query");
pin("vesting-desk/app.js", "async function loadData()", "await res.json()", "to", "vesting-desk loadData");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
