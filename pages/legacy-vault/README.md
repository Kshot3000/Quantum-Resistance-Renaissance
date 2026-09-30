# QTC Legacy Vault — the inheritance desk for the quantum era

Split your Quantus secret with real Shamir's Secret Sharing, build a beneficiary
plan a non-crypto person can follow, and print the letter your heirs will need.
100% client-side — nothing here moves funds, signs, or touches the chain.

## What it does

- **Shamir Lab** — split any text secret (seed phrase, checkphrase, instructions)
  into *n* shares with threshold *t* over GF(2⁸) (the AES field, 0x11B), recover
  from any *t* shares, and run a one-character tamper demo that shows why share
  integrity matters. One share per location; any *t−1* reveal nothing.
- **Plan** — beneficiaries table (name, relationship, share %, contact, notes),
  holdings register (item / location / how to access), dead-man arrangement
  picker + free text, legacy readiness checklist with weighted score, JSON
  export/import. Autosaves to `localStorage` (`qlv-plan-v1`).
- **Letter** — printable letter of instruction generated from the plan
  (XSS-escaped), with a print stylesheet that outputs only the letter.
- **Methods** — honest comparison of every way to pass QTC on: Shamir shares,
  the on-chain multisig pallet (index 19: 0.03 QTC burned to create, 0.01 QTC
  reserved per proposal), paper/steel, lawyer-held instructions — plus two honest
  "not available" rows: no exchange lists QTC yet, and no dead-man/timelock
  pallet exists in the Quantus runtime.
- **Why / Scope** — the case for planning (hedged, attributed figures), what the
  desk doesn't do, and how the math was verified. Not legal advice.

## Correctness

- `js/shamir.js` — GF(2⁸) multiply via xtime construction, log/exp-table
  inverses, Horner split, Lagrange-at-zero combine. Field axioms tested
  exhaustively (all 255 non-zero inverses); FIPS-197 spot vectors
  (`0x57·0x13=0xfe`) pass.
- `tests/vectors/shamir-vectors.json` — 45 known-answer vectors from
  `tests/gen-vectors.py`, an **independent Python implementation**; the JS
  `combine()` recovers every vector from first-*t* and last-*t* subsets.
- `tests/run-tests.mjs` — 68/68 green: field axioms, split validation,
  deterministic round-trips (n up to 16, secrets to 300 bytes, UTF-8/emoji),
  tamper/duplication/mixed-share rejection, plan validation, readiness math,
  letter XSS escaping.
- Browser QA: `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-legacyvault-browser.mjs`
  (headless Chromium 152, file:// + CDP) — split → recover → tamper demo →
  plan → letter → print sheet, zero console errors.

## Honest limits

- Planning desk only: no wallet, no signing, no broadcasting.
- Splits must be generated on an offline machine; this page can't protect your
  printer, clipboard history, or disk.
- Shamir protects against loss and single-point theft — not against *t*
  colluding holders or a compromised machine.
- Not legal or financial advice; inheritance law varies by jurisdiction.

Built by [@kshot9000](https://x.com/kshot9000) · Donations (QTC):
`qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
