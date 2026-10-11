# QTC Pay Desk — the merchant acceptance toolkit

Accept Quantus (QTC) like a merchant. Invoice builder with exact planck
amounts, QR payment requests, a point-of-sale screen, an invoice register,
confirmation guidance, and an embeddable tip-button generator.

## What it does

- **Rate card** — manual QTC/USD rate with a quoted-at timestamp. There is no
  listed QTC spot market yet (NEAR Intents was announced as the first venue;
  no listing date as of 2026-10-01), so every invoice records the rate it was
  quoted at and never silently re-prices.
- **Invoice builder** — line items, quantities, discount, tax; receiving
  address checksum-validated locally (SS58, prefix 189) before an invoice can
  be created. Totals computed in integer cents, converted to exact plancks
  (12 decimals — string math, no float dust).
- **Payment request** — receipt-styled card with a QR encoding the receiving
  address, the QTC amount, exact plancks, address, invoice ID, and a live
  expiry countdown. (No QTC payment-URI standard exists yet, so the QR never
  invents one.)
- **POS mode** — fullscreen overlay: huge amount, QR, countdown, Mark-paid /
  Expire buttons.
- **Optional service fee** — the merchant may add a disclosed Pay Desk
  service fee (0.25% / 0.5% / 1%, or None; capped at 1% in code). The
  customer pays it as a second, separate transfer to the builder's QTC
  address; the merchant leg is the total minus the fee, and the two legs
  sum exactly to the invoice total in plancks (exact BigInt math, fee
  floored so it never exceeds the quoted percentage). The fee is shown in
  the builder totals, the payment request, the POS screen, and the CSV
  export — never hidden, and this page never holds or forwards funds.
- **Invoice register** — localStorage ledger of every request with statuses
  (pending / paid / expired / cancelled), "mark paid" confirmation prompt,
  CSV export. **Statuses are merchant attestations, not chain truth** — you
  verify payment in your wallet or the explorer before marking paid.
- **Confirmation guidance** — value-tiered suggested confirmations, framed
  as heuristics; blocks averaged ~14 s in the Sept 30 chain snapshot and move
  with difficulty.
- **Tip-button generator** — dark / light / minimal embeddable HTML snippets
  with QR, same pattern this builder's footers use.

## Honest limits

No custody, no settlement guarantee, no price oracle, no fiat conversion,
no chain watching. Everything persists in the browser's localStorage;
export CSV before clearing site data. Amounts below the 0.001 QTC
existential deposit are flagged in the playbook.

## Files

- `index.html` — all sections + POS overlay
- `styles.css` — "corner till at midnight" theme (brass on espresso)
- `js/app.js` — all logic; exports pure functions under `module.exports` for node tests
- `js/ss58.js` — SS58 codec extracted verbatim from `../address-toolkit/app.js`
  (blake2b + base58 + ss58Decode), exposed as `window.QTC_SS58`
- `js/qrcode.js` — vendored QR generator (shared copy from Key Forge)
- `tests/pay-desk.test.js` — 83 node tests, all green

## Verification

- `node pages/pay-desk/tests/pay-desk.test.js` — 83/83 pass
- Headless-Chromium browser QA (`hidden_files/qa-paydesk-browser.mjs`) —
  full user flow exercised, zero console/page errors
- Service-fee browser QA (`hidden_files/qa-paydesk-fee.mjs`) — 17/17:
  fee on (legs shown, split stored, POS note) and fee off (no fee leg)

Built by [@kshot9000](https://x.com/kshot9000) · QTC donations:
`qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
