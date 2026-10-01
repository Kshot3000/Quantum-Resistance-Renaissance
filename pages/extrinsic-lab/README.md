# QTC Extrinsic Lab — the transaction autopsy desk

Paste any Quantus extrinsic hex and get a full byte-level autopsy: length prefix, version, signer (SS58 + human checkphrase), the embedded ML-DSA-65/87 signature, era, nonce, tip, metadata-hash mode, and every call argument decoded from a **source-verified runtime call table** — then re-derive the exact signing payload and verify the signature locally.

## Tabs

- **Decode** — paste hex → summary cards, a clickable byte map (each section's byte range), a full anatomy table, and richly rendered call arguments (QTC conversions, moment→ISO timestamps, nested `batch_all` calls, multisig signers, honest labels for unknown pallets/calls). Lab samples (transfer, batch, timestamp inherent) are generated locally with fresh ML-DSA keypairs — never broadcast.
- **Verify signature** — rebuilds the exact `SignedPayload` the runtime checks (`call ‖ era ‖ nonce ‖ tip ‖ metadataHashMode ‖ specVersion ‖ txVersion ‖ genesisHash ‖ eraBirthHash`, blake2-256 hashed iff over 256 bytes) and verifies the ML-DSA signature under the chain's `QUANTUS_EXTRINSIC` FIPS-204 context. "Fetch context from node" pulls spec/tx version, genesis hash, and era-birth hash over WebSocket. Immortal eras default the birth hash to genesis, per `CheckEra`.
- **Live blocks** — connects to a Quantus node over WebSocket, scans the latest finalized block, decodes every extrinsic locally, and offers one-click "Autopsy" to load any of them into the decoder.
- **Call reference** — searchable index of every pallet/call/argument layout the decoder understands.

## Verified facts (not assumptions)

The call table (`js/call-table.js`) was read from `Quantus-Network/chain` source at rev `482c5b9` (2026-09-30). Quantus ships **custom pallet forks**, so upstream Substrate defaults were not assumed:

- `ReversibleTransfers.schedule_transfer` amount is a **plain u128, not compact**
- `Utility` exposes **only** `batch_all` (call index 2)
- `Multisig` is a custom pallet (indices 0–6, incl. `create_multisig`)
- `Wormhole` has only `verify_private_batch` (2) / `verify_public_batch` (3)
- `Timestamp.set` takes a **compact** u64 moment
- Extrinsic wire: `0x84`, `MultiAddress::Id`, signature enum `0` = ML-DSA-87 (4627 B sig + 2592 B pubkey) / `1` = ML-DSA-65 (3309 B + 1952 B), mortal-era codec, compact nonce/tip, metadata-hash-mode byte, call

## Crypto

ML-DSA comes from the vendored `@noble/post-quantum` modules (same tree the web wallet uses), loaded via an ES-module bridge that sets `window.QEL_NOBLE`. Everything runs client-side — pasted hex never leaves the browser.

## Tests

`node tests/run-tests.mjs` — 14 tests, all green: real signed extrinsics built with noble ML-DSA, decoded and verified; tamper rejection; both signature schemes; mortal-era birth computation; the >256-byte blake2 hashing rule; a compact-codec round-trip regression suite (all four modes); unknown pallet/call honesty; malformed-input errors.
