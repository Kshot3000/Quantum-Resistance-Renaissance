# QTC Web Wallet — v1.34.0

A real self-custody web wallet for Quantus (QTC). Keys are forged in your browser with
post-quantum ML-DSA signatures, addresses derive from the chain's own Poseidon2 hash, and the
vault is encrypted before it ever touches disk. No accounts, no servers — the 24-word phrase
never leaves the page.

Live: https://kshot3000.github.io/Quantum-Resistance-Renaissance/pages/web-wallet/

## What it does

- **Create / import / restore** — fresh 24-word phrase (ML-DSA-65 or ML-DSA-87), import by
  24 words, raw 32-byte seed hex, or secret key, or restore an encrypted vault backup file.
- **Encrypted vault** — AES-GCM-256, key from PBKDF2-HMAC-SHA256 with 250,000 rounds. The
  password gate, lock, wipe, and vault export all operate on-device.
- **Live balances** — reads `System.Account` straight from chain storage over the RPC node
  (`wss://rpc.quantus.network` by default, any Substrate WebSocket RPC works). No estimates.
- **True on-chain sends** — builds a real `Balances.transfer_keep_alive` extrinsic, estimates
  the fee with the node's own `payment_queryFeeDetails`, shows an extrinsic inspector (every
  byte that gets signed), signs with your ML-DSA key, self-checks the signature locally, and
  broadcasts. If there is no node connection, it says so — it never fakes a send.
- **Activity** — recent transfers for your address from the public Subsquid indexer, with an
  honest "unreachable" state instead of invented history.
- **Security tab** — re-reveal the phrase (password-gated), key details, vault backup, and a
  "How the crypto was verified" panel citing the exact upstream sources.

## How the crypto was verified (Sept 30, 2026, against Quantus-Network/chain source)

- Address = `Poseidon2(public_key)` (Goldilocks field) → SS58 prefix **189**
  (`qp-dilithium-crypto 0.6.1 traits.rs` + `quantus-cli address_format.rs`).
- Signature = `DilithiumSignatureScheme::Dilithium65([sig 3309 B ‖ pubkey 1952 B])`
  (`primitives/dilithium-crypto/src/types.rs`).
- Signatures are FIPS-204 with context `QUANTUS_EXTRINSIC` (`signing_context.rs`);
  plain-context signatures are rejected on-chain.
- Extrinsic = `Balances` (pallet **2**) · `transfer_keep_alive` (call **3**)
  (runtime `construct_runtime!` + `pallet-balances 46.0.0`).
- Extension pipeline order (12 extensions) read from `runtime/src/lib.rs` `TxExtension`;
  payload layout matches `sp-runtime 45.0.0 SignedPayload`.
- Derivation path (documented openly in the UI, Quantus-specific): BIP-39 24 words →
  PBKDF2-HMAC-SHA512(2048) → first 32 bytes → deterministic ML-DSA keygen. The authentic
  BIP-39 English wordlist is **embedded** in `js/mnemonic.js` (pinned byte-identical to
  `vendor/bip39-english.txt` by the test suite), so wallet creation works fully offline.

## Tests

```bash
cd pages/web-wallet
node --test tests/run-tests.mjs        # 21/21 offline: xxhash vectors, SCALE codec,
                                       # era math, BIP-39, keygen, sign/verify,
                                       # exact payload/extrinsic layouts
node tests/live-rpc-check.mjs          # live: needs WS egress to rpc.quantus.network
```

Browser QA (headless Chromium, CDP-driven): 22/22 checks green — full
create → reveal → encrypt → dashboard → send-validation → lock/unlock flow, zero console
errors, honest offline states where the sandbox has no network.

## Honest caveats

- The live send path needs a reachable node; the wallet refuses to invent balances, fees,
  or history when offline.
- The end-to-end node submission probe (signed extrinsic from a throwaway unfunded key,
  expecting a funds-only rejection) could not run from the builder's sandbox (no WebSocket
  egress); the wire format is instead verified byte-for-byte against chain and
  `sp-runtime` source, plus 21 offline assertions on the exact layout.
- Reversible transfers / checkphrase flows live in the SafeSend app; this wallet sends
  plain `transfer_keep_alive` (final on inclusion — the UI warns before broadcast).

Built by [@kshot9000](https://x.com/kshot9000) · QTC tips
`qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
