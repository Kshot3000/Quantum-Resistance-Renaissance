#!/usr/bin/env node
/* Fetch Quantus mining-decentralization data from the public Subsquid indexer (server-side; no CORS).
 * Writes data/miners.json for same-origin consumption on GitHub Pages.
 * The indexer allowlists only explorer.quantus.com / quantus.com for browser CORS,
 * so community Pages apps must read a same-origin snapshot instead of calling sqm directly.
 *
 * Snapshot contents:
 *  - window: recent WINDOW_BLOCKS blocks (per-block coinbase = mined_by_id)
 *  - window_miners: {address: blockCount} aggregated over the window
 *  - buckets: 500-block buckets with per-miner counts (decentralization over time)
 *  - all_time: top-100 miners by mined-block count (indexer aggregate)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const WINDOW_BLOCKS = 15000;
const BUCKET_SIZE = 500;
const ALL_TIME_LIMIT = 100;
const PAGE = 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "miners.json");

async function gql(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);
      return json.data;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main() {
  const { s } = await gql(`query { s: chain_stats_by_pk(id: "global") { block_height } }`);
  const head = s.block_height;
  const start = head - WINDOW_BLOCKS + 1;

  const windowMiners = {};
  const buckets = [];
  let bucket = null;
  let firstTs = null, lastTs = null, fetched = 0;

  for (let lo = start; lo <= head; lo += PAGE) {
    const hi = Math.min(lo + PAGE - 1, head);
    const { block } = await gql(
      `query { block(limit: ${PAGE}, order_by: {height: asc}, where: {height: {_gte: ${lo}, _lte: ${hi}}}) { height timestamp mined_by_id } }`
    );
    for (const b of block) {
      fetched++;
      const addr = b.mined_by_id;
      windowMiners[addr] = (windowMiners[addr] || 0) + 1;
      if (!bucket || b.height > bucket.end) {
        const bs = Math.floor((b.height - start) / BUCKET_SIZE) * BUCKET_SIZE + start;
        bucket = { start: bs, end: bs + BUCKET_SIZE - 1, blocks: 0, miners: {} };
        buckets.push(bucket);
      }
      bucket.blocks++;
      bucket.miners[addr] = (bucket.miners[addr] || 0) + 1;
      if (firstTs === null) firstTs = b.timestamp;
      lastTs = b.timestamp;
    }
    process.stdout.write(`\rfetched ${fetched}/${WINDOW_BLOCKS}…`);
  }
  process.stdout.write("\n");

  const { account } = await gql(
    `query { account(limit: ${ALL_TIME_LIMIT}, order_by: {minedBlocks_aggregate: {count: desc}}) { id minedBlocks_aggregate { aggregate { count } } } }`
  );
  const allTime = account.map((a) => ({
    address: a.id,
    blocks: a.minedBlocks_aggregate.aggregate.count,
  }));

  const payload = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    chain_height: head,
    window: {
      start_height: start,
      end_height: head,
      block_count: fetched,
      observed_block_time_s:
        firstTs && lastTs && fetched > 1
          ? (new Date(lastTs) - new Date(firstTs)) / 1000 / (fetched - 1)
          : null,
    },
    window_miners: windowMiners,
    buckets: buckets.map((b) => ({
      start: b.start,
      end: Math.min(b.end, head),
      blocks: b.blocks,
      miners: b.miners,
    })),
    all_time: allTime,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload) + "\n");
  const distinct = Object.keys(windowMiners).length;
  const top = Object.entries(windowMiners).sort((a, b) => b[1] - a[1])[0];
  console.log(
    `wrote ${outPath} height=${head} window=${fetched} blocks distinct_miners=${distinct} ` +
      `top=${top[0].slice(0, 12)}… ${((top[1] / fetched) * 100).toFixed(1)}%`
  );
}

main().catch((e) => {
  console.error("fetch-miner-data failed:", e.message || e);
  process.exit(1);
});
