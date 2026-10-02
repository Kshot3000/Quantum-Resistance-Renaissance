# QTC Airgap Desk — the offline signing lab

Sign QTC transfers on a machine that never touches the network.

**Live:** https://kshot3000.github.io/Quantus-Muse-Builder/pages/airgap-desk/

## The protocol

1. **Hot desk (online)** issues a *chain ticket* — sender address, next nonce, genesis hash,
   spec/transaction versions, head number+hash, and the mortal-era window — packed as
   `QAGT1:<base64url>`, small enough for a single QR.
2. **Cold desk (offline)** imports the ticket (scan/paste/file), builds the
   `Balances.transfer_keep_alive` call locally, and signs with real in-browser ML-DSA-65/87
   keys under the chain's `QUANTUS_EXTRINSIC` context. The signed extrinsic leaves as numbered
   chunks `QAGX:<session>:<i>/<n>:<base64url>` — chunked QRs, text, or a `.qagx` file.
   The signing key is wiped from memory the moment signing finishes.
3. **Hot desk** reassembles (any order, duplicates tolerated), decodes the extrinsic, re-derives
   the exact signing payload **from the ticket** — not from values inside the package — and
   verifies the ML-DSA signature locally. Only then is the exact node fee quoted
   (`payment_queryFeeDetails` on the final bytes), the nonce/era freshness checked against
   `accountNextIndex` and the current head, and broadcast offered via `author_submitExtrinsic`.

## Safety properties

- The cold side **refuses to sign** unless the imported key derives to the ticket's sender address.
- The destination gets a human checkphrase (real upstream algorithm) with a read-back challenge.
- A tampered package — one flipped byte — fails local verification loudly; broadcast stays disabled.
- Stale nonces and expired 64-block eras are refused with a re-issue path, not retried.
- What no page can do: prove the cold machine was actually offline. The airgap is a procedure.

## Implementation notes

- Crypto modules (`js/lib/`, `../../assets/vendor/noble`, `../../assets/vendor/qrcode.js`, wordlist) come
  from the shared vendor tree (`assets/vendor/`), byte-identical to what was verified against
  Quantus-Network/chain + sp-runtime source — one shared copy instead of per-app duplicates
  since the 2026-10-01 vendor consolidation.
- QR decode via vendored jsQR 1.4.0 (Apache-2.0), lazy-loaded by `js/qr.js` on first
  scan/upload-decode use — the 251 KB decoder is not part of the initial page load.
- `tests/run-tests.mjs`: 22/22 protocol tests (ticket/chunk/era codecs, full cold-sign →
  hot-verify round trip incl. tamper and wrong-ticket failures, ML-DSA-87 path).
- Browser QA (`hidden_files/qa-airgap-browser.mjs` in the goal workspace): end-to-end
  sign→verify in headless Chromium, QR encode→decode round trip, tamper rejection, and
  honest offline failure states — zero console/page errors.

## Builder

- X: [@kshot9000](https://x.com/kshot9000)
- Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
