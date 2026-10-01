# QTC CLI Forge — the `quantus` command builder

Pick a command, fill the fields, get a copy-paste-ready CLI invocation with
live validation, POSIX-safe shell quoting, exact planck previews, and a
downloadable `.sh` script.

## What it does

- **110 commands, 11 groups** — wallets, payments, multisig, tech-collective &
  tech-referenda governance, preimages, vesting, chain data (transfers,
  scheduler, storage, events, blocks), Wormhole private transfers, NEAR
  bridge, airdrops, runtime upgrades, and maintenance. Every command carries
  a risk badge (read-only / handles keys / moves funds / governance /
  dangerous) and a pointer to the exact source file its flags were read from.
- **Source-verified flag map** — every flag, alias, default, conflict rule,
  and required field was read field-by-field from the real CLI source:
  `Quantus-Network/quantus-cli` at rev `531a932` (2026-10-01), `src/cli/*.rs`.
  Commands that don't exist upstream don't exist here.
- **Real validation** — SS58-189 checksum validation with the vendored
  codec (not a prefix check), exact BigInt planck math (12 decimals, no
  float dust), uint ranges (u32/u64/u128), 32-byte hex, Dilithium scheme and
  upgrade-track enums, JSON args, block ranges, and clap conflict rules
  (`--delay-blocks` vs `--delay-seconds`, `--delay` vs `--unit-blocks`) and
  required-unless rules (`storage get --key-type` requires `--key`).
- **Global options bar** — `--node-url` (default `ws://127.0.0.1:9944`),
  `--verbose`, `--wait-for-transaction`, `--finalized-tx`,
  `--cold-request-out`, `--cold-response-in`, `--camera-index`. Defaults are
  omitted from output; non-default globals are prepended before the
  subcommand, exactly where clap expects them.
- **No password field, on purpose** — the CLI rejects passwords on argv
  (`src/wallet/password.rs`). The forge never asks: use
  `QUANTUS_WALLET_PASSWORD`, `QUANTUS_WALLET_PASSWORD_<NAME>`, or
  `--password-file`.
- **Batch file builder** — build a `batch send --batch-file` payouts file
  in the UI: type QTC decimals, get exact planck-integer JSON out.
- **7 verified recipes** — first-run, send-and-verify, reversible round-trip,
  multisig round-trip, governance upgrade flow, cold-wallet QR signing flow,
  batch payout. Each step is generated from the same catalog, downloadable
  as a `.sh` script.

## Honest limits

The forge builds commands — it does not run them, watch the chain, or hold
funds. Validation covers formats, ranges, conflicts, and required flags
against the flag map; it cannot check chain state (balances, collective
membership, whether a proposal ID exists). No price data: NEAR Intents was
announced as the first exchange venue with no listing date as of 2026-10-01.

## Files

- `index.html` — page shell
- `styles.css` — terminal-forge theme (dark phosphor console, quantum glow)
- `js/app.js` — the catalog (11 groups, ~110 commands), serializers,
  validators, recipes, batch builder, and DOM layer. Dual-mode: `require()`s
  cleanly in node for tests, runs in the browser via `DOMContentLoaded`.
- `js/ss58.js` — vendored SS58-189 codec (shared with other hub apps)
- `tests/cli-forge.test.js` — 117 assertions: catalog integrity, exact
  serializer outputs, quoting, validators, real-checksum address tests,
  batch-file builder, recipe integrity. Run with `node tests/cli-forge.test.js`.

## Attribution

Built by [@kshot9000](https://x.com/kshot9000) ·
QTC: `qznY8nwuvWcCCVys4da1oQdysyh8YUZYRjRqgk3S8Wos8kbau`
Independent builder work — not affiliated with the Quantus team.
