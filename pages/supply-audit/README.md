# QTC Supply Audit — the independent money-supply verifier

Every QTC in existence was minted by exactly two mechanisms: the 22 genesis
transfers at block 1, and the per-block miner reward from
`pallet_mining_rewards`. This desk recomputes the protocol's exact emission
recurrence to the planck, tallies every recorded mint from the public
Subsquid indexer, and reconciles both against the indexer's reported account
balances.

**Verdict (Sept 30, 2026, at height 139,888):**
- **Protocol issuance — PASS.** The exact on-chain recurrence
  `reward = (21M − (supply + fees)) / 50,000,000`, quantized down to the
  0.01 QTC leaf quantum, reproduces the recorded block rewards. Known-answer
  check: the formula predicts the very first block reward at exactly
  300,000,000,000 plancks — the indexer's first `MinerRewarded` event reads
  exactly that.
- **Genesis allocation — PASS.** All 22 block-1 transfers total
  5,670,000.301 QTC = 27.0000014% of the 21M cap. (An earlier pipeline
  snapshot truncated this list to 3 rows with `limit: 3` — the audit reads
  all of them.) The vesting pool balance reconciles to
  `vesting_total − claimed` plus the 0.001 QTC genesis dust, within 0.0001 QTC.
- **Indexer-reported balances — FLAG.** Account balance sums exceed every
  provable mint by **+42,911.35 QTC (0.75%)**, growing ≈ one block reward per
  block. Evidence: the canonical minting sentinel
  `qzjUYyuN4L3HKmBPMxHvK2n8HYnaLZcQvLSQTgdwB2nQ1g2mc` reports `free = 0`
  while transfer proofs show ~2× the recorded rewards flowing out of it
  (the debit side vanishes from the indexer's books); the surplus matches
  wormhole exit proofs; a per-miner spot check shows the excess is
  concentrated in the indexer's global/pool accounting, not spread across
  miners; the wormhole pallet source contains no `mint_into` path, so exits
  cannot be chain-side inflation. ≈258 QTC of the gap is unattributed
  (possible burns / fee dust / indexer noise) — flagged, not invented.

Use **genesis + recorded block rewards** as the true money stock, not the
indexer's inflated balance sum.

## Structure

- `index.html` — five tabs (Verdict, Ledgers, Emission curve, Genesis audit,
  Method) + Scope; canvas charts; ambient ledger-rain.
- `styles.css` — auditor's-ledger identity (ink green-black, mint + ledger-gold).
- `app.js` — UI layer: data loading (live indexer first, `data/supply.json`
  fallback), rendering, charts.
- `js/audit-core.js` — exact protocol math + audit computation, no DOM;
  shared with the node tests (UMD).
- `tests/supply.test.js` — 30 assertions: constants, quantization,
  first-block known answer, recurrence properties, formatting, synthetic
  fixture, and regression pins on the real snapshot.

## Data

`node scripts/fetch-supply-data.mjs` → `data/supply.json` (genesis
transfers, miner-reward aggregate, account sums, vesting, minting-sentinel
flows). Re-run and commit to re-audit at a new height. The app also reads
`data/live.json` for the recent-blocks reward overlay.

## Sources

- `Quantus-Network/chain — pallets/mining-rewards/src/lib.rs` (`on_finalize`)
- `Quantus-Network/chain — runtime/src/configs/mod.rs`
  (`EmissionDivisor = 50_000_000`, `MintingAccount = [1u8; 32]`)
- `Quantus-Network/chain — pallets/wormhole/src/lib.rs`
  (`SCALE_DOWN_FACTOR = 10_000_000_000`)
- `Quantus-Network/docs — docs/reference/tokenomics.md` (21M cap, 27% genesis)

Attribution: [@kshot9000](https://x.com/kshot9000) · QTC donations
`qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
