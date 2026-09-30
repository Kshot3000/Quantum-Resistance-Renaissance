#!/usr/bin/env node
/* Fetch the QTC Flow Tracer snapshot from the public Subsquid indexer.
 * Writes data/flows.json for same-origin consumption by the Flow Tracer app on
 * GitHub Pages (sqm.quantus.com only allows browser CORS from official Quantus
 * domains, so Pages apps read a same-origin snapshot; the app still attempts a
 * live GraphQL query first and falls back to this file).
 *
 * What the tracer needs:
 *  - recent: every transfer with block_height in [height-15000, height] and
 *    amount >= 1 QTC (1e12 planck) — the economically meaningful flow layer,
 *    excluding miner-reward dust and tiny spam.
 *  - whales: the 600 largest transfers of all time (captures the block-1
 *    genesis allocation and every historic whale move).
 * Rows carry id, amount, from_id, to_id, block_height, timestamp, fee,
 * extrinsic_id. Deduplicated by id.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const QTC = 10n ** 12n;
const WINDOW = 15000;
const DUST = QTC; // 1 QTC floor for the recent window
const WHALE_LIMIT = 600;
const PAGE = 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "flows.json");

async function gql(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.errors) throw new Error("GraphQL: " + JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

const FIELDS = "id amount from_id to_id block_height timestamp fee extrinsic_id";

async function main() {
  const { status } = await gql(`{ status: chain_stats_by_pk(id: "global") { block_height } }`);
  const height = status.block_height;
  const from = height - WINDOW;

  // 1) Recent economically-meaningful transfers, paginated.
  const recent = [];
  let offset = 0;
  for (;;) {
    const d = await gql(`{ transfer(where: { block_height: { _gte: ${from} }, amount: { _gte: "${DUST}" } }, order_by: { block_height: desc }, limit: ${PAGE}, offset: ${offset}) { ${FIELDS} } }`);
    recent.push(...d.transfer);
    if (d.transfer.length < PAGE) break;
    offset += PAGE;
    if (offset > 40000) throw new Error("page guard tripped");
  }

  // 2) All-time largest transfers.
  const w = await gql(`{ transfer(order_by: { amount: desc }, limit: ${WHALE_LIMIT}) { ${FIELDS} } }`);

  // 3) Merge + dedupe.
  const seen = new Set();
  const rows = [];
  for (const r of [...w.transfer, ...recent]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
  }

  // 4) The full block-1 genesis allocation (22 transfers). The all-time top-600
  //    only caught the largest one; the genesis set is the root of every flow on
  //    the chain, so it is merged from the supply-audit snapshot (same indexer).
  //    Synthetic ids are namespaced to avoid colliding with indexer ids.
  let genesisCount = 0;
  try {
    const supply = JSON.parse(readFileSync(join(__dirname, "..", "data", "supply.json"), "utf8"));
    const list = supply?.genesis?.transfers ?? [];
    list.forEach((g, i) => {
      const id = `genesis-${i}`;
      if (seen.has(id)) return;
      seen.add(id);
      genesisCount++;
      rows.push({
        id, amount: g.amount_plancks, from_id: g.from, to_id: g.to,
        block_height: 1, timestamp: null, fee: "0", extrinsic_id: null,
      });
    });
  } catch { /* supply snapshot absent — flow data still valid */ }
  rows.sort((a, b) => b.block_height - a.block_height || (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    meta: {
      captured_at: new Date().toISOString(),
      chain_height: height,
      window_from: from,
      window_blocks: WINDOW,
      dust_threshold_planck: DUST.toString(),
      dust_threshold_qtc: "1",
      genesis_rows: genesisCount,
      genesis_source: "data/supply.json (same Subsquid indexer)",
      transfers: rows.length,
      source: "sqm.quantus.com/v1/graphql",
    },
    transfers: rows,
  }));
  console.log(`flows.json: ${rows.length} transfers (recent>=1QTC: ${recent.length}, whales: ${w.transfer.length}), height ${height}`);
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
