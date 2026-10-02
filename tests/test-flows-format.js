/* QTC Quantus-Muse-Builder — flows.json format guard. Run: node tests/test-flows-format.js
 *
 * Guards two bug classes found 2026-10-02:
 *  1. Envelope drift: flows.json was the ONLY snapshot without the fleet-
 *     standard `ok: true`, and portfolio-desk's snapshot picker requires it —
 *     its transfer index silently stayed empty on every load (0 transfers,
 *     empty activity panel) while every other app read the file fine.
 *  2. Format drift: flows.json is stored columnar (v2, assets/flows-decode.js)
 *     to halve the fleet's heaviest download. If the producer regresses to
 *     v1 object rows, or a consumer stops decoding, flow-tracer / watchtower /
 *     portfolio-desk / ledger-desk break in four different silent ways.
 *
 * The checks below pin: the envelope, the v2 shape, a lossless decode of the
 * REAL snapshot (counts, BigInt totals, field types, genesis rows), the
 * size budget, producer wiring, and consumer wiring.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const QFlows = require(path.join(ROOT, "assets", "flows-decode.js"));

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? " :: " + extra : ""));
  if (!cond) fails++;
}

/* ---- codec unit behaviour ---- */
const synth = [
  { id: "0000000001-aaaaa-000001", amount: "2140000000000", from_id: "qzAAA", to_id: "qzBBB", block_height: 42, timestamp: "2026-10-02T00:00:00.000+00:00", fee: "803402500", extrinsic_id: "0xabc" },
  { id: "genesis-0", amount: "5000000000000", from_id: "qzBBB", to_id: "qzAAA", block_height: 1, timestamp: null, fee: "0", extrinsic_id: null },
  { id: "0000000002-bbbbb-000002", amount: "1000000000000", from_id: "qzAAA", to_id: "qzAAA", block_height: 43, timestamp: "2026-10-02T00:01:00.000+00:00", fee: "803402500", extrinsic_id: "0xdef" },
];
const enc = QFlows.encode(synth, { transfers: synth.length, source: "test" });
check("encode emits ok envelope", enc.ok === true);
check("encode marks format 2", enc.meta.format === 2 && QFlows.isV2(enc));
check("encode dictionaries dedupe", enc.addresses.length === 2 && enc.fees.length === 2,
  enc.addresses.length + " addrs, " + enc.fees.length + " fees for 3 rows");
const dec = QFlows.decode(JSON.parse(JSON.stringify(enc)));
check("round-trip is lossless", JSON.stringify(dec.transfers) === JSON.stringify(synth.map(r => ({
  id: String(r.id), amount: String(r.amount), from_id: r.from_id, to_id: r.to_id,
  block_height: r.block_height, timestamp: r.timestamp || null,
  fee: String(r.fee), extrinsic_id: r.extrinsic_id || null,
}))), "all 8 fields, in order");
const v1 = { meta: { transfers: 1 }, transfers: [synth[0]] };
check("decode passes v1 object rows through", QFlows.decode(v1) === v1);
check("decode tolerates junk", QFlows.decode(null) === null && QFlows.decode({}) !== undefined);

/* ---- the real snapshot ---- */
const file = path.join(ROOT, "data", "flows.json");
const raw = fs.readFileSync(file, "utf8");
const snap = JSON.parse(raw);
check("snapshot carries ok:true envelope (portfolio pickSnap regression)", snap.ok === true);
check("snapshot is format v2", snap.meta && snap.meta.format === 2 && QFlows.isV2(snap),
  "format=" + (snap.meta && snap.meta.format));
check("snapshot meta count matches rows", snap.meta.transfers === snap.transfers.length,
  snap.transfers.length + " rows @ height " + snap.meta.chain_height);
const bytesPerRow = raw.length / snap.transfers.length;
check("size budget <= 210 bytes/row (v1 was ~344)", bytesPerRow <= 210, bytesPerRow.toFixed(1) + " B/row, " + raw.length + " bytes total");

const out = QFlows.decode(snap);
check("decode restores object rows", out.transfers.every(r => r && typeof r === "object" && !Array.isArray(r)));
let total = 0n, fieldsOk = true, genesis = 0, synthGenesis = 0;
for (const r of out.transfers) {
  total += BigInt(r.amount);
  if (typeof r.id !== "string" || typeof r.amount !== "string" ||
      typeof r.from_id !== "string" || !r.from_id.startsWith("qz") ||
      typeof r.to_id !== "string" || !r.to_id.startsWith("qz") ||
      !Number.isInteger(r.block_height) || r.block_height < 1 ||
      !(r.timestamp === null || typeof r.timestamp === "string") ||
      typeof r.fee !== "string" || !/^\d+$/.test(r.fee) ||
      !(r.extrinsic_id === null || typeof r.extrinsic_id === "string")) fieldsOk = false;
  if (r.block_height === 1) genesis++;
  if (String(r.id).startsWith("genesis-")) synthGenesis++;
}
check("every decoded row has all 8 v1 fields, correctly typed", fieldsOk);
// Block 1 holds the 22 synthetic genesis rows PLUS the largest allocation,
// which is also a real indexer row inside the all-time top-600.
check("genesis rows survive (synthetic set complete per meta)", synthGenesis === snap.meta.genesis_rows && genesis >= snap.meta.genesis_rows,
  synthGenesis + " synthetic + " + (genesis - synthGenesis) + " real at block 1");
let colTotal = 0n;
for (const r of snap.transfers) colTotal += BigInt(r[1]);
check("decoded BigInt total equals column total", total === colTotal, total.toString() + " plancks");
// The portfolio regression, expressed directly: an ok-gated picker plus a
// shape check must both accept the decoded snapshot, and indexing by
// address must find real activity.
check("portfolio-style pickSnap accepts decoded snapshot", !!(out && out.ok) && Array.isArray(out.transfers));
const byAddr = new Map();
for (const r of out.transfers) { byAddr.set(r.from_id, 1); byAddr.set(r.to_id, 1); }
check("decoded snapshot indexes > 500 distinct addresses", byAddr.size > 500, byAddr.size + " addresses");

/* ---- producer wiring ---- */
const prod = fs.readFileSync(path.join(ROOT, "scripts", "fetch-flow-data.mjs"), "utf8");
check("producer encodes via the shared codec", prod.includes("flows-decode.js") && prod.includes("QFlows.encode"));
check("producer round-trip self-checks before writing", prod.includes("codec round-trip"));

/* ---- consumer wiring ---- */
const CONSUMERS = [
  ["pages/flow-tracer/index.html", "pages/flow-tracer/app.js"],
  ["pages/watchtower/index.html", "pages/watchtower/js/app.js"],
  ["pages/portfolio-desk/index.html", "pages/portfolio-desk/js/app.js"],
  ["pages/ledger-desk/index.html", "pages/ledger-desk/app.js"],
];
for (const [html, js] of CONSUMERS) {
  const h = fs.readFileSync(path.join(ROOT, html), "utf8");
  const j = fs.readFileSync(path.join(ROOT, js), "utf8");
  check(`consumer loads codec :: ${html}`, h.includes("assets/flows-decode.js?v="));
  check(`consumer decodes flows :: ${js}`, /QFlows\.decode/.test(j));
}
const port = fs.readFileSync(path.join(ROOT, "pages/portfolio-desk/js/app.js"), "utf8");
check("portfolio pickSnap has the by-shape flows fallback", /pickSnap\("flows", bundle\.flows\) \|\|/.test(port));

console.log(fails === 0 ? "\nALL FLOWS-FORMAT CHECKS PASSED" : "\n" + fails + " CHECK(S) FAILED");
process.exitCode = fails ? 1 : 0;
