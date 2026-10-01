# QTC Node Operator Desk

The node-operations console for Quantus: install paths, an exact launch-command builder, the verified port & firewall map, the seven mainnet bootnodes, a sync monitor, a log forensics lab, and the real update procedure.

**Live:** https://kshot3000.github.io/Quantus-Muse-Builder/pages/node-desk/

## What it does

- **Install paths** — three verified routes to `quantus-node`: release tarballs (recommended), the official `quantus-mining.sh` setup script, and the Docker image `ghcr.io/quantus-network/quantus-node:latest` (with the stale `planck` CMD overridden — upstream's Dockerfile still defaults to the retired testnet).
- **Launch Lab** — builds your exact `quantus-node` startup command from the real flags in `chain/node/src/cli.rs`: three modes (external QUIC miner / local CPU mining / full node), node name, wormhole inner-hash validation, miner listen port, chain spec, node-key file, base path, `--force-authoring`, experimental RPC endpoint, Prometheus port. Generates the matching `quantus-miner serve` command (QUIC + auth token + TLS pin). Validates as you type; dangerous choices get warnings, invalid ones block command generation.
- **Port & firewall map** — 30333/tcp P2P (the only public port), 9944 RPC, 9833/udp miner QUIC (binds 0.0.0.0 — firewall it), 9615 Prometheus, 9900 miner metrics — plus a ufw/iptables/nftables rule generator.
- **Bootnodes** — all seven mainnet multiaddrs verbatim from `chain/node/src/chain-specs/mainnet.json`, with copy buttons and a ready `--bootnodes` flag.
- **Sync monitor** — probes `wss://rpc.quantus.network` for the live head (falls back to the builder snapshot, then manual entry) and estimates your node's catch-up from its best block.
- **Log forensics** — paste node logs; the desk matches known lines (wormhole reward address, Syncing/Idle, `Verification failed` = version mismatch, 60 s miner idle timeout, freshness gate) and explains each with fixes.
- **Update desk** — binary updates (matching node+miner pairs, ALPN `quantus-miner/2`) and the governance runtime-upgrade flow (`fast_upgrade` → `authorize_upgrade` → permissionless `quantus runtime apply`; no restart; Polkadot-JS can't sign Dilithium).

## Honest gaps (deliberately absent)

- **No systemd unit** — none is published in any upstream repo; this desk won't invent an ops runbook.
- **No snapshots / warp sync** — none published; recovery is `purge-chain --chain mainnet` + full resync.
- **Prometheus default disputed** — 9615 in the current mining guide + skill + sc-cli default vs 9616 in the older `chain/MINING.md` table. The desk says 9615 and tells you to verify with `quantus-node --help`.

## Method & sources

All operational facts read from Quantus-Network source on 2026-09-30: `chain/MINING.md`, `chain/node/src/cli.rs`, `chain/README.md` (pruning), `chain/node/src/chain-specs/mainnet.json`, `chain/node/src/command.rs`, `chain/node/src/chain_spec.rs`, `chain/Dockerfile`, `docs/static/scripts/quantus-mining.sh`, `quantus-miner/README.md`, `chain/docs/RUNTIME_UPGRADE_VIA_GOVERNANCE.md`, `chain/docs/RUNTIME_UPDATE.md`.

## Tests

- `node tests/run.mjs` — 80/80 logic tests (validators, command builder, firewall rules, log forensics, sync math).
- Real-browser QA via `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-nodedesk-browser.mjs` (headless Chromium, file:// + CDP, zero console errors).

100% client-side. Built by [@kshot9000](https://x.com/kshot9000) · QTC donations: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
