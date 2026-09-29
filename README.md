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

## Standards

- Every app is verified in a real browser and on the live Pages URL before it's announced.
- No demo figures dressed as live data — simulated content is clearly labeled.
- Releases bump cache keys (`?v=`) for every changed JS/CSS file so fixes actually reach returning visitors.

## Live

- Hub: https://kshot3000.github.io/Quantus-Muse-Builder/

## Builder

- GitHub: [@Kshot3000](https://github.com/Kshot3000)
- X: [@kshot9000](https://x.com/kshot9000)
- Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
