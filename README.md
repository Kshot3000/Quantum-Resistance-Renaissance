# Quantus Muse Builder

Apps and tools for the **Quantus Blockchain** ecosystem — built by [@kshot9000](https://x.com/kshot9000).

> Quantus is a proof-of-work Layer 1 blockchain built for the quantum era. Mainnet went live **September 9, 2026** with post-quantum cryptography (ML-DSA-65 / ML-DSA-87) from the genesis block, a **21M $QTC** supply cap, open mining with no built-in advantage for Quantus Labs, and native transaction aggregation. First exchange venue: NEAR Intents.

## What lives here

- `index.html` — Builder hub: chain facts, live stats, and the app directory.
- `pages/` — Each shipped app gets its own folder, verified in a real browser before it goes live:
  - `mining-calculator/` — QTC reward estimator + emission chart + mining quickstart
  - `address-toolkit/` — SS58 prefix-189 address inspector/encoder
  - `network-dashboard/` — live mainnet telemetry from the public Subsquid indexer
  - `quantum-shield/` — interactive post-quantum explainer (ML-DSA, signature math, exposure demo)
  - `tokenomics/` — QTC tokenomics explorer (verified genesis vesting, unlock simulator, emission tail, fee-burn calculator, funding)
  - `block-explorer/` — QTC block explorer (mainnet block/extrinsic/account search)
  - `mining-studio/` — QTC mining command center (setup wizard, rig builder, benchmark grader, wormhole explainer, security checklist, troubleshooter)
  - `safesend/` — QTC SafeSend Lab (checkphrase address verifier on the real upstream algorithm, reversible-transfer simulator, high-security accounts guide, pallet call reference)
  - `benchmark-lab/` — QTC Benchmark Lab (Quantus vs Bitcoin/Ethereum/Solana/Ergo: consensus, PQ signatures, throughput math, fees, supply, launch fairness — every figure cited)
  - `fee-throughput-lab/` — QTC Fee & Throughput Lab (exact length-fee estimator from the runtime polynomial, wormhole exit + high-security fee calculators, QTPS visualizer, aggregation explorer, signature-size lab — figures verified Sept 29, 2026)
  - `threat-lab/` — QTC Threat Lab (Q-Day countdown across 2028/2029/2032 sourced horizons, 11-scenario wallet-exposure simulator for BTC/ETH/SOL/ADA/QTC, sourced chain-readiness table, Shor-vs-Grover explainer, quantum milestone timeline — every claim cited, Sept 29, 2026)
  - `emission-lab/` — QTC Emission Lab (exact on-chain reward formula R = (21M − S) / 50,000,000 verified against the runtime source, live reward pulse, interactive decay simulator, milestone timeline, 80-year supply projections — no halvings, Sept 30, 2026)
  - `mining-observatory/` — QTC Mining Observatory (miner decentralization from real mainnet coinbase data: Nakamoto coefficient, Herfindahl index vs DOJ bands, 51% crossing curve, miner leaderboard with explorer deep-links, concentration-over-time charts — Sept 30, 2026)
  - `swap-desk/` — QTC Swap Desk (live NEAR Intents 1Click listing watch — probes the public token list for the QTC listing — plus real swap mechanics from the wallet team's integration docs: both directions, fee/slippage lab, order status lifecycle, deadlines/refunds/safety — Sept 30, 2026)
  - `dev-hub/` — QTC Developer Hub (verified chain constants, full runtime pallet index map 0–23 incl. vacant indices, exact BigInt QTC/planck converter, SS58 + ML-DSA account primer, connection recipes, JSON-RPC request builder, upstream repo map — every constant read from Quantus-Network/chain source — Sept 30, 2026)
  - `whale-watch/` — QTC Whale Watch (supply concentration from real indexer data: genesis vesting pool 95.5% locked, circulating rich list top-200 with liquid balances, balance brackets, estimated Gini, largest all-time + recent whale transfers, checksum-validated address lookup — Sept 30, 2026)
  - `key-forge/` — QTC Quantum Key Forge (real ML-DSA-65/87 keypair generation in-browser via audited FIPS-204 implementation; exact upstream address derivation — Poseidon2-Goldilocks account-ID hash + SS58 prefix 189 — validated against 45 upstream test vectors; address inspector, sign & verify lab, printable paper card — 100% client-side, Sept 30, 2026)
  - `distribution-planner/` — QTC Distribution Planner (plan airdrops/payroll/grants: checksum-validated SS58 addresses with human checkphrases, exact BigInt QTC→planck math, atomic utility.batch_all batching sized to the chain limit, length-fee-floor estimates from the runtime polynomial, CLI-ready batch files + exact `quantus batch send` run script — plans only, never signs; batch semantics from Quantus-Network/quantus-cli main, Sept 30, 2026)
  - `multisig-vault/` — QTC MultiSig Vault (shared custody on the real custom multisig pallet, index 19: exact `blake2b-256(py/mltsg ‖ sorted signers ‖ threshold ‖ nonce)` address derivation cross-checked against an independent implementation, exact runtime fee constants — 0.03 QTC creation burn, per-signer proposal-fee formula, 0.01 QTC refundable deposit — byte-exact unsigned payloads for all seven dispatchables with inner-call builder for Balances payouts, proposal lifecycle board; derivation/indices/fees read from Quantus-Network/chain main, Sept 30, 2026)
  - `governance-tracker/` — QTC Governance Tracker (every on-chain referendum with its full event lifecycle — referendum #0 from preimage note through confirmed runtime upgrade, 8 member votes, 80% support / 100% approval — the exact two-track map read from runtime source: tech_collective_members 61%/60%, fast_upgrade 80%/80%; interactive threshold lab on the real flat-curve math; ranked-collective vote wiring with Linear weight; 45-day undeciding-timeout lifecycle; honest empty treasury — Sept 30, 2026)
  - `vanity-forge/` — QTC Vanity Forge (grind brandable qz… addresses with real in-browser ML-DSA-65/87 keypairs on the exact upstream derivation — Poseidon2 account-ID + SS58-189 — honest difficulty math with expected/median/luck percentiles, machine benchmark grounding every ETA, responsive forge console with luck meter, localStorage results vault, no-illusions safety brief; 100% client-side, keys never leave the page — Sept 30, 2026)
  - `contact-vault/` — QTC Contact Vault (the address book with a built-in poisoning alarm: localStorage contact vault with human checkphrases on the real upstream algorithm — 1,171 test vectors green — verify-on-paste with vault match/unknown verdicts plus a Levenshtein/prefix/suffix similarity meter, spoken-checkphrase challenge mode, poisoning lab that grinds real lookalike addresses and a one-character avalanche demo, batch verify, QR share cards, plain + PBKDF2/AES-GCM-encrypted export/import; 100% client-side, the vault never leaves the browser — Sept 30, 2026)
  - `legacy-vault/` — QTC Legacy Vault (the inheritance desk for the quantum era: real Shamir's Secret Sharing over GF(2⁸) — 45 known-answer vectors cross-checked against an independent Python implementation — beneficiary plan with weighted readiness score, printable letter of instruction, honest method comparison with real on-chain costs; 100% client-side, never moves funds — Sept 30, 2026)

## Live data

The public Quantus indexer (`sqm.quantus.com`) only allowlists official Quantus domains for browser CORS. Community Pages apps therefore read a **same-origin snapshot** at `data/live.json` (produced by `node scripts/fetch-chain-data.mjs` from that indexer). The Mining Observatory additionally reads `data/miners.json` (produced by `node scripts/fetch-miner-data.mjs`: per-block coinbase addresses over the recent 15,000 blocks + the all-time mined-blocks aggregate). Direct indexer calls are still attempted first. Re-run the scripts and commit to refresh the snapshots. The Governance Tracker reads `data/governance.json` (produced by `node scripts/fetch-governance-data.mjs`: all tech_referendum_event rows, governance extrinsics, and runtime upgrades). Whale Watch reads `data/whales.json` (produced by `node scripts/fetch-whale-data.mjs`).

## Standards

- Every app is verified in a real browser and on the live Pages URL before it's announced.
- No demo figures dressed as live data — simulated content is clearly labeled.
- Releases bump cache keys (`?v=`) for every changed JS/CSS file so fixes actually reach returning visitors.
- Live chain numbers never invent figures: if the snapshot and indexer are both unreachable, the UI says so.

## Live

- Hub: https://kshot3000.github.io/Quantus-Muse-Builder/

## Builder

- GitHub: [@Kshot3000](https://github.com/Kshot3000)
- X: [@kshot9000](https://x.com/kshot9000)
- Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
