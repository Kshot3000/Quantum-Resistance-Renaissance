#!/usr/bin/env node
/* Fetch Quantus chain telemetry from the public Subsquid indexer (server-side; no CORS).
 * Writes data/live.json for same-origin consumption on GitHub Pages.
 * The indexer allowlists only explorer.quantus.com / quantus.com for browser CORS,
 * so community Pages apps must read a same-origin snapshot instead of calling sqm directly.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const QUERY = `query {
  status: chain_stats_by_pk(id: "global") {
    block_height total_accounts total_immediate_transfers total_scheduled_transfers
  }
  blocks: block(limit: 15, order_by: {height: desc}) {
    height hash timestamp reward
  }
  daily: daily_chain_stats(order_by: {date: desc}, limit: 14) {
    date blocks_count tx_count active_accounts
  }
}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "live.json");

async function main() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  const payload = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    data: json.data,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  const h = json.data?.status?.block_height;
  console.log("wrote", outPath, "height=", h, "at", payload.fetched_at);
}

main().catch((e) => {
  console.error("fetch-chain-data failed:", e.message || e);
  process.exit(1);
});
