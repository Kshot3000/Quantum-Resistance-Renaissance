# QTC Vesting Desk

The unlock calendar for Quantus's locked genesis supply — v1.28.0.

## What it is

All **48 real vesting schedules** from the chain's Subsquid indexer
(`vesting_schedule`, fetched 2026-09-30, block ~140,120): **5,669,940 QTC** of
the 27% TGE mint, still ~96% locked behind the one-year cliff. The desk shows
what's vested, what's claimed, what's claimable, and exactly when the rest
unlocks — computed with the pallet's own formula, in the browser, to the planck.

## Verified facts (Quantus-Network/chain, fresh clone 2026-09-30)

- `pallets/vesting/src/lib.rs` — linear accrual `start → end`, nothing before
  `cliff`; `vested(now) = 0` if `now < cliff`, `total` if `now >= end`, else
  `floor(total·(now−start)/(end−start))`. Times are ms since the unix epoch.
- Non-final claims pay down to multiples of `NON_FINAL_PAYOUT_QUANTA(2500)` ×
  `PayoutQuantum(0.01 QTC)` = **25 QTC**; the final claim pays the exact remainder.
- `MinClaimInterval = MILLIS_PER_DAY` — at most one claim per schedule per day.
- Claim is **permissionless**: pallet index **22**, call index **0**
  (`Vesting.claim(schedule_id)`); payout always goes to the stored beneficiary.
- `runtime/src/genesis_config_presets/mainnet_vesting.rs` — 27% TGE mint =
  5,670,000 QTC; grants lock 365 days then vest 3 years (`cliff == start`, no
  lump unlocks); intents grant (id 45) 42,000 QTC over 365 days from TGE;
  treasury initial liquidity (id 46) 210,000 QTC over 16 days. TGE = first
  non-zero block-1 timestamp = 1788943917807 (2026-09-09 08:51 UTC).

## The three cohorts (indexer-observed)

| Cohort | Schedules | Total | Window |
|---|---|---|---|
| Genesis grants | 46 | 5,417,940 QTC | 2027-09-09 → 2030-09-08 |
| Intents grant (id 45) | 1 | 42,000 QTC | 2026-09-09 → 2027-09-09 |
| Treasury liquidity (id 46) | 1 | 210,000 QTC | 2026-09-09 → 2026-09-25 |

Real findings at snapshot time: the liquidity schedule is fully vested with
171,475 / 210,000 QTC claimed (38,525 QTC vested-but-unclaimed); the intents
beneficiary had ~2,441 QTC vested and had claimed nothing.

## Features

- **Right now**: vested / claimed / claimable-estimate / locked, plus countdowns
  to the grant unlock start, intents full vesting, and the 2030 finish.
- **Unlock calendar**: monthly aggregate vesting curve (cumulative + inflow),
  canvas-rendered, pallet-exact rounding.
- **Cohort cards** with progress bars and claimable estimates.
- **Schedule explorer**: 48 rows, search/sort/filter, per-schedule detail with a
  12-month forward unlock calendar and the exact claim call.
- **Track my grant**: paste a `qz…` address — SS58 checksum-validated (prefix 189,
  codec copied verbatim from `distribution-planner/js/ss58.js`) — and see its
  schedules.
- **Vesting 101**: the exact formula, payout quirks, permissionless-claim path,
  admin powers, genesis audit table, source links.

## Honesty notes

- Live data is attempted from `sqm.quantus.com` first; GitHub Pages is not on
  the indexer's CORS allowlist, so the app falls back to the baked
  `data/vesting.json` snapshot — the badge always says which.
- "Claimable" is an estimate: the chain evaluates at the claim block's own
  timestamp, one claim per schedule per day max.
- All math is BigInt plancks (1 QTC = 10¹² plancks). No floats anywhere.

## Tests

- `tests/run-tests.mjs` — 26/26 node unit tests: pallet-exact vesting vectors,
  25-QTC alignment, cohort taxonomy, genesis constants, monthly-curve sanity,
  and a full `data/vesting.json` integrity pass (every schedule's vested amount
  recomputed from the snapshot timestamp).
- Browser QA: `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-vesting-browser.mjs`
  (headless Chromium 152, CDP, file:// + snapshot fallback).

Attribution: [@kshot9000](https://x.com/kshot9000) · QTC donations:
`qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
