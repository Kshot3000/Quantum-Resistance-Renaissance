/* QTC SafeSend Lab — Node test harness.
 * Run: node tests/run-tests.mjs
 * 1. SHA-256 sanity (FIPS 180-4 test vector).
 * 2. All 1,171 upstream checkphrase test vectors against js/checkphrase-core.js.
 * 3. Reversible-transfer delay math (block <-> wall-clock conversions, min-delay validation).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = require(join(root, "js", "checkphrase-core.js"));
const WORDS = require(join(root, "js", "wordlist.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name, extra || ""); }
}
function hex(u8) { return Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join(""); }

/* --- 1. SHA-256 sanity --- */
const abc = new TextEncoder().encode("abc");
ok("sha256('abc')",
  hex(CHECK.sha256Bytes(abc)) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

/* --- 2. upstream vectors --- */
const vectors = JSON.parse(readFileSync("/tmp/qcp/test-vectors/checksums.json", "utf8"));
ok("vector file version", vectors.version === "1.0");
ok("wordlist length", WORDS.length === 2048);
const cases = vectors.testCases;
let vecFail = 0;
const t0 = Date.now();
for (const tc of cases) {
  const got = CHECK.addressToChecksum(tc.address, WORDS);
  if (JSON.stringify(got) !== JSON.stringify(tc.expected)) {
    vecFail++;
    if (vecFail <= 5) {
      console.log("VECTOR FAIL:", tc.description, tc.address);
      console.log("  expected:", JSON.stringify(tc.expected));
      console.log("  got:     ", JSON.stringify(got));
    }
  }
}
console.log(`checkphrase vectors: ${cases.length - vecFail}/${cases.length} pass (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
ok("all 1171 upstream vectors", vecFail === 0);
ok("poisoned address differs", JSON.stringify(
  CHECK.addressToChecksum("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", WORDS)) !== JSON.stringify(
  CHECK.addressToChecksum("1A1zP1eP5QGefi2DMPTfTL5SLmv7DixfNa", WORDS)));
ok("deterministic", JSON.stringify(
  CHECK.addressToChecksum("qzka7DZXAT7GnzgXQfxiSwrPKRWgW6m6G89QRsQiLThThZ6Cw", WORDS)) === JSON.stringify(
  CHECK.addressToChecksum("qzka7DZXAT7GnzgXQfxiSwrPKRWgW6m6G89QRsQiLThThZ6Cw", WORDS)));
/* Kyle's donation address — its checkphrase is printed for the app's verified example */
const kyleAddr = "qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau";
const kylePhrase = CHECK.addressToChecksum(kyleAddr, WORDS);
console.log("KYLE_ADDR_CHECKPHRASE:", kyleAddr, "=>", kylePhrase.join("-"));

/* --- 3. delay math (mirrors js/app.js constants) --- */
const BLOCK_MS = 12000, MIN_DELAY_BLOCKS = 2, DEFAULT_DELAY_BLOCKS = 7200;
function blocksToMs(b) { return b * BLOCK_MS; }
function msToBlocks(ms) { return Math.ceil(ms / BLOCK_MS); }
function validateDelay(b) {
  if (!Number.isInteger(b)) return "Delay must be a whole number of blocks.";
  if (b < MIN_DELAY_BLOCKS) return "Delay below the runtime minimum of 2 blocks.";
  return null;
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return s + "s";
  const m = Math.round(s / 60);
  if (m < 90) return m + " min";
  const h = Math.round(m / 60);
  if (h < 48) return h + " h";
  return Math.round(h / 24) + " d";
}
ok("10min preset = 50 blocks", msToBlocks(10 * 60 * 1000) === 50);
ok("1h preset = 300 blocks", msToBlocks(3600 * 1000) === 300);
ok("24h default = 7200 blocks", msToBlocks(24 * 3600 * 1000) === DEFAULT_DELAY_BLOCKS);
ok("7d preset = 50400 blocks", msToBlocks(7 * 24 * 3600 * 1000) === 50400);
ok("min delay 2 blocks valid", validateDelay(2) === null);
ok("1 block rejected", validateDelay(1) !== null);
ok("non-integer rejected", validateDelay(2.5) !== null);
ok("7200 blocks formats as ~24 h", fmtDuration(blocksToMs(7200)) === "24 h");
ok("50 blocks formats as 10 min", fmtDuration(blocksToMs(50)) === "10 min");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
