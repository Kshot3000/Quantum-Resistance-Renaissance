export type Group = "Mine" | "Money" | "Chain" | "Security" | "Build";

export type Tool = {
  slug: string;
  title: string;
  group: Group;
  summary: string;
};

export const GROUPS: Group[] = ["Mine", "Money", "Chain", "Security", "Build"];

export const TOOLS: Tool[] = [
  { slug: "mining-calculator", title: "Mining Calculator", group: "Mine", summary: "Reward estimate from your hashrate using the runtime emission rule and the Oct 3 network snapshot." },
  { slug: "mining-studio", title: "Mining Studio", group: "Mine", summary: "A short setup path: what the node needs, and the commands the mining guide actually uses." },
  { slug: "mining-observatory", title: "Mining Observatory", group: "Mine", summary: "Who mined the last 15,000 blocks: Nakamoto coefficient, Herfindahl index, and the leaderboard." },
  { slug: "pool-desk", title: "Pool Desk", group: "Mine", summary: "The two pools with fees checked in the directory, plus an effective-fee comparison." },
  { slug: "luck-lab", title: "Luck Lab", group: "Mine", summary: "Solo-wait quantiles. How long until your share of the network finds a block, without a fake luck score." },
  { slug: "energy-observatory", title: "Energy Observatory", group: "Mine", summary: "Power and electricity cost from a hashrate and an efficiency band. No single invented watts-per-hash." },
  { slug: "tokenomics", title: "Tokenomics", group: "Money", summary: "21 million cap, the 27% genesis mint, and the miner tail — from the supply snapshot, not a pie-chart sketch." },
  { slug: "emission-lab", title: "Emission Lab", group: "Money", summary: "R = (21M − S) / 50,000,000. Drag supply forward and watch the block reward decay. No halvings." },
  { slug: "supply-audit", title: "Supply Audit", group: "Money", summary: "Indexer supply, mined total, genesis mint, and the note that balances ran about 0.75% hot versus the emission recurrence." },
  { slug: "vesting-desk", title: "Vesting Desk", group: "Money", summary: "Three cohorts, 48 schedules, 5.67 million QTC. What is vested, what is claimed, and when the cliff opens." },
  { slug: "whale-watch", title: "Whale Watch", group: "Money", summary: "The liquid rich list, balance brackets, and the largest recent moves. The vesting pool is labeled, not mixed into ‘whales’." },
  { slug: "fee-throughput-lab", title: "Fee & Throughput", group: "Money", summary: "Length fee at 100,000 plancks per byte, the 1% high-security burn, and the 0.04% wormhole exit." },
  { slug: "swap-desk", title: "Swap Desk", group: "Money", summary: "NEAR Intents is the announced first venue. There is still no public QTC price — this desk will not invent one." },
  { slug: "pay-desk", title: "Pay Desk", group: "Money", summary: "Build a payment request: checksum-checked address, exact plancks, and a copyable qtc: string. It does not broadcast." },
  { slug: "distribution-planner", title: "Distribution Planner", group: "Money", summary: "Add recipients, reject bad addresses, total the plancks, and draft a quantus batch send script. It never signs." },
  { slug: "ledger-desk", title: "Ledger Desk", group: "Money", summary: "A local lot ledger. FIFO cost basis on the amounts you type in. No market price is assumed." },
  { slug: "flow-tracer", title: "Flow Tracer", group: "Money", summary: "The largest recent moves from the whale snapshot, with from/to. Full hop-by-hop graphs stay on the published tracer." },
  { slug: "portfolio-desk", title: "Portfolio Desk", group: "Money", summary: "A local vault of addresses you control, with checksums. Balances are not fabricated — the indexer blocks other origins." },
  { slug: "network-dashboard", title: "Network Dashboard", group: "Chain", summary: "Height, accounts, a 14-day activity chart, the latest blocks, and a live RPC head when the public node answers." },
  { slug: "block-explorer", title: "Block Explorer", group: "Chain", summary: "Search the snapshot window by height or hash. Older blocks belong to the published explorer." },
  { slug: "consensus-lab", title: "Consensus Lab", group: "Chain", summary: "The exact per-block retarget: +1/2048 when fast, down to −99/2048 when slow, 500 ms floor." },
  { slug: "mempool-desk", title: "Mempool Desk", group: "Chain", summary: "Ask the public node for the pending pool. If the socket is closed, the desk says so." },
  { slug: "governance-tracker", title: "Governance Tracker", group: "Chain", summary: "Referendum #0 from submitted to confirmed, the fast-upgrade track, and the runtime upgrade that followed." },
  { slug: "reversal-desk", title: "Reversal Desk", group: "Chain", summary: "The reversible-transfer delay, the 1% burn, and the scheduled transfers still open in the snapshot." },
  { slug: "node-desk", title: "Node Desk", group: "Chain", summary: "A launch command from the real flags: name, mode, chain, and the wormhole inner hash. Invalid input does not emit a command." },
  { slug: "chain-console", title: "Chain Console", group: "Chain", summary: "One-click JSON-RPC against wss://rpc.quantus.network — header, health, and a custom method." },
  { slug: "quantum-shield", title: "Quantum Shield", group: "Security", summary: "Why the signature is ~7 KB, how many transfers fit in a 3.75 MB block, and what Shor actually breaks." },
  { slug: "threat-lab", title: "Threat Lab", group: "Security", summary: "Three published horizon years, and what is already exposed on Bitcoin, Ethereum, and Quantus." },
  { slug: "exposure-lab", title: "Exposure Lab", group: "Security", summary: "Walk a coin from ‘address only’ to ‘public key on chain’. Quantus does not take the elliptic-curve path." },
  { slug: "safesend", title: "SafeSend Lab", group: "Security", summary: "Schedule a reversible send in the planner: delay, 1% fee, and the cancel window. Nothing is submitted." },
  { slug: "key-forge", title: "Key Forge", group: "Security", summary: "What an ML-DSA key card contains. This desk does not mint keys — derivation needs the upstream Poseidon2 hash." },
  { slug: "vanity-forge", title: "Vanity Forge", group: "Security", summary: "Expected trials for a brandable tail. Grinding real ML-DSA keys stays in the published forge." },
  { slug: "web-wallet", title: "Web Wallet", group: "Security", summary: "The custody path: phrase, ML-DSA, Poseidon2 address, encrypted vault, signed transfer. This page does not hold a key." },
  { slug: "airgap-desk", title: "Airgap Desk", group: "Security", summary: "Hot ticket, cold signature, hot broadcast. The QR protocol is unchanged; this is the procedure, not a second signer." },
  { slug: "contact-vault", title: "Contact Vault", group: "Security", summary: "A local address book plus a paste check: checksum, exact match, and lookalike distance." },
  { slug: "legacy-vault", title: "Legacy Vault", group: "Security", summary: "Split a secret with Shamir over GF(2⁸) in the browser. Shares are not uploaded. This does not move funds." },
  { slug: "multisig-vault", title: "Multisig Vault", group: "Security", summary: "Creation burn, proposal fee, and the refundable deposit from the multisig pallet. Addresses are not invented here." },
  { slug: "watchtower", title: "Watchtower", group: "Security", summary: "Arm local alert rules against an address. Scanning the chain still needs the published watcher." },
  { slug: "address-toolkit", title: "Address Toolkit", group: "Build", summary: "SS58 prefix 189 decode and encode. Checksum is blake2b-512 truncated to 2 bytes, the Substrate rule." },
  { slug: "dev-hub", title: "Developer Hub", group: "Build", summary: "The constants you actually need: prefix, decimals, pallet notes, RPC, and the emission divisor." },
  { slug: "benchmark-lab", title: "Benchmark Lab", group: "Build", summary: "Quantus beside Bitcoin, Ethereum, Solana, and Ergo. Every cell keeps the badge the research used." },
  { slug: "extrinsic-lab", title: "Extrinsic Lab", group: "Build", summary: "The wire order of a signed extrinsic. Arbitrary hex still belongs to the published decoder and its call table." },
  { slug: "scale-lab", title: "SCALE Lab", group: "Build", summary: "Encode and strict-decode a compact integer. Non-canonical forms are rejected, not ‘fixed’." },
  { slug: "proposal-studio", title: "Proposal Studio", group: "Build", summary: "The two tracks and the origin bytes that matched referendum #0. Drafting a wasm upgrade stays in the published studio." },
  { slug: "cli-forge", title: "CLI Forge", group: "Build", summary: "Build a quantus command from shapes verified against the CLI: send, wallet create, balance, multisig create." },
  { slug: "notary-desk", title: "Notary Desk", group: "Build", summary: "SHA-256 a file in the browser and copy a timestamp envelope. Anchoring it on chain is a separate, explicit step." },
  { slug: "zktree-desk", title: "ZkTree Desk", group: "Build", summary: "What the 4-ary Poseidon tree is for. Leaf hashes are not recomputed here — that needs the chain’s exact Poseidon2." },
];

export function toolBySlug(slug: string): Tool | undefined {
  return TOOLS.find((t) => t.slug === slug);
}

export const PAGES = "https://kshot3000.github.io/Quantus-Muse-Builder/pages";
