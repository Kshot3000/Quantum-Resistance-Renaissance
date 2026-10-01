# QTC SCALE Lab — the codec workbench

Interactive Substrate SCALE codec workbench for the Quantus chain. Every byte Quantus puts on the wire is SCALE-encoded — extrinsics, storage keys, RPC payloads. This lab lets you encode and decode the codec by hand. 100% client-side, zero network calls.

**Live:** https://kshot3000.github.io/Quantus-Muse-Builder/pages/scale-lab/

## Tabs

1. **Compact Lab** — canonical compact-integer encoder (decimal/`0x` hex in, always the single canonical encoding out) and a strict/lax decoder. Strict mode rejects non-canonical encodings (bloated modes, padded big-ints) — the same check that caught a real mode-2 over-read bug in this builder's own extrinsic decoder (2026-09-30). Includes the four-mode spec table and clickable "notorious" values (bloated mode-2, padded big-int).
2. **Type Workbench** — struct schema builder (bool, u8–u128, i8–i128, Compact, Balance, String, bytes, AccountId32, Option\<u8\>, Vec\<u8\>), encode with per-field value inputs, decode pasted hex with the same schema, clickable byte maps with field-span legends. Balance fields show QTC alongside plancks.
3. **Address Coder** — 32-byte pubkey → SS58 (prefix 189, prefix bytes `6f40`, `blake2b-512("SS58PRE" ‖ body)[0..2]` checksum) with a checksum-anatomy diagram; reverse inspector validates alphabet, prefix, key length, and checksum of any SS58 address.
4. **Storage Keys** — `twox_128(pallet) ‖ twox_128(item)` plain keys plus map keys with `Blake2_128Concat` / `Twox64Concat` / `Identity` hashers. Copy-ready for the Chain Console's storage reader.
5. **Vector Vault** — canonical test vectors executed live in the page (compact spec table, primitives, composites, the `twox_128("System")` chain anchor, SS58 round-trip, strict-rejection proof).

## Crypto lineage (no new cryptography)

- `js/vendor/scale-crypto.js` — blake2b (RFC 7693), base58, SS58 codec adapted from `pages/address-toolkit/app.js` (blake2b verified byte-for-byte against Python hashlib/OpenSSL; SS58 validated 2026-09-29 against real upstream Quantus genesis-vesting addresses).
- `js/vendor/twox.js` — xxHash64 / twox_128 adapted from `pages/chain-console/js/lib/xxhash.js`; seed pair (0, 1) verified 2026-09-30 against the chain's `sp-crypto-hashing` via Quantus-Network/chain `frame/support/src/hash.rs`, cross-checked with `@polkadot/util-crypto` (`twox_128("System") = 26aa394eea5630e07c48ae0c9558cef7`).
- `js/scale-codec.js` — the SCALE codec itself (canonical compact encode/decode, fixed-width ints, composites, QTC balance formatting).

## Tests

`node tests/run-tests.mjs` — 62 assertions, all green:
- blake2b-512 against live `node:crypto` (OpenSSL) incl. multi-block inputs; blake2b-128 against hardcoded Python `hashlib` vectors (incl. the parameter-block check that 128-bit output is *not* a truncation of 512-bit output)
- SS58 prefix-189 round-trip, checksum re-verified independently with `node:crypto`, tamper rejection
- `twox_128("System")` chain anchor, storage-key lengths per hasher
- all 13 canonical compact spec vectors (encode + strict decode), non-canonical rejection, compact fuzz round-trips, primitives, composites, span coverage

Browser QA: `~/workspace/goals/quantus-ecosystem-builder/hidden_files/qa-scalelab-browser.mjs` (headless Chromium 152, file:// + CDP) — tab switching, encode/decode flows, address forging, storage keys, vector run-all, zero console errors.
