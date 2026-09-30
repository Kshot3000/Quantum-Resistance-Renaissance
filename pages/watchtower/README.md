# QTC Watchtower

The chain & wallet watcher desk for Quantus — watch any SS58 address, arm alert rules, and scan them against live-first chain data. 100% client-side; nothing here moves funds.

## What it does

- **Watchlist** — add any Quantus address (SS58 prefix 189, checksum-validated). Each entry gets its human checkphrase from the real upstream Quantus algorithm, plus its balance (top-200 rich-list snapshot) and window activity.
- **Rule engine** (10 rule types):
  - Per address: balance below / above a threshold, balance moves by % or QTC, incoming ≥ X, outgoing ≥ X, any new activity.
  - Chain-wide: whale transfer ≥ X anywhere, new governance referendum, new runtime upgrade, no new block for N minutes.
- **Scan now** — evaluates every enabled rule against live-first chain data. Rules fire on *transitions and new events* (a balance already below threshold doesn't re-alert); baselines advance per scan so each hit is reported exactly once.
- **Alerts feed** — severity-ranked, read/unread, browser notifications (opt-in, fires while the tab is open), auto-scan on a 5/15/60-minute timer.
- **Self-test** — runs every enabled rule against synthetic fixtures so you can preview each alert before the chain produces one. Self-test output is labeled and never persisted as chain data.
- **Honest data sourcing** — every scan attempts the public Subsquid indexer (`sqm.quantus.com`, 8s timeout) and falls back to the committed same-origin snapshots. The snapshot badge always shows capture time and block height. Balance coverage is the top-200 rich-list snapshot — addresses outside it show *balance unknown* rather than a guess.

## Data

Reads the builder repo's shared snapshots: `data/live.json` (head blocks), `data/flows.json` (15,000-block transfer window), `data/governance.json` (referenda + upgrades), `data/whales.json` (top-200 balances). See the Data sources tab in the app for freshness and limitations.

## State

Everything lives in `localStorage` under `qtc-watchtower-v1`: watchlist, rules, scan baselines, alert history, settings. Export/import as JSON from the Data sources tab. Clearing site data wipes the tower — keep an export.

## Tests

`node tests/run-tests.mjs` — 17 logic tests (planck math, rule transitions, per-transfer dedupe, self-test fixtures).

## Built by

[@kshot9000](https://x.com/kshot9000) · QTC donations: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
