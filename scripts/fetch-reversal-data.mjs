#!/usr/bin/env node
/* Fetch reversible-transfer telemetry from the public Subsquid indexer (server-side; no CORS).
 * Writes data/reversal.json for same-origin consumption on GitHub Pages.
 * The indexer allowlists only explorer.quantus.com / quantus.com for browser CORS,
 * so community Pages apps must read a same-origin snapshot instead of calling sqm directly.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const QUERY = `query {
  status: chain_stats_by_pk(id: "global") {
    block_height total_scheduled_transfers
  }
  scheduled: scheduled_reversible_transfer(limit: 25, order_by: {timestamp: desc}) {
    tx_id amount fee timestamp from_id to_id
  }
  cancelled: cancelled_reversible_transfer(limit: 25, order_by: {timestamp: desc}) {
    tx_id timestamp cancelled_by_id
  }
  executed: executed_reversible_transfer(limit: 25, order_by: {timestamp: desc}) {
    tx_id timestamp result
  }
  hs: high_security_set(limit: 25, order_by: {timestamp: desc}) {
    who_id guardian_id delay timestamp
  }
  sAgg: scheduled_reversible_transfer_aggregate { aggregate { count } }
  cAgg: cancelled_reversible_transfer_aggregate { aggregate { count } }
  eAgg: executed_reversible_transfer_aggregate { aggregate { count } }
  hAgg: high_security_set_aggregate { aggregate { count } }
}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "reversal.json");

async function main() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  const d = json.data || {};
  const payload = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    data: {
      status: d.status || null,
      scheduled: d.scheduled || [],
      cancelled: d.cancelled || [],
      executed: d.executed || [],
      high_security: d.hs || [],
      totals: {
        scheduled: d.sAgg?.aggregate?.count ?? null,
        cancelled: d.cAgg?.aggregate?.count ?? null,
        executed: d.eAgg?.aggregate?.count ?? null,
        high_security: d.hAgg?.aggregate?.count ?? null,
      },
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    "wrote",
    outPath,
    "height=" + (d.status?.block_height ?? "?"),
    "scheduled=" + payload.data.totals.scheduled,
    "at",
    payload.fetched_at
  );
}

main().catch((e) => {
  console.error("fetch-reversal-data failed:", e.message || e);
  process.exit(1);
});
