# QTC ZkTree Desk — the ZK Merkle-tree observatory & proof laboratory

Watch the Merkle tree that remembers every Quantus transfer: a 4-ary Poseidon2-Goldilocks tree (pallet 21) whose root is published in every block header and whose leaves back the wormhole privacy exits. Recompute its hashes exactly, grow your own tree, and verify real Merkle proofs against the live chain root — all in your browser.

## What it does

- **Observatory** — live `LeafCount`, `Depth`, `Root`, and `UnprocessedLeaves` from `wss://rpc.quantus.network` via the `ZkTreeApi` runtime API (`state_call`), with `state_getStorage` fallback on the twox_128 `ZkTree` storage keys. Log-scale capacity gauge toward the depth-16 circuit ceiling (4.29B leaves) and an exhaustion projection at the 1-leaf/block mining-reward floor. If the node is unreachable the desk says so — never invents numbers.
- **Leaf Lab** — the exact `tree::hash_leaf`: 8-felt preimage table (4 recipient limbs, transfer_count high/low, asset_id, quantized amount), per-limb canonicalization verdict, quantization and u32-saturation notes. Pinned against the upstream golden vector (`tests.rs::hash_leaf_golden_vector`).
- **Tree Simulator** — append leaves (queued as pending, like the runtime), finalize blocks to run the exact batched fold (`on_finalize` semantics: appends only, one bottom-up pass, children sorted before every hash, empty subtrees read as the zero hash), depth growth with `LeafInserted`/`TreeGrew` event log, and a clickable canvas tree map.
- **Proof Lab** — generate `ZkMerkleProof`s for simulator leaves (index-free, order-independent verification), verify pasted proofs against any root, and run **live chain proofs**: fetch a leaf's SCALE bytes from `ZkTree.Leaves`, fetch `ZkTreeApi_get_merkle_proof`, decode both, and verify against the live root — a trustless check that this desk's math matches the chain's.
- **Wormhole & circuits** — the record → fold → prove → exit story, the depth-16 circuit ceiling trade-off, and an exhaustion projector with rate scenarios.
- **Spec** — every constant, storage item, event, and runtime-API method with its upstream source.

## Honest by design

This desk recomputes hashes and verifies proofs — it does not generate ZK proofs or perform wormhole exits (proving needs the off-chain circuit crates). Leaf contents are public on-chain data; privacy comes from the ZK layer on top, not the tree. Amounts commit with 2-decimal quantization. The simulator's generated leaves are labeled simulated. Read-only: never asks for keys, never signs.

## Data

- Live only: your node's WebSocket RPC (`wss://rpc.quantus.network` by default)
- No snapshots, no fallback datasets, no mock data

## Tests

- `node tests/zktree-tests.mjs` — 83/83 logic tests green, including the upstream `hash_leaf` golden vector, canonicalization vectors, quantization/saturation semantics, capacity math, settled-tree root semantics, proof generation/verification round-trips (incl. tamper resistance), SCALE leaf + proof-RPC codec round-trips, storage-key structure, and exhaustion projections
- Browser QA: real-browser verification of all six tabs, the simulator, proof flows, and attribution — zero console errors
