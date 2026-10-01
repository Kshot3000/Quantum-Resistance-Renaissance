/* QTC Quantus-Muse-Builder — fleet cache-key guard. Run: node tests/test-cache-keys.js
 *
 * Guards the stale-cache board-breaker class (see OctaSpace hub 2026-10-01):
 * a shared asset referenced with different ?v= keys on different pages means
 * returning visitors get mismatched code, and a key older than the file's last
 * content change serves cached bytes that no longer match the page.
 *
 * Rules:
 *  1. Every local .js / .css load must carry a ?v= cache key.
 *  2. Every shared asset (assets/*) must use ONE uniform key on every page.
 *  3. Each shared asset's key must be >= the baseline recorded at its last
 *     content-changing commit. When you change a shared asset, bump its key
 *     on every referencing page and update the BASELINES entry below.
 *  4. Every referenced local file must exist (catches 404s fleet-wide).
 *
 * data/*.json snapshot fetches are intentionally NOT keyed: apps fetch them
 * with cache:"no-store" (tokenomics adds a ?t= minute-buster), so the latest
 * server-side snapshot is always read.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "pages");

// asset -> minimum ?v= key allowed (version of last content-changing commit).
// shared.css: 1.13.0 adds the fleet mobile-hardening rules (2026-10-01:
// zero-horizontal-scroll at <=640px — code/address wrap, in-place table
// scroll, header .top-actions own-row wrap, form-control max-widths);
// 1.13.1 adds label{min-width:0;max-width:100%} so flex/grid label wrappers
// can't be forced wider than the viewport by a select/input's intrinsic size;
// 1.13.2 adds box-sizing:border-box on form controls so width:100% + padding
// can't spill past the container (multisig-vault textarea overflow).
// (History: content last changed at v1.16.0 (body color/background fix) but the
// key assigned at that commit was (mis)labeled v1.12.0; the 2026-10-01 fleet
// mobile-hardening change re-baselined it honestly at 1.13.0.)
const BASELINES = {
  "assets/app-nav.js": "1.8.0",
  "assets/favicon.svg": "1.16.0",
  "assets/shared.css": "1.13.2",
};

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? " :: " + extra : ""));
  if (!cond) fails++;
}

function verGte(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

const htmlFiles = ["index.html"];
for (const d of fs.readdirSync(PAGES_DIR).sort()) {
  const idx = path.join(PAGES_DIR, d, "index.html");
  if (fs.existsSync(idx)) htmlFiles.push(path.relative(ROOT, idx));
}

const REF_RE = /(?:src|href)\s*=\s*"([^"#]+?)(?:#[^"]*)?"/g;
const sharedKeys = {};   // asset rel path -> Map(key -> [pages])
const seenAssets = new Set();
let keyedJsCss = 0, checkedRefs = 0;

for (const rel of htmlFiles) {
  const txt = fs.readFileSync(path.join(ROOT, rel), "utf8");
  let m;
  while ((m = REF_RE.exec(txt))) {
    let url = m[1];
    if (!url || /^(https?:|data:|mailto:|tel:|blob:|\/\/)/.test(url)) continue;
    const [base, query] = url.split("?");
    const ext = path.extname(base).toLowerCase();
    if (![".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".json", ".woff", ".woff2", ".webmanifest"].includes(ext)) continue;
    if (base.startsWith("data/") || base.includes("/data/")) continue; // snapshot fetches: no-store by design
    const abs = path.normalize(path.join(path.dirname(path.join(ROOT, rel)), base));
    if (!abs.startsWith(ROOT)) continue;
    const assetRel = path.relative(ROOT, abs).replace(/\\/g, "/");
    seenAssets.add(assetRel);
    checkedRefs++;
    const params = new URLSearchParams(query || "");
    const key = params.get("v");
    if (ext === ".js" || ext === ".css") {
      check(`keyed ${ext} :: ${rel} -> ${url}`, !!key);
      if (key) keyedJsCss++;
    }
    check(`asset exists :: ${rel} -> ${assetRel}`, fs.existsSync(abs));
    if (assetRel.startsWith("assets/")) {
      if (!sharedKeys[assetRel]) sharedKeys[assetRel] = new Map();
      const pages = sharedKeys[assetRel].get(key || "(none)") || [];
      pages.push(rel);
      sharedKeys[assetRel].set(key || "(none)", pages);
    }
  }
}

for (const [asset, keyMap] of Object.entries(sharedKeys).sort()) {
  const keys = [...keyMap.keys()];
  check(`uniform key :: ${asset}`, keys.length === 1,
    keys.length === 1 ? `?v=${keys[0]} on ${[...keyMap.values()].reduce((n, p) => n + p.length, 0)} refs`
                      : "multiple keys: " + keys.map(k => `${k} (${keyMap.get(k).length} refs)`).join(", "));
  if (BASELINES[asset] && keys.length === 1 && keys[0] !== "(none)") {
    check(`fresh key :: ${asset} >= ${BASELINES[asset]}`, verGte(keys[0], BASELINES[asset]),
      `has ?v=${keys[0]}`);
  }
}
for (const [asset, baseline] of Object.entries(BASELINES)) {
  check(`shared asset referenced :: ${asset}`, !!sharedKeys[asset]);
}

console.log(`\nchecked ${htmlFiles.length} pages, ${checkedRefs} asset refs, ${keyedJsCss} keyed js/css loads`);
console.log(fails === 0 ? "ALL CACHE-KEY CHECKS PASSED" : fails + " CHECK(S) FAILED");
process.exit(fails === 0 ? 0 : 1);
