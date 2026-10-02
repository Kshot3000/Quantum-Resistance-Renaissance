#!/usr/bin/env node
/* Fetch Quantus supply-audit snapshot from the public Subsquid indexer.
 * Writes data/supply.json for same-origin consumption by the Supply Audit app on
 * GitHub Pages (sqm.quantus.com only allows browser CORS from official Quantus
 * domains, so Pages apps read a same-origin snapshot instead of calling GraphQL
 * directly; the app still attempts a live query first and falls back to this file).
 *
 * What the audit needs (all planck strings; 1 QTC = 1e12 planck):
 *  - genesis: EVERY transfer at block_height = 1 (the genesis allocation; an
 *    earlier script used limit:3 and truncated it — there are 22).
 *  - mined: miner_reward aggregate (count + sum) = every block reward actually
 *    minted by pallet_mining_rewards (MinerRewarded events).
 *  - balances: account aggregate sums (free/reserved/frozen) = the indexer's
 *    reported total supply.
 *  - vesting: schedule aggregate (count, total, claimed).
 *  - mint_sentinel: the canonical minting account (AccountId [1u8;32]) — its
 *    balance plus every transfer OUT of it (genesis allocation + per-block
 *    reward transfer proofs + wormhole exit proofs). The sentinel is pinned at
 *    0 on the indexer while ~2x the recorded rewards flowed out of it, which
 *    is the core evidence for the audit's reconciliation finding.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";
// Canonical minting account: runtime/src/configs/mod.rs
// `pub const MintingAccount: AccountId = AccountId::new([1u8; 32]);`
// SS58-189 encoding of 0x0101...01, as seen on the block-1 transfers.
const MINT_SENTINEL = "qzjUYyuN4L3HKmBPMxHvK2n8HYnaLZcQvLSQTgdwB2nQ1g2mc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "supply.json");

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
  const core = await gql(`query {
    status: chain_stats_by_pk(id: "global") { block_height total_accounts }
    totals: account_aggregate { aggregate { count sum { free reserved frozen } } }
    mined: miner_reward_aggregate { aggregate { count sum { reward } } }
    vestAgg: vesting_schedule_aggregate { aggregate { count sum { total claimed } } }
    genesis: transfer(where: { block_height: { _eq: 1 } }, order_by: { amount: desc }, limit: 100) {
      amount from_id to_id
    }
    mintAcct: account_by_pk(id: "${MINT_SENTINEL}") { id free reserved frozen }
    mintOut: transfer_aggregate(where: { from_id: { _eq: "${MINT_SENTINEL}" } }) {
      aggregate { count sum { amount } }
    }
    mintOutRecent: transfer_aggregate(where: { from_id: { _eq: "${MINT_SENTINEL}" }, block_height: { _gt: 1 } }) {
      aggregate { count sum { amount } }
    }
  }`);

  // Vesting pool = recipient of the largest block-1 transfer (the 5.66994M QTC
  // genesis vesting allocation). Its free balance must equal
  // (vesting_total - vesting_claimed) to the planck.
  const poolId = core.genesis.length ? core.genesis[0].to_id : null;
  let poolFree = null;
  if (poolId) {
    const p = await gql(`query { account_by_pk(id: "${poolId}") { id free } }`);
    poolFree = p.account_by_pk ? p.account_by_pk.free : null;
  }

  const snapshot = {
    ok: true,
    source: ENDPOINT,
    fetched_at: new Date().toISOString(),
    block_height: core.status.block_height,
    accounts_total: core.totals.aggregate.count,
    mint_sentinel_id: MINT_SENTINEL,
    genesis: {
      count: core.genesis.length,
      total_plancks: core.genesis
        .reduce((a, t) => a + BigInt(t.amount), 0n)
        .toString(),
      transfers: core.genesis.map((t) => ({
        amount_plancks: t.amount,
        from: t.from_id,
        to: t.to_id,
      })),
    },
    mined: {
      reward_events: core.mined.aggregate.count,
      total_plancks: core.mined.aggregate.sum.reward,
    },
    balances_plancks: {
      free: core.totals.aggregate.sum.free,
      reserved: core.totals.aggregate.sum.reserved,
      frozen: core.totals.aggregate.sum.frozen,
    },
    // Total issuance = free + reserved + frozen. This is `Currency::total_issuance()`
    // for the mining-rewards emission formula R = (MaxSupply − total_issuance) / 50M —
    // NOT mined rewards alone (genesis endowments count toward issuance).
    total_supply_plancks: (
      BigInt(core.totals.aggregate.sum.free) +
      BigInt(core.totals.aggregate.sum.reserved) +
      BigInt(core.totals.aggregate.sum.frozen)
    ).toString(),
    vesting: {
      schedules: core.vestAgg.aggregate.count,
      total_plancks: core.vestAgg.aggregate.sum.total,
      claimed_plancks: core.vestAgg.aggregate.sum.claimed,
      pool_account: poolId,
      pool_free_plancks: poolFree,
    },
    mint_sentinel: {
      free_plancks: core.mintAcct ? core.mintAcct.free : "0",
      out_count: core.mintOut.aggregate.count,
      out_total_plancks: core.mintOut.aggregate.sum.amount,
      out_nongenesis_count: core.mintOutRecent.aggregate.count,
      out_nongenesis_plancks: core.mintOutRecent.aggregate.sum.amount,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
  console.log("wrote", OUT, "height", snapshot.block_height);
}

main().catch((e) => {
  console.error("fetch-supply-data failed:", e.message);
  process.exit(1);
});
