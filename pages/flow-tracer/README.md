# QTC Flow Tracer

Follow the money on the quantum chain — v1.29.0.

## What it is

Money-flow forensics for Quantus: paste any `qz…` address (checksum-validated,
SS58 prefix 189) and walk its transfers hop by hop in an interactive flow graph,
or let the **pattern radar** surface structural shapes across the whole dataset:

- **Peel chains** — maximal one-in-one-out runs (classic forwarding/change pattern)
- **Distribution** — one sender → ≥5 distinct recipients (fan-out)
- **Consolidation** — ≥5 distinct senders → one recipient (fan-in)
- **Round amounts** — exact whole-QTC moves (often manual/OTC)
- **Miner forwarding** — where coinbase recipients actually send their rewards next

Plus the 25 largest transfers in the dataset, click-anywhere address dossiers
(in/out totals, net flow, first/last seen, top counterparties), and a trace
console that tries the **live indexer first** (8s abort) and falls back to the
snapshot.

## Data (real, no simulation)

`data/flows.json`, produced by `node scripts/fetch-flow-data.mjs` from the
public Subsquid indexer (`sqm.quantus.com/v1/graphql`, `transfer` entity):

- every transfer **≥ 1 QTC** in the 15,000 blocks before capture (~4,931 rows),
- the **600 largest transfers of all time** (captures historic whales),
- the full **22-transfer block-1 genesis allocation** (merged from the
  supply-audit snapshot — the all-time top-600 only caught the largest one).

Snapshot at ship time (2026-09-30, block ~140,338): **5,361 transfers** across
**1,204 addresses**. Radar findings in this window: 6 distributors (≥8
recipients), 4 consolidators (≥8 senders), 3 peel chains.

## Honest limits

- Transfers **below 1 QTC** (miner-reward dust) are excluded by design.
- Transfers outside the 15,000-block window are invisible unless they are in the
  all-time top 600.
- A trace that ends ran out of *dataset*, not necessarily out of chain.
- Pattern hits are structural shapes, not accusations and not owner identities.

## Tests

- `node pages/flow-tracer/tests/run-tests.mjs` — 18/18 logic tests green
  (graph build, BFS trace, layout determinism, peel/fan detectors, dossier math,
  formatting).
- Headless-Chromium CDP QA (`hidden_files/qa-flowtracer-browser.mjs`) — zero
  console errors, trace render, dossier, all five radar tabs, notable table,
  quick picks, attribution.

## Refresh

`node scripts/fetch-flow-data.mjs && git add data/flows.json && git commit`
