#!/usr/bin/env node
/* Fetch Quantus vesting-schedule data from the public Subsquid indexer.
 * Writes data/vesting.json for same-origin consumption by the Vesting Desk on
 * GitHub Pages (sqm.quantus.com only allows browser CORS from
 * explorer.quantus.com / quantus.com, so Pages apps read a same-origin
 * snapshot instead of calling GraphQL directly).
 *
 * Semantics verified 2026-09-30 from Quantus-Network/chain (fresh clone):
 * - pallets/vesting/src/lib.rs: linear accrual start->end, nothing claimable
 *   before cliff; vested(now) = 0 if now<cliff, total if now>=end,
 *   else floor(total*(now-start)/(end-start)). Times are ms since unix epoch.
 * - Non-final claims pay down to multiples of NON_FINAL_PAYOUT_QUANTA(2500) x
 *   PayoutQuantum(0.01 QTC) = 25 QTC chunks; exact final claim pays the rest.
 * - MinClaimInterval = MILLIS_PER_DAY; claim is permissionless (pallet 22,
 *   call 0 = Vesting.claim(schedule_id)).
 * - runtime/src/genesis_config_presets/mainnet_vesting.rs: 27% TGE mint
 *   (5,670,000 QTC); grants lock 365 days then vest 3 years (cliff == start,
 *   nothing unlocks as a lump); intents grant (id 45) 42,000 QTC over 365
 *   days from TGE; treasury initial liquidity (id 46) 210,000 QTC over 16 days.
 *   TGE = block-1 first non-zero timestamp = 1788943917807 (2026-09-09 08:51 UTC).
 *
 * Units: total/claimed are planck strings; 1 QTC = 1e12 planck.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";

const QUERY = `query {
  schedules: vesting_schedule(limit: 64, order_by: {id: asc}) {
    id beneficiary total claimed cliff start end last_claim_at block_height
  }
  chain: chain_stats_by_pk(id: "global") { block_height }
}`;

const COHORTS = {
  GRANT: {
    key: "grant",
    label: "Genesis grants (team / partners / treasury)",
    start: "1820479917807",
    end: "1915087917807",
    note: "1-year lockup from TGE (2026-09-09), then linear vesting over 3 years to 2030-09-08. cliff == start: nothing unlocks as a lump.",
  },
  INTENTS: {
    key: "intents",
    label: "Intents grant (id 45)",
    start: "1788943917807",
    end: "1820479917807",
    note: "Vests from TGE over 365 days to 2027-09-09.",
  },
  LIQUIDITY: {
    key: "liquidity",
    label: "Treasury initial liquidity (id 46)",
    start: "1788943917807",
    end: "1790326317807",
    note: "Vested over 16 days from TGE; fully vested since 2026-09-25.",
  },
};

function cohortOf(s) {
  if (s.start === COHORTS.GRANT.start && s.end === COHORTS.GRANT.end) return "grant";
  if (s.start === COHORTS.INTENTS.start && s.end === COHORTS.INTENTS.end) return "intents";
  if (s.start === COHORTS.LIQUIDITY.start && s.end === COHORTS.LIQUIDITY.end) return "liquidity";
  return "unknown";
}

async function gql(query) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  if (json.errors) throw new Error("GraphQL: " + JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

async function main() {
  const data = await gql(QUERY);
  const now = Date.now();
  const schedules = data.schedules.map((s) => {
    const total = BigInt(s.total);
    const claimed = BigInt(s.claimed);
    return {
      id: Number(s.id),
      beneficiary: s.beneficiary,
      cohort: cohortOf(s),
      total_plancks: s.total,
      claimed_plancks: s.claimed,
      cliff_ms: s.cliff,
      start_ms: s.start,
      end_ms: s.end,
      last_claim_at_ms: s.last_claim_at,
      vested_plancks: vested(total, BigInt(s.cliff), BigInt(s.start), BigInt(s.end), BigInt(now)).toString(),
    };
  });

  const byCohort = {};
  for (const c of Object.values(COHORTS)) byCohort[c.key] = { label: c.label, start_ms: c.start, end_ms: c.end, note: c.note, schedules: 0, total_plancks: "0", claimed_plancks: "0", vested_plancks: "0" };
  for (const s of schedules) {
    const b = byCohort[s.cohort];
    b.schedules += 1;
    b.total_plancks = (BigInt(b.total_plancks) + BigInt(s.total_plancks)).toString();
    b.claimed_plancks = (BigInt(b.claimed_plancks) + BigInt(s.claimed_plancks)).toString();
    b.vested_plancks = (BigInt(b.vested_plancks) + BigInt(s.vested_plancks)).toString();
  }

  const out = {
    ok: true,
    source: "https://sqm.quantus.com/v1/graphql (vesting_schedule)",
    fetched_at: new Date().toISOString(),
    fetched_at_ms: String(now),
    block_height: data.chain?.block_height ?? null,
    tge_ms: "1788943917807",
    tge_iso: "2026-09-09T08:51:57.807Z",
    cohorts: COHORTS,
    by_cohort: byCohort,
    schedules,
    genesis_allocation_note:
      "27% TGE mint = 5,670,000 QTC (runtime/src/genesis_config_presets/mainnet_vesting.rs): " +
      "spreadsheet grants 4,957,502 + intents grant 42,000 + treasury initial liquidity 210,000 + " +
      "treasury vesting remainder + per-treasurer/tech-collective seed endowments of 3 QTC.",
  };

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, "..", "data", "vesting.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
  console.log("wrote", outPath, schedules.length, "schedules, block", out.block_height);
}

/* Exact upstream vested_amount: linear between start/end, nothing before cliff,
 * full total at/after end, floor(total*(now-start)/(end-start)) otherwise. */
function vested(total, cliff, start, end, now) {
  if (now < cliff) return 0n;
  if (now >= end) return total;
  const elapsed = now - start;
  const duration = end - start;
  if (duration <= 0n) return total;
  return (total * elapsed) / duration;
}

main().catch((e) => {
  console.error("fetch-vesting-data failed:", e.message);
  process.exit(1);
});
