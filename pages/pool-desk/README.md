# QTC Pool Desk

The mining-pool directory & comparator for Quantus: every known QTC pool compared honestly — real fees stacked the way they actually hit you, payout terms, PPLNS windows, and copy-paste connection commands, each fact stamped with the pool page it came from.

**Live:** https://kshot3000.github.io/Quantus-Muse-Builder/pages/pool-desk/

## What it does

- **Pool directory** — AriaPool and Quanpool with verified terms: pool fee, miner-software dev fees, PPLNS scheme details, minimum payouts, payout schedules, signup model, endpoints, and download links with the pools' own SHA-256 checksums. Every fact carries a `verified <date>` stamp and its source.
- **Effective-fee comparator** — enter your hashrate; the desk computes gross vs net QTC/day per pool × miner-software combination, stacking pool fee + dev fee (1% + 1% = 1.99% effective, not 2%). Network defaults come from the repo's own chain snapshots (block reward 0.309 QTC avg of last 20 blocks; ≈25.53 TH/s from difficulty @ height 142417, both 2026-09-30) and are user-overridable. Includes a solo-lottery line (expected days per block at 0% fee) and a 1×/1.5×/2× network-hashrate sensitivity table.
- **Connection command builder** — pick pool + miner software, paste your `qz…` address: generates the exact install/verify/run command (AriaMiner getwork blocks include the pool's published SHA-256 for `sha256sum` verification). Address + worker-name validation. Where the pool's live page must be re-copied (Quanpool server/TLS pin, AriaPool TLS pin), the builder emits placeholders and warns — it never invents endpoints.
- **Pool vs Solo vs Own node matrix** — the real tradeoff table (who finds the block, fee, payout feel, trust, min payout).
- **PPLNS explainer** — how the last-N-shares window works, what AriaPool's 2×-difficulty window means in practice, confirmations → payout flow.
- **Run your own pool** — `not-only-mining-pool` (open-source Go pool software): Quantus engine in the default build — native QUIC (`quantus-miner/2`) + LuckyPool Quantus Stratum over TCP/TLS, pure-Go Poseidon2 verification, PROP/SOLO payouts, E2E-validated on a real node in CI.
- **Safety checklist + Sources** — address-only rule, checksum verification, re-copy discipline, and every number traced to its source with read date.

## Honest boundaries

- Terms, endpoints, and TLS pins are **snapshots dated 2026-10-01** — pools change them. The page says so in the hero, the trust strip, every command warning, and the footer.
- Quanpool's server address and TLS pin are **never** shown from memory: the builder emits `PASTE_SERVER_FROM_SITE` / `PASTE_FROM_SITE` with instructions to copy the live Start mining tab.
- The directory is curated, not exhaustive: two pools are documented well enough to list with verified terms. A contribution pointer (@kshot9000) is on the page.
- Network defaults are labeled with their snapshot dates and are editable.

## Method & sources

All pool facts read 2026-10-01: `pool.ariabrain.com/qtc.html` (AriaPool: fee, PPLNS window = 2× difficulty, payouts 06:00/18:00 Paris, min 0.11 QTC, endpoints, miner builds + SHA-256, TLS pin, QPoW constants); the `0xmoei/quantus` community guide (Quanpool terms as published on quanpool.com: 1% pool fee, 5% quanpool-miner dev fee, PPLNS/Solo, min 0.25 QTC, hourly payouts, 105 confirmations); `github.com/mining-pool/not-only-mining-pool` (pool software engine docs); `quantus.com` weekly update 2026-09-16 (network hashrate context).

## Tests

- `node tests/pool-desk.test.js` — 84/84 logic tests (fee stacking, comparator math, solo stats, validators, command builder for all 5 pool×miner combos, data integrity of every published fact).
- Real-browser QA via `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-pooldesk-browser.mjs` (headless Chromium, file:// + CDP, zero console errors).

100% client-side. Built by [@kshot9000](https://x.com/kshot9000) · QTC donations: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
