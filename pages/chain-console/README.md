# QTC Chain Console — the JSON-RPC developer workbench

Talk to the Quantus chain directly: connect to any Substrate WebSocket RPC (default: the upstream-documented mainnet endpoint `wss://rpc.quantus.network`), run one-click recipes against real chain state, fire custom methods, watch live subscriptions, and read the full method reference. No mocks, no snapshots — if the endpoint is unreachable, the console says so.

**Live:** https://kshot3000.github.io/Quantum-Resistance-Renaissance/pages/chain-console/

## What it does

- **Connection** — endpoint presets (mainnet public RPC, local `ws://127.0.0.1:9944`, or custom), connect/disconnect, live handshake card (`system_chain`, node name/version, properties, genesis hash — all read from the node, not from this page), and session stats (calls, errors, avg latency, live subs).
- **16 one-click recipes** across six groups: chain (head, hash-by-number, full block, finalized head), accounts & storage (balance inspector, next nonce, raw storage read with a storage-key builder), runtime (version, properties, metadata size), node (health, peer table, sync state, 5-call node identity), fees (`payment_queryInfo` / `payment_queryFeeDetails` on pasted extrinsic hex), and one **gated** broadcast (`author_submitExtrinsic` — review screen + explicit irreversible-action checkbox; the console never asks for keys).
- **Balance inspector** — computes `System.Account` storage keys with the chain-verified twox_128 derivation and decodes `AccountInfo` locally (free/reserved/frozen in QTC, existential-deposit warning).
- **Custom method runner** — any method, JSON params, request preview, `Ctrl+Enter` to send, autocomplete from the reference.
- **Live subscriptions** — `chain_subscribeNewHeads`, `chain_subscribeFinalizedHeads`, and `state_subscribeStorage` balance watch, with a timestamped feed and block-time deltas.
- **Method reference** — 40+ methods with params, returns, and Quantus notes (which `author_*` calls public RPCs commonly disable, the Quantus-specific `txWatch_*` pool listener).
- **History** — every call logged to localStorage with re-run and JSON export.
- **Result viewer** — human summary card + syntax-highlighted raw JSON with long-hex folding, per-call timing, and a plain-English error explainer (JSON-RPC codes mapped to what-to-do hints).
- **Learn tab** — the wire protocol, subscription lifecycle, etiquette for the shared public RPC, and the chain facts the console relies on.

## Chain facts this console relies on (all re-verified 2026-09-30)

- SS58 prefix **189**, 12 decimals, 1 QTC = 10¹² planck, existential deposit 0.001 QTC (`chain/node/src/chain_spec.rs`, runtime).
- `System.Account` storage: Twox128(pallet) ++ Twox128(item) ++ Blake2_128Concat(accountId). **Bug fixed this release:** this builder's `xxhash128` previously used XxHash64 seeds (0, `0x9E3779B97F4A7C15`); the chain actually uses seeds **(0, 1)** — verified against `sp-crypto-hashing 0.1.0` source (the crate behind the chain's `sp-core 39.0.0`), `Quantus-Network/chain` `frame/support/src/hash.rs` (`Twox128::hash` → `sp_io::hashing::twox_128`), and cross-checked byte-for-byte with `@polkadot/util-crypto` (`twox_128("System") = 26aa394eea5630e07c48ae0c9558cef7`). The fix was applied to the Web Wallet and Airgap Desk copies too, with canonical-vector regression tests — their balance reads were silently returning empty before.
- Public RPC `wss://rpc.quantus.network` (upstream-documented; also used by the Web Wallet and Mempool Desk).

## Sibling desks (not duplicated here)

- **Node Operator Desk** — install, launch commands, ports, bootnodes, sync monitor, log forensics.
- **Mempool Desk** — live mempool gauge, `txWatch_*` address watchers, fee desk on pending extrinsics.
- **Airgap Desk** — produces the signed extrinsic hex the broadcast recipe consumes.

## Tests

- `node tests/run-tests.mjs` — 75/75 (endpoint validation, request envelopes, params parsing, error explainer, address/storage-key derivation incl. the canonical twox_128 vector, balance decode, recipe builders, summarizers, history, and the WS client with a mock socket: connect, call round-trip, error propagation, timeouts, subscription routing).
- Browser QA (`~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-chainconsole-browser.mjs`): headless Chromium + CDP with an injected `MockWebSocket` — full connect→handshake→recipe→custom→subscription→gated-broadcast flow, validation errors, and the unreachable-endpoint path; zero console errors.

100% client-side. Built by [@kshot9000](https://x.com/kshot9000) · QTC donations: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
