# QTC Mempool Desk — the transaction-pool command center

Read the Quantus transaction pool before the block does: connect to any node, watch the live mempool, get `txWatch` zero-confirmation signals the second a transfer *requests* your address, and estimate node-quoted fees on what's actually waiting. No node, no data — nothing here is ever simulated.

## What it does

- **Node connector** — any Substrate WebSocket RPC (default: the upstream-documented mainnet RPC `wss://rpc.quantus.network`). Handshake reads `system_chain`, `system_version`, and the head block; a `chain_subscribeNewHeads` subscription keeps the head live. Endpoint saved in `localStorage`. Exponential-backoff reconnect with automatic watcher resubscription.
- **Mempool gauge** — `author_pendingExtrinsics` polled every 8s: pending count, total/average/largest extrinsic bytes, and a canvas pool-history sparkline. If the node doesn't expose the method (common on public RPCs), the desk says so instead of inventing a pool.
- **txWatch watchers** — the upstream transaction-pool listener RPC (`chain/docs/rpc_additions/transaction_pool_listener.md`): `txWatch_watchAddress` per SS58-189 address (checksum-validated before it joins), live `txWatch_transfer` signals with planck→QTC amounts, native-vs-asset badges, sender, tx hash, and age. Optional browser-notification popups.
- **Fee Desk** — `payment_queryInfo` partialFee quotes on up to 25 sampled pending extrinsics (sorted biggest-fee first), plus a paste-any-extrinsic-hex quoter. Every figure is node-quoted; amounts in QTC (1 QTC = 10¹² planck, per upstream docs).
- **Learn tab** — the 5-step upstream receive flow, txWatch RPC reference, aggregation context (~7 KB txs, ~430 TPS claimed design), node-operator notes, and the data-honesty statement.

## Honest by design

A `txWatch` signal means a transfer was *requested* to your address — not confirmed. The desk carries the upstream zero-conf warning on the Watchers tab: never release goods or mark an invoice paid on a signal alone; confirm inclusion in a finalized block. Read-only: the desk never asks for keys or signatures and never submits transactions.

## Data

- Live only: your node's WebSocket RPC (`wss://rpc.quantus.network` by default)
- No snapshots, no fallback datasets, no mock data

## Tests

- `node tests/run-tests.mjs` — 11/11 logic tests (planck math, RPC builders, endpoint validation, SS58-189 checks, txWatch notification parsing, pool stats, fee sorting, backoff)
- Browser QA: real-browser verification of the offline-first UI, validation flows, tabs, and attribution

---

Built by [@kshot9000](https://x.com/kshot9000) · Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau` · Independent builder work — not affiliated with the Quantus team.
