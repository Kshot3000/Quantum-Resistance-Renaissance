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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
