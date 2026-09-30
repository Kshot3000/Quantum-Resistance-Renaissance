#!/usr/bin/env node
/* Fetch Quantus whale/supply-concentration snapshot from the public Subsquid indexer.
 * Writes data/whales.json for same-origin consumption by the Whale Watch app on GitHub Pages
 * (sqm.quantus.com only allows browser CORS from explorer.quantus.com / quantus.com,
 * so Pages apps must read a same-origin snapshot instead of calling GraphQL directly).
 *
 * Units: balances/rewards/amounts are planck strings; 1 QTC = 1e12 planck (verified
 * against the runtime emission formula and the Emission Lab's constants).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
const TOP_N = 200;
const RECENT_DAYS = 7;
const RECENT_MIN_PLANCKS = "10000000000000"; // 10 QTC
const ALLTIME_N = 40;
const RECENT_N = 40;

const BRACKETS = [
  { key: "whale",   label: "Whales ≥ 1,000 QTC",   min: "1000000000000000", max: null },
  { key: "shark",   label: "Sharks 100 – 1,000",   min: "100000000000000",  max: "1000000000000000" },
  { key: "dolphin", label: "Dolphins 10 – 100",    min: "10000000000000",   max: "100000000000000" },
  { key: "fish",    label: "Fish 1 – 10",          min: "1000000000000",    max: "10000000000000" },
  { key: "shrimp",  label: "Shrimp 0.1 – 1",       min: "100000000000",     max: "1000000000000" },
  { key: "dust",    label: "Dust < 0.1",           min: null,               max: "100000000000" },
];

function bracketWhere(b) {
  const conds = [];
  if (b.min) conds.push(`{free:{_gte:"${b.min}"}}`);
  if (b.max) conds.push(`{free:{_lt:"${b.max}"}}`);
  if (conds.length === 0) return "";
  if (conds.length === 1) return `(where:${conds[0]})`;
  return `(where:{_and:[${conds.join(",")}]})`;
}

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

async function main() {
  const weekAgo = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();

  const bracketQueries = BRACKETS.map(
    (b, i) => `b${i}: account_aggregate${bracketWhere(b)} { aggregate { count sum { free } } }`
  ).join("\n");

  const core = await gql(`query {
    status: chain_stats_by_pk(id: "global") { block_height total_accounts }
    totals: account_aggregate { aggregate { count sum { free reserved frozen } } }
    mined: miner_reward_aggregate { aggregate { sum { reward } } }
    txc: transfer_aggregate { aggregate { count } }
    top: account(order_by:{free:desc}, limit:${TOP_N}) {
      id free reserved frozen is_guardian is_multisig is_high_security
    }
    ${bracketQueries}
    vest: vesting_schedule(limit:100) { id beneficiary total claimed }
    vestAgg: vesting_schedule_aggregate { aggregate { count sum { total claimed } } }
    genesis: transfer(where:{block_height:{_eq:1}}, order_by:{amount:desc}, limit:3) {
      amount from_id to_id block_height timestamp
    }
    bigAll: transfer(order_by:{amount:desc}, limit:${ALLTIME_N}) {
      amount fee from_id to_id block_height timestamp
    }
    bigRecent: transfer(where:{amount:{_gte:"${RECENT_MIN_PLANCKS}"}, timestamp:{_gte:"${weekAgo}"}}, order_by:{timestamp:desc}, limit:${RECENT_N}) {
      amount fee from_id to_id block_height timestamp
    }
  }`);

  // Miner blocks mined per top account (nested aggregate; best-effort — tag is informational).
  let minerCounts = {};
  try {
    const ids = core.top.map((a) => `"${a.id}"`);
    const mc = await gql(`query {
      accts: account(where:{id:{_in:[${ids.join(",")}]}}) {
        id mined: minedBlocks_aggregate { aggregate { count } }
      }
    }`);
    for (const a of mc.accts) minerCounts[a.id] = a.mined.aggregate.count;
  } catch (e) {
    console.warn("miner block counts unavailable:", e.message);
  }

  // Vesting: unclaimed tokens sit in the genesis vesting-pool account (the block-1
  // recipient), NOT in beneficiary accounts — beneficiary accounts hold only claimed QTC.
  // The pool account's free balance equals (vesting_total - vesting_claimed) to the planck.
  const vestTotal = BigInt(core.vestAgg.aggregate.sum.total);
  const vestClaimed = BigInt(core.vestAgg.aggregate.sum.claimed);
  const vestUnclaimed = vestTotal - vestClaimed;
  const genesisRecipient = core.genesis[0] ? core.genesis[0].to_id : null;

  const top = core.top.map((a, i) => {
    const free = BigInt(a.free);
    const isVestingPool =
      a.id === genesisRecipient ||
      (free - vestUnclaimed >= -1000000000000n && free - vestUnclaimed <= 1000000000000n);
    const lockedInPool = isVestingPool ? vestUnclaimed : 0n;
    return {
      rank: i + 1,
      address: a.id,
      free_plancks: a.free,
      reserved_plancks: a.reserved,
      frozen_plancks: a.frozen,
      locked_plancks: lockedInPool.toString(),
      liquid_plancks: (free - lockedInPool).toString(),
      is_vesting_pool: isVestingPool,
      is_genesis_recipient: a.id === genesisRecipient,
      is_guardian: a.is_guardian,
      is_multisig: a.is_multisig,
      is_high_security: a.is_high_security,
      blocks_mined: minerCounts[a.id] ?? null,
    };
  });

  const snapshot = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    block_height: core.status.block_height,
    accounts_total: core.totals.aggregate.count,
    supply_plancks: {
      free: core.totals.aggregate.sum.free,
      reserved: core.totals.aggregate.sum.reserved,
      frozen: core.totals.aggregate.sum.frozen,
    },
    mined_plancks: core.mined.aggregate.sum.reward,
    transfers_total: core.txc.aggregate.count,
    vesting: {
      schedules: core.vestAgg.aggregate.count,
      total_plancks: core.vestAgg.aggregate.sum.total,
      claimed_plancks: core.vestAgg.aggregate.sum.claimed,
    },
    genesis_allocation: core.genesis.map((t) => ({
      amount_plancks: t.amount,
      from: t.from_id,
      to: t.to_id,
      block_height: t.block_height,
      timestamp: t.timestamp,
    })),
    brackets: BRACKETS.map((b, i) => ({
      key: b.key,
      label: b.label,
      count: core[`b${i}`].aggregate.count,
      sum_plancks: core[`b${i}`].aggregate.sum.free,
    })),
    top,
    whale_moves_alltime: core.bigAll,
    whale_moves_recent: core.bigRecent,
    params: { top_n: TOP_N, recent_days: RECENT_DAYS, recent_min_qtc: 10, plancks_per_qtc: 1e12 },
  };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, "..", "data", "whales.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    "wrote", outPath,
    "height=", snapshot.block_height,
    "accounts=", snapshot.accounts_total,
    "top1=", (Number(BigInt(top[0].free_plancks)) / 1e12).toFixed(3), "QTC"
  );
}

main().catch((e) => {
  console.error("fetch-whale-data failed:", e.message || e);
  process.exit(1);
});
