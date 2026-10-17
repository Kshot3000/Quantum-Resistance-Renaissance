# QTC Airgap Desk — the offline signing lab

Sign QTC transfers on a machine that never touches the network.

**Live:** https://kshot3000.github.io/Quantum-Resistance-Renaissance/pages/airgap-desk/

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
- QR decode canvas is bounded by `qrCanvasSize` (`MAX_QR_DIM` 2048): oversize
  uploaded images and camera frames are drawn scaled to fit, so a crafted
  huge-dimension image cannot force a multi-GB canvas allocation on the
  cold machine; the decoded bitmap is closed after use.
- QR decode via vendored jsQR 1.4.0 (Apache-2.0), lazy-loaded by `js/qr.js` on first
  scan/upload-decode use — the 251 KB decoder is not part of the initial page load.
- Package assembly merges collected + pasted lines through `mergePackageLines`
  (Set-based, first-wins): the previous per-token `includes()` rescan was
  O(n²) in pasted tokens and froze the cold machine ~17s on a 20k-token
  paste; the dedupe itself is load-bearing — a lone 0x… extrinsic
  assembles only when exactly one distinct line remains.
- Package paste is length-gated before any token is split (Oct 17, 2026):
  `splitPackagePaste` in `js/airgap.js` refuses a paste over
  `MAX_PACKAGE_PASTE_CHARS` (256 KiB — the package file cap, since a paste
  carries exactly what a file carries) on its length alone, with size + cap
  named; `decodeChunks`' string form asks the same `packagePasteRoom` gate
  before its own split. The largest genuine paste (168,103 chars at the
  degenerate 1-byte chunking) fits with headroom; the ungated split alone
  cost ~1 s on a 20M-char paste.
- Optional builder service fee (2026-10-12): the cold desk can add a disclosed fee
  (None / 0.25% / 0.5% default / 1%, capped at 100 bps) ON TOP of the amount as a
  second `transfer_keep_alive` leg to the builder's QTC address inside one atomic
  `Utility.batch_all` — one signature, recipient leg first and untouched. The hot
  decoder accepts exactly that 2-leg batch shape and renders both legs, warning
  when the second leg does not pay the disclosed builder address.
- `tests/run-tests.mjs`: 52/52 protocol tests (ticket/chunk/era codecs, full cold-sign →
  hot-verify round trip incl. tamper and wrong-ticket failures, ML-DSA-87 path,
  service-fee math/batch/decode-whitelist tests; the ticket nonce is held to the
  issuer's u32 grammar — a nonce ≥ 2³² or a non-safe integer the JSON text could
  not carry exactly is refused, never signed).
- Browser QA (`hidden_files/qa-airgap-browser.mjs` in the goal workspace): end-to-end
  sign→verify in headless Chromium, QR encode→decode round trip, tamper rejection, and
  honest offline failure states — zero console/page errors.

## Builder

- X: [@kshot9000](https://x.com/kshot9000)
- Donations (QTC): `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
- Independent builder work — not affiliated with the Quantus team. Built for the Quantus network by [@Quantus-Network](https://github.com/Quantus-Network).
