# QTC Portfolio Desk — the multi-wallet command center

Command your whole QTC estate from one desk: add every Quantus address you control, see live-first balances, liquid vs vesting-locked splits, an allocation chart, transfer activity, and mining attribution — all in one place.

## What it does

- **Multi-address vault** — add SS58-189 addresses with nicknames. Every address is checksum-validated before it joins, and each gets its five-word human checkphrase (the upstream `qp-human-checkphrase` algorithm), which you read back from your wallet before confirming. The vault lives in this browser's `localStorage` only.
- **Live-first balances** — per-address `account_by_pk` balance queries batched into one indexer call. When the indexer is unreachable (browser CORS), the desk falls back to the top-200 snapshot balances and says so honestly; addresses outside the snapshot show "balance unknown".
- **Liquid vs locked** — vesting schedules matched to your addresses (all 48 real schedules from the chain indexer). Vested amounts are recomputed with the pallet's exact linear formula; "Controlled" = on-chain balance + claimable vesting (vested-but-unclaimed still sits in the genesis vesting-pool account until claimed).
- **Allocation donut** — canvas-rendered, no external libraries.
- **Recent activity** — transfers touching your addresses from the real transfer snapshot, with explorer block links.
- **Mining attribution** — addresses that mined blocks in the observed window are tagged.
- **Vault tools** — CSV export of holdings, JSON export/import of the vault, clear-vault.

## Never moves funds

Read-only by design. The desk never asks for keys, seeds, or signatures and never signs transactions. Vesting claims are permissionless `Vesting.claim` calls you make on the real chain yourself.

## Data

- Live: `https://sqm.quantus.com/v1/graphql` (per-address balances + chain head)
- Snapshots (same-origin, refreshed server-side): `../../data/whales.json`, `../../data/vesting.json`, `../../data/flows.json`, `../../data/miners.json`, `../../data/live.json`

## Tests

- `node tests/run-tests.mjs` — 8/8 logic tests (vesting math, rollups, vault, CSV export)
- Browser QA: real-browser verification of the add/validate/checkphrase flow, donut render, and live-first data load

---

Built by [@kshot9000](https://x.com/kshot9000) · Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau` · Independent builder work — not affiliated with the Quantus team.
