#!/usr/bin/env node
/* Fetch Quantus on-chain governance data from the public Subsquid indexer (server-side; no CORS).
 * Writes data/governance.json for same-origin consumption on GitHub Pages.
 * Sources:
 *   - tech_referendum_event: enriched referendum lifecycle events (SUBMITTED, DECISION_STARTED,
 *     CONFIRM_STARTED, CONFIRMED, REJECTED, CANCELLED, KILLED, TIMED_OUT) with tallies, track,
 *     origin, preimage hash, decoded proposal calls.
 *   - extrinsic: raw governance calls (TechReferenda submit/place_decision_deposit/vote,
 *     TechCollective propose/vote, Preimage note_preimage) so the app can show who did what.
 *   - runtime_upgrade: enacted runtime upgrades (fast_upgrade referenda land here).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://sqm.quantus.com/v1/graphql";

const QUERY = `query {
  referenda: tech_referendum_event(order_by: {timestamp: asc}) {
    referendum_index track track_name type title description origin is_runtime_upgrade
    tally_ayes tally_nays tally_bare_ayes
    proposal_preimage_hash proposal_size_bytes proposal_calls proposal_summary proposal_storage
    timestamp actor_id block_id extrinsic_id
  }
  extrinsics: extrinsic(limit: 500, order_by: {timestamp: asc}, where: {
    _or: [
      {pallet: {_eq: "TechReferenda"}},
      {pallet: {_eq: "TechCollective"}},
      {pallet: {_eq: "Preimage"}}
    ]
  }) {
    pallet call timestamp signer_id block_id success args index_in_block
  }
  upgrades: runtime_upgrade(order_by: {timestamp: asc}) {
    id block_id timestamp
  }
}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "data", "governance.json");

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
  console.log(
    "wrote",
    outPath,
    "referendum_events=" + (json.data?.referenda?.length ?? 0),
    "extrinsics=" + (json.data?.extrinsics?.length ?? 0),
    "upgrades=" + (json.data?.upgrades?.length ?? 0),
    "at",
    payload.fetched_at
  );
}

main().catch((e) => {
  console.error("fetch-governance-data failed:", e.message || e);
  process.exit(1);
});
