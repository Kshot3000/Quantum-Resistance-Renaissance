# QTC Luck Lab

The mining-luck & variance laboratory for Quantus: the true *distribution* of mining outcomes, not just the average. Solo block-wait luck quantiles, a seeded Monte Carlo wait histogram, a probability tool, drought odds, a pool-vs-solo daily-earnings simulator, and difficulty-shock scenarios — all on live chain numbers.

**Live:** https://kshot3000.github.io/Quantum-Resistance-Renaissance/pages/luck-lab/

## What it does

- **Network pulse** — difficulty, implied network hashrate (D ÷ 12 s), current block reward from the exact emission formula R = (21M − total issuance)/50M, and blocks/day from recent block times. Live-first indexer head check; snapshot fallback with honest labeling.
- **Solo luck simulator** — enter any hashrate: expected wait, median, p10/p90/p99 luck quantiles, your blocks/day, a "chance of ≥1 block within X" probability tool, and a drought-odds table (P(wait > 2×/3×/5× average) = e^−k). Seeded Monte Carlo histogram with median/mean/p90 markers.
- **Pool variance lab** — fair-proportional pool model: expected daily QTC after your fee, seeded day-by-day simulation of solo vs pool daily earnings as overlaid histograms, p10–p90 band, your share of network. Honest boundaries box states what the model leaves out (PPLNS-window noise, stales, downtime).
- **Difficulty-shock scenarios** — network hashrate ×0.25/×0.5/×2/×4: your new steady-state solo wait plus difficulty catch-up time via the runtime's per-block retarget limits (+1/2048 up, −99/2048 down).
- **Method & caveats** — every formula stated, every assumption listed, QTC-denominated (no invented prices).

## Honest boundaries

- All figures are in QTC, never dollars — there is no price oracle and none is invented.
- Chain numbers are snapshots (refreshed 2026-10-02); the page attempts a live head check and says which it is showing.
- The pool model is fair-proportional with zero stales: the *shape* (pool smooths, fee costs) is exact; the *band width* is a lower bound vs real pools.
- Simulations are seeded and reproducible — they illustrate the distribution, not your future.

## Method & sources

Memoryless-Poisson mining math: solo finds at rate h/D per second, wait exponential with mean D/h; difficulty semantics (E[hashes to win] = D, 12 s target) verified against `pallet_qpow` in Quantus-Network/chain — see the Consensus Lab. Chain data: public Quantus Subsquid indexer (`sqm.quantus.com`) live-first, `data/consensus.json` + `data/supply.json` snapshots as fallback.

## Tests

- `node tests/luck-core.test.js` — 45/45 logic tests (exponential quantiles, Poisson PMF, seeded-RNG determinism, Monte Carlo convergence to theory, retarget catch-up math, emission formula, formatters).
- Real-browser QA via `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-lucklab-browser.mjs` (headless Chromium, file:// + CDP, zero console errors).

100% client-side. Built by [@kshot9000](https://x.com/kshot9000) · QTC donations: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
