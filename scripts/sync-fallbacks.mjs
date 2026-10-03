#!/usr/bin/env node
/* Sync every app's dated static FALLBACK bundle to the current data/*.json
 * snapshots — the values each app paints when the snapshots can't load
 * (file://, offline). Before this script existed, every hourly run hand-edited
 * ~13 files across mining-calculator, luck-lab, energy-observatory, pool-desk,
 * mining-studio, consensus-lab and the hub — and history shows prior syncs
 * repeatedly MISSED sites (mining-studio's curSupply static, the calculator's
 * net-hint/stats-src labels, energy's provenance date), leaving stale figures
 * on the fallback path. This script derives every value from ONE capture —
 * data/consensus.json + data/supply.json, fetched seconds apart by the
 * fetch-*.mjs scripts — and rewrites every known site deterministically.
 *
 * Usage: run the fetch scripts first, then `node scripts/sync-fallbacks.mjs`.
 * Every rule must match EXACTLY ONCE in its file; if any rule fails, nothing
 * is written and the script exits 1 (a renamed field or restructured bundle
 * must be fixed in the open, never silently skipped). After a sync, run the
 * app test suites + tests/test-cache-keys.js and browser-QA the fallback path.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* ---------- derive every value from the two snapshots ---------- */
const cons = JSON.parse(read("data/consensus.json"));
const sup = JSON.parse(read("data/supply.json"));

const DIFF = cons.current.difficulty;                       // string, exact
const HEAD_C = cons.head;                                   // consensus head
const HEAD_S = sup.block_height;                            // supply height
const PLANCKS = sup.total_supply_plancks;                   // string, exact
const AVG_MS = cons.block_times_ms.avg_ms;
const FETCHED_AT = cons.fetched_at;                         // consensus capture time
const supQtc = Number(PLANCKS) / 1e12;
const rewardExact = (21000000 - supQtc) / 50000000;         // emission formula
const netHs = Math.floor(Number(DIFF) / 12);

const fmtInt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const d = new Date(FETCHED_AT);
const V = {
  DIFF, DIFF_FMT: fmtInt(Number(DIFF)),
  HEAD_C, HEAD_C_FMT: fmtInt(HEAD_C), HEAD_S, HEAD_S_FMT: fmtInt(HEAD_S),
  PLANCKS, AVG_MS,
  BPD: Math.round(86400000 / AVG_MS),
  PACE_1DP: (AVG_MS / 1000).toFixed(1),
  NETHS: netHs,
  THS_2DP: (netHs / 1e12).toFixed(2),
  THS_3DP: (netHs / 1e12).toFixed(3),
  GHS_INT: Math.round(netHs / 1e9), GHS_FMT: fmtInt(netHs / 1e9),
  SUP_4DP: supQtc.toFixed(4),
  SUP_4DP_FMT: fmtInt(Math.floor(supQtc)) + supQtc.toFixed(4).slice(supQtc.toFixed(4).indexOf(".")),
  SUP_INT: Math.round(supQtc), SUP_INT_FMT: fmtInt(supQtc),
  SUP_M_FMT: (supQtc / 1e6).toFixed(3),
  REWARD_7DP: rewardExact.toFixed(7),
  REWARD_4DP: rewardExact.toFixed(4),
  FETCHED_AT,
  DATE_ISO: FETCHED_AT.slice(0, 10),
  DATE_LONG: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
  CAPTURE_HHMM: `${FETCHED_AT.slice(11, 16)}Z`,
  SECS_APART: Math.round((Date.parse(sup.fetched_at) - Date.parse(FETCHED_AT)) / 1000),
  GROWTH_FMT: "+" + fmtInt(cons.difficulty.net_change_pct) + "%",
  // mining-calculator test-14 honesty band, re-derived like the manual syncs:
  // central = 500 MH/s share x observed pace x reward at this capture.
  HONEST_CENTRAL: (500e6 / netHs) * (86400000 / AVG_MS) * rewardExact,
};
V.HONEST_CENTRAL_4DP = V.HONEST_CENTRAL.toFixed(4);
V.HONEST_LOW = (Math.floor(V.HONEST_CENTRAL * 0.8 * 1000) / 1000).toFixed(3);
V.HONEST_HIGH = (Math.ceil(V.HONEST_CENTRAL * 1.25 * 1000) / 1000).toFixed(3);

if (!(HEAD_S - HEAD_C >= 0 && HEAD_S - HEAD_C <= 10)) {
  console.error(`snapshots are not one capture: consensus head ${HEAD_C}, supply height ${HEAD_S}`);
  process.exit(1);
}
if (V.SECS_APART < 0 || V.SECS_APART > 300) {
  console.error(`snapshot fetch times too far apart: ${V.SECS_APART}s`);
  process.exit(1);
}

/* ---------- version bumps (patch +1 on each changed JS bundle) ---------- */
function bumpedVersion(html, scriptRef) {
  const m = html.match(new RegExp(scriptRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\?v=(\\d+)\\.(\\d+)\\.(\\d+)"));
  if (!m) throw new Error(`no ?v= key for ${scriptRef}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
const mcHtml = read("pages/mining-calculator/index.html");
const luckHtml = read("pages/luck-lab/index.html");
const nrgHtml = read("pages/energy-observatory/index.html");
const poolHtml = read("pages/pool-desk/index.html");
const MC_VER = bumpedVersion(mcHtml, "app.js");
const LUCK_VER = bumpedVersion(luckHtml, "js/app.js");
const NRG_VER = bumpedVersion(nrgHtml, "js/app.js");
const POOL_VER = bumpedVersion(poolHtml, "js/app.js");

/* ---------- edit rules: [file, regex, replacement] — each must hit once --- */
const R = [];
const rule = (file, re, rep) => R.push({ file, re, rep });

/* mining-calculator/app.js — FALLBACK bundle + header comment */
rule("pages/mining-calculator/app.js",
  /\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\): consensus difficulty @[\d,]+ and total issuance\n \* @[\d,]+, fetched \d+ seconds apart/,
  `(${V.DATE_ISO} ${V.CAPTURE_HHMM}): consensus difficulty @${V.HEAD_C_FMT} and total issuance\n * @${V.HEAD_S_FMT}, fetched ${V.SECS_APART} seconds apart`);
rule("pages/mining-calculator/app.js",
  /difficulty: "\d+",( *)\/\/ data\/consensus\.json @[\d,]+/,
  `difficulty: "${V.DIFF}",$1// data/consensus.json @${V.HEAD_C_FMT}`);
rule("pages/mining-calculator/app.js",
  /netHs: \d+,/, `netHs: ${V.NETHS},`);
rule("pages/mining-calculator/app.js",
  /totalSupplyPlancks: "\d+",( *)\/\/ data\/supply\.json @[\d,]+/,
  `totalSupplyPlancks: "${V.PLANCKS}",$1// data/supply.json @${V.HEAD_S_FMT}`);
rule("pages/mining-calculator/app.js",
  /supplyQtc: [\d.]+,/, `supplyQtc: ${V.SUP_4DP},`);
rule("pages/mining-calculator/app.js",
  /avgBlockMs: \d+,/, `avgBlockMs: ${V.AVG_MS},`);
rule("pages/mining-calculator/app.js",
  /height: \d+,\n  fetchedAt: "[^"]+"/,
  `height: ${V.HEAD_C},\n  fetchedAt: "${V.FETCHED_AT}"`);

/* mining-calculator/index.html — painted defaults, hints, cache key */
rule("pages/mining-calculator/index.html",
  /id="in-net" type="number" min="0" step="any" value="[\d.]+"/,
  `id="in-net" type="number" min="0" step="any" value="${V.THS_3DP}"`);
rule("pages/mining-calculator/index.html",
  /chain snapshot \([A-Z][a-z]{2} \d{1,2}, \d{4}, block [\d,]+\): difficulty-implied network rate &asymp;[\d.]+ TH\/s/,
  `chain snapshot (${V.DATE_LONG}, block ${V.HEAD_C_FMT}): difficulty-implied network rate &asymp;${V.THS_2DP} TH/s`);
rule("pages/mining-calculator/index.html",
  /from the [A-Z][a-z]{2} \d{1,2}, \d{4} chain snapshot \([\d,]+ QTC/,
  `from the ${V.DATE_LONG} chain snapshot (${V.SUP_INT_FMT} QTC`);
rule("pages/mining-calculator/index.html",
  /dated fallback capture \([A-Z][a-z]{2} \d{1,2}, \d{4}, block [\d,]+\)/,
  `dated fallback capture (${V.DATE_LONG}, block ${V.HEAD_C_FMT})`);
rule("pages/mining-calculator/index.html",
  /app\.js\?v=[\d.]+/, `app.js?v=${MC_VER}`);

/* mining-calculator/tests/calc.test.js — pinned fallback expectations */
rule("pages/mining-calculator/tests/calc.test.js",
  /approx\(m\.blockReward\(F\.supplyQtc\), [\d.]+, 1e-7\)/,
  `approx(m.blockReward(F.supplyQtc), ${V.REWARD_7DP}, 1e-7)`);
rule("pages/mining-calculator/tests/calc.test.js",
  /assert\.strictEqual\(F\.height, \d+\)/,
  `assert.strictEqual(F.height, ${V.HEAD_C})`);
rule("pages/mining-calculator/tests/calc.test.js",
  /F\.fetchedAt\.indexOf\("\d{4}-\d{2}-\d{2}"\) === 0, "fallback is dated \d{4}-\d{2}-\d{2}"/,
  `F.fetchedAt.indexOf("${V.DATE_ISO}") === 0, "fallback is dated ${V.DATE_ISO}"`);
rule("pages/mining-calculator/tests/calc.test.js",
  /\/\/ 14\. Default-rig honesty: 500 MH\/s vs the fallback network ≈ [\d.]+ QTC\/day\n\/\/ \(band re-derived each fallback sync: share × observed pace × reward at the\n\/\/ @[\d,]+ capture = [\d.]+; it drifts down as the network grows\)/,
  `// 14. Default-rig honesty: 500 MH/s vs the fallback network ≈ ${V.HONEST_CENTRAL_4DP} QTC/day\n// (band re-derived each fallback sync: share × observed pace × reward at the\n// @${V.HEAD_C_FMT} capture = ${V.HONEST_CENTRAL_4DP}; it drifts down as the network grows)`);
rule("pages/mining-calculator/tests/calc.test.js",
  /e\.qtcPerDay > [\d.]+ && e\.qtcPerDay < [\d.]+, "expected ~[\d.]+ QTC\/day/,
  `e.qtcPerDay > ${V.HONEST_LOW} && e.qtcPerDay < ${V.HONEST_HIGH}, "expected ~${V.HONEST_CENTRAL_4DP} QTC/day`);
rule("pages/mining-calculator/tests/calc.test.js",
  /t\("index\.html carries the fallback defaults and v[\d.]+ key"/,
  `t("index.html carries the fallback defaults and v${MC_VER} key"`);
rule("pages/mining-calculator/tests/calc.test.js",
  /step=\"any\" value=\"[\d.]+\"/,
  `step=\"any\" value=\"${V.THS_3DP}\"`);
rule("pages/mining-calculator/tests/calc.test.js",
  /"app\.js\?v=[\d.]+"/, `"app.js?v=${MC_VER}"`);
rule("pages/mining-calculator/tests/calc.test.js",
  /"app\.js cache key bumped to [\d.]+"/,
  `"app.js cache key bumped to ${MC_VER}"`);

/* luck-lab/js/app.js — fallback state + comment */
rule("pages/luck-lab/js/app.js",
  /from the \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z snapshot refresh \(consensus @ block [\d,]+ \+\n  \/\/ supply @ block [\d,]+, fetched \d+ seconds apart\)/,
  `from the ${V.DATE_ISO} ${V.CAPTURE_HHMM} snapshot refresh (consensus @ block ${V.HEAD_C_FMT} +\n  // supply @ block ${V.HEAD_S_FMT}, fetched ${V.SECS_APART} seconds apart)`);
rule("pages/luck-lab/js/app.js",
  /difficulty: \d+,(\s*)\/\/ fallback: consensus snapshot \d{4}-\d{2}-\d{2}/,
  `difficulty: ${V.DIFF},$1// fallback: consensus snapshot ${V.DATE_ISO}`);
rule("pages/luck-lab/js/app.js",
  /netHs: \d+,/, `netHs: ${V.NETHS},`);
rule("pages/luck-lab/js/app.js",
  /reward: [\d.]+,(\s*)\/\/ fallback: \(21M − [\d,.]+ total supply\) \/ 50M, same capture/,
  `reward: ${V.REWARD_7DP},$1// fallback: (21M − ${V.SUP_4DP_FMT} total supply) / 50M, same capture`);
rule("pages/luck-lab/js/app.js",
  /blocksPerDay: \d+,/, `blocksPerDay: ${V.BPD},`);
rule("pages/luck-lab/js/app.js",
  /avgBlockMs: \d+,/, `avgBlockMs: ${V.AVG_MS},`);
rule("pages/luck-lab/js/app.js",
  /head: \d+,\n    fetchedAt: "[^"]+",/,
  `head: ${V.HEAD_C},\n    fetchedAt: "${V.FETCHED_AT}",`);
rule("pages/luck-lab/index.html",
  /js\/app\.js\?v=[\d.]+/, `js/app.js?v=${LUCK_VER}`);

/* energy-observatory/js/app.js — FALLBACK + provenance note */
rule("pages/energy-observatory/js/app.js",
  /difficulty: "\d+",/, `difficulty: "${V.DIFF}",`);
rule("pages/energy-observatory/js/app.js",
  /height: \d+,/, `height: ${V.HEAD_C},`);
rule("pages/energy-observatory/js/app.js",
  /\/\/ [\d,]+, fetched \d{4}-\d{2}-\d{2} — the SAME capture as the difficulty above\n  \/\/ \(@ block [\d,]+, \d+ seconds (earlier|apart); never mix snapshot dates in one bundle\)\./,
  `// ${V.HEAD_S_FMT}, fetched ${V.DATE_ISO} — the SAME capture as the difficulty above\n  // (@ block ${V.HEAD_C_FMT}, fetched ${V.SECS_APART} seconds apart; never mix snapshot dates in one bundle).`);
rule("pages/energy-observatory/js/app.js",
  /totalSupplyPlancks: "\d+",/, `totalSupplyPlancks: "${V.PLANCKS}",`);
rule("pages/energy-observatory/js/app.js",
  /last verified capture \([A-Z][a-z]{2} \d{1,2}, \d{4}\)/,
  `last verified capture (${V.DATE_LONG})`);
rule("pages/energy-observatory/index.html",
  /js\/app\.js\?v=[\d.]+/, `js/app.js?v=${NRG_VER}`);

/* pool-desk/js/app.js — NETWORK_DEFAULTS + comment */
rule("pages/pool-desk/js/app.js",
  /ONE capture \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\): consensus difficulty @[\d,]+ and total\n  \/\/ issuance @[\d,]+, \d+ seconds apart/,
  `ONE capture (${V.DATE_ISO} ${V.CAPTURE_HHMM}): consensus difficulty @${V.HEAD_C_FMT} and total\n  // issuance @${V.HEAD_S_FMT}, ${V.SECS_APART} seconds apart`);
rule("pages/pool-desk/js/app.js",
  /blockRewardQTC: [\d.]+, \/\/ emission formula: \(21M − [\d,.]+ total issuance\) \/ 50M, data\/supply\.json @\d+, \d{4}-\d{2}-\d{2}/,
  `blockRewardQTC: ${V.REWARD_7DP}, // emission formula: (21M − ${V.SUP_4DP_FMT} total issuance) / 50M, data/supply.json @${V.HEAD_S}, ${V.DATE_ISO}`);
rule("pages/pool-desk/js/app.js",
  /blockRewardLabel: "[^"]+",/,
  `blockRewardLabel: "${V.REWARD_4DP} QTC · emission formula @ height ${V.HEAD_S}, ${V.DATE_ISO}",`);
rule("pages/pool-desk/js/app.js",
  /netHashHS: \d+, \/\/ difficulty \d+ \/ 12s, data\/consensus\.json @\d+, \d{4}-\d{2}-\d{2}/,
  `netHashHS: ${V.NETHS}, // difficulty ${V.DIFF} / 12s, data/consensus.json @${V.HEAD_C}, ${V.DATE_ISO}`);
rule("pages/pool-desk/js/app.js",
  /netHashLabel: "[^"]+",/,
  `netHashLabel: "≈${V.THS_2DP} TH/s · from difficulty ${V.DIFF} @ height ${V.HEAD_C}, ${V.DATE_ISO}",`);
rule("pages/pool-desk/index.html",
  /js\/app\.js\?v=[\d.]+/, `js/app.js?v=${POOL_VER}`);

/* mining-studio/index.html — painted defaults (its app.js is untouched) */
rule("pages/mining-studio/index.html",
  /id="netHash" type="number" value="\d+"/,
  `id="netHash" type="number" value="${V.GHS_INT}"`);
rule("pages/mining-studio/index.html",
  /placeholder="snapshot: [\d,]+ GH\/s — or your estimate"/,
  `placeholder="snapshot: ${V.GHS_FMT} GH/s — or your estimate"`);
rule("pages/mining-studio/index.html",
  /id="curSupply" type="number" value="\d+"/,
  `id="curSupply" type="number" value="${V.SUP_INT}"`);
rule("pages/mining-studio/index.html",
  /network hashrate ≈[\d.]+ TH\/s from difficulty [\d,]+ and ~[\d.]+M total issuance, at block [\d,]+ on \d{4}-\d{2}-\d{2}/,
  `network hashrate ≈${V.THS_2DP} TH/s from difficulty ${V.DIFF_FMT} and ~${V.SUP_M_FMT}M total issuance, at block ${V.HEAD_C_FMT} on ${V.DATE_ISO}`);
rule("pages/mining-studio/index.html",
  /observed ~[\d.]+s block pace from the [A-Z][a-z]{2} \d{1,2}, \d{4} chain snapshot \(block [\d,]+\)/,
  `observed ~${V.PACE_1DP}s block pace from the ${V.DATE_LONG} chain snapshot (block ${V.HEAD_C_FMT})`);
rule("pages/mining-studio/tests/run.js",
  /\/[\d,]+\/\.test\(hintM\[1\]\) && Math\.abs\(Number\(nhVal\) - \d+ \/ 12 \/ 1e9\) < 1/,
  `/${V.DIFF_FMT}/.test(hintM[1]) && Math.abs(Number(nhVal) - ${V.DIFF} / 12 / 1e9) < 1`);

/* consensus-lab/index.html — simulator default = current difficulty */
rule("pages/consensus-lab/index.html",
  /id="simDiff" type="text" inputmode="numeric" value="\d+"/,
  `id="simDiff" type="text" inputmode="numeric" value="${V.DIFF}"`);

/* hub index.html — difficulty-growth claim on the Consensus Lab card */
rule("index.html",
  /\(\+[\d,]+% and counting\)/,
  `(${V.GROWTH_FMT} and counting)`);

/* ---------- validate all, then write all ---------- */
const byFile = new Map();
for (const { file, re, rep } of R) {
  if (!byFile.has(file)) byFile.set(file, read(file));
  const src = byFile.get(file);
  const hits = src.match(new RegExp(re.source, "g"));
  if (!hits || hits.length !== 1) {
    console.error(`ABORT: rule matched ${hits ? hits.length : 0}x (want 1) in ${file}: ${re}`);
    process.exit(1);
  }
  byFile.set(file, src.replace(re, rep));
}
for (const [file, content] of byFile) writeFileSync(join(ROOT, file), content);

console.log(`fallback sync @ capture ${V.DATE_ISO} ${V.CAPTURE_HHMM} (consensus ${V.HEAD_C_FMT} / supply ${V.HEAD_S_FMT}, ${V.SECS_APART}s apart)`);
console.log(`  difficulty ${V.DIFF} · netHs ${V.NETHS} (${V.THS_2DP} TH/s) · supply ${V.SUP_4DP} QTC · reward ${V.REWARD_7DP}`);
console.log(`  avgBlockMs ${V.AVG_MS} · blocks/day ${V.BPD} · hub growth ${V.GROWTH_FMT} · honesty ~${V.HONEST_CENTRAL_4DP} QTC/day (band ${V.HONEST_LOW}–${V.HONEST_HIGH})`);
console.log(`  versions: mining-calculator ${MC_VER}, luck-lab ${LUCK_VER}, energy-observatory ${NRG_VER}, pool-desk ${POOL_VER}`);
console.log(`  files written: ${[...byFile.keys()].join(", ")}`);
