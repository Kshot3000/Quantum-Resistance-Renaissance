import { useState } from "react";
import { CopyButton, Field, Panel, Row, fieldCls } from "../ui";
import { decodeCompact, decodeSs58, encodeCompact, encodeSs58, toHex } from "../format";

export function BuildDesk({ slug }: { slug: string }) {
  if (slug === "address-toolkit") return <Address />;
  if (slug === "dev-hub") return <Dev />;
  if (slug === "benchmark-lab") return <Bench />;
  if (slug === "extrinsic-lab") return <Extrinsic />;
  if (slug === "scale-lab") return <Scale />;
  if (slug === "proposal-studio") return <Proposal />;
  if (slug === "cli-forge") return <Cli />;
  if (slug === "notary-desk") return <Notary />;
  return <Zk />;
}

function Address() {
  const [addr, setAddr] = useState("");
  const [hex, setHex] = useState("");
  const decoded = addr.trim() ? decodeSs58(addr) : null;
  const encoded = hex.trim() ? encodeSs58(hex) : null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Decode" note="Checksum is the first two bytes of blake2b-512 over SS58PRE ‖ body. Prefix 189 is Quantus.">
        <Field label="Address">
          <textarea className={`${fieldCls} h-24 py-2`} value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} />
        </Field>
        {decoded ? (
          decoded.ok ? (
            <div className="mt-3">
              <Row left="Prefix" right={String(decoded.prefix)} />
              <Row left="Checksum" right={decoded.checksumOk ? "matches" : "FAILED"} />
              <p className="mt-2 break-all font-mono text-xs text-muted">{decoded.pubkey}</p>
            </div>
          ) : <p className="mt-3 text-sm text-danger">{decoded.error}</p>
        ) : null}
      </Panel>
      <Panel title="Encode" note="32-byte account id, not a seed. Encoding a random hash will not match a Poseidon2-derived account.">
        <Field label="Account id hex">
          <textarea className={`${fieldCls} h-24 py-2`} value={hex} onChange={(e) => setHex(e.target.value)} spellCheck={false} />
        </Field>
        {encoded ? (
          encoded.ok ? (
            <div className="mt-3 flex flex-col gap-2">
              <code className="break-all font-mono text-sm text-fg">{encoded.address}</code>
              <CopyButton text={encoded.address} />
            </div>
          ) : <p className="mt-3 text-sm text-danger">{encoded.error}</p>
        ) : null}
      </Panel>
    </div>
  );
}

function Dev() {
  const rows: [string, string][] = [
    ["Token", "QTC"],
    ["Decimals", "12 (1 QTC = 10^12 plancks)"],
    ["SS58 prefix", "189"],
    ["Signature", "ML-DSA-65 / ML-DSA-87"],
    ["Block target", "12 seconds"],
    ["Emission", "(21e6 − S) / 50,000,000"],
    ["Cap", "21,000,000 QTC"],
    ["Length fee", "100,000 plancks / byte"],
    ["Existential", "0.001 QTC"],
    ["Multisig pallet", "index 19"],
    ["Public RPC", "wss://rpc.quantus.network"],
    ["Indexer", "sqm.quantus.com — CORS allowlists official domains"],
    ["Chain spec", "mainnet (planck is the retired testnet)"],
    ["Reorg bound", "100 blocks"],
  ];
  return (
    <Panel title="Constants" note="Read from the chain sources the developer desk cites. Vacant pallet indices are omitted rather than guessed.">
      {rows.map(([k, v]) => <Row key={k} left={k} right={v} />)}
    </Panel>
  );
}

const MATRIX: { label: string; cells: [string, string, string][] }[] = [
  { label: "Consensus", cells: [["Quantus", "PoW · QPoW, Poseidon2", "measured"], ["Bitcoin", "PoW · SHA-256d", "measured"], ["Ethereum", "PoS · Gasper since the Merge", "measured"], ["Solana", "PoH + PoS", "measured"], ["Ergo", "PoW · Autolykos v2", "measured"]] },
  { label: "Signatures", cells: [["Quantus", "ML-DSA from genesis", "measured"], ["Bitcoin", "ECDSA / Schnorr", "measured"], ["Ethereum", "ECDSA secp256k1", "measured"], ["Solana", "Ed25519", "measured"], ["Ergo", "Schnorr via Sigma", "measured"]] },
  { label: "Quantum-safe by default", cells: [["Quantus", "Yes", "measured"], ["Bitcoin", "No", "measured"], ["Ethereum", "No", "measured"], ["Solana", "No", "measured"], ["Ergo", "No", "measured"]] },
  { label: "Block time", cells: [["Quantus", "12 s target", "measured"], ["Bitcoin", "10 min", "measured"], ["Ethereum", "12 s slots", "measured"], ["Solana", "~400 ms", "measured"], ["Ergo", "~2 min", "measured"]] },
  { label: "Supply", cells: [["Quantus", "21M, no halvings", "measured"], ["Bitcoin", "21M, halvings", "measured"], ["Ethereum", "No hard cap", "measured"], ["Solana", "Inflationary", "measured"], ["Ergo", "97,739,924.5 ERG max", "measured"]] },
  { label: "Throughput", cells: [["Quantus", "~430 QTPS design target", "claimed"], ["Bitcoin", "~3–7 TPS", "measured"], ["Ethereum", "~12–30 TPS L1", "measured"], ["Solana", "~2–3k typical", "measured"], ["Ergo", "No official TPS figure", "unverified"]] },
];

function Bench() {
  const [row, setRow] = useState(0);
  const metric = MATRIX[row]!;
  return (
    <Panel title={metric.label} note="Badges are the ones the Sept 29 research attached. Claimed is not measured. Prices from that day are left out so they are not mistaken for a live market.">
      <div className="flex flex-wrap gap-2">
        {MATRIX.map((m, i) => (
          <button key={m.label} type="button" onClick={() => setRow(i)} className={`h-10 rounded-md px-3 text-sm ${i === row ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>{m.label}</button>
        ))}
      </div>
      <div className="mt-4">
        {metric.cells.map(([name, value, badge]) => (
          <Row key={name} left={`${name} · ${badge}`} right={value} />
        ))}
      </div>
    </Panel>
  );
}

function Extrinsic() {
  const fields = [
    ["Compact length", "How many bytes follow."],
    ["Version", "The extrinsic version nibble and the signed bit."],
    ["Signer", "MultiAddress, then the SS58 account."],
    ["Signature", "ML-DSA-65 or 87, the heavy field."],
    ["Era", "Mortal era. An expired era is invalid."],
    ["Nonce", "Next account nonce. A stale nonce is refused."],
    ["Tip", "Optional, paid to the miner with the fee."],
    ["Metadata hash mode", "Whether the payload commits to the metadata hash."],
    ["Call", "Pallet index, call index, then SCALE arguments."],
  ];
  return (
    <Panel title="Wire order" note="Pasting hex into a decoder that lacks the runtime call table will mislabel arguments. The published Extrinsic Lab has that table. This page only names the fields, in order.">
      {fields.map(([t, d], i) => (
        <div key={t} className="border-b border-line py-3">
          <div className="text-sm text-fg">{i + 1}. {t}</div>
          <div className="text-sm text-muted">{d}</div>
        </div>
      ))}
    </Panel>
  );
}

function Scale() {
  const [raw, setRaw] = useState("1000000");
  let encoded = "";
  let error = "";
  let round = "";
  try {
    if (raw.trim()) {
      const n = BigInt(raw.trim());
      const bytes = encodeCompact(n);
      encoded = toHex(bytes);
      const back = decodeCompact(bytes);
      round = back.ok ? `${back.value.toString()} in ${back.used} byte(s)` : back.error;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not encode.";
  }
  const [hex, setHex] = useState("");
  let decoded = "";
  if (hex.trim()) {
    const clean = hex.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) decoded = "Hex must be even.";
    else {
      const bytes = Uint8Array.from((clean.match(/../g) ?? []).map((b) => parseInt(b, 16)));
      const d = decodeCompact(bytes);
      decoded = d.ok ? `${d.value.toString()} (${d.used} bytes consumed)` : d.error;
    }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Encode" note="Modes: one byte under 64, two bytes under 16,384, four bytes under 2^30, then a length-prefixed big integer. Non-canonical forms are rejected on the way back.">
        <Field label="Unsigned integer">
          <input className={fieldCls} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : <p className="mt-3 break-all font-mono text-sm text-fg">{encoded}</p>}
        <p className="mt-2 text-sm text-muted">{round}</p>
      </Panel>
      <Panel title="Strict decode">
        <Field label="Hex">
          <input className={fieldCls} value={hex} onChange={(e) => setHex(e.target.value)} spellCheck={false} placeholder="1901" />
        </Field>
        <p className="mt-3 text-sm text-fg">{decoded || "Paste hex to decode."}</p>
      </Panel>
    </div>
  );
}

function Proposal() {
  return (
    <Panel title="What was already proven on chain" note="Referendum #0’s submit call was reproduced byte-for-byte by the published studio. This page records the bytes that matched, and does not emit a new preimage.">
      <Row left="Root origin" right="0x0000" />
      <Row left="FastUpgrade origin" right="0x1700" />
      <Row left="Lookup bound" right="0x02" />
      <Row left="DispatchTime After" right="0x01" />
      <Row left="fast_upgrade track" right="80% / 80%" />
      <Row left="tech collective" right="61% / 60%" />
      <p className="mt-4 text-sm leading-6 text-muted">
        A runtime upgrade is a hash of a wasm blob, noted as a preimage, then submitted. The published Proposal Studio hashes the blob in the browser. Doing it with a different hasher would authorize the wrong code.
      </p>
    </Panel>
  );
}

function Cli() {
  const [kind, setKind] = useState("send");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("1.5");
  const [from, setFrom] = useState("main");
  const [name, setName] = useState("main");
  let cmd = "";
  if (kind === "send") cmd = `quantus send --to ${to || "<qz…>"} --amount ${amount || "0"} --from ${from || "main"}`;
  if (kind === "wallet") cmd = `quantus wallet create --name ${name || "main"} --scheme ml-dsa-65`;
  if (kind === "balance") cmd = `quantus balance ${to || "<qz…>"}`;
  if (kind === "multisig") cmd = `quantus multisig create --signers "alice,bob,charlie" --threshold 2 --from alice`;
  const shapes = [
    ["send", "Send"],
    ["wallet", "Wallet"],
    ["balance", "Balance"],
    ["multisig", "Multisig"],
  ] as const;
  return (
    <Panel title="Command" note="Shapes copied from the CLI forge’s tests. Quote paths that contain spaces. This does not run the command.">
      <div className="flex flex-wrap gap-2">
        {shapes.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setKind(id)} className={`h-10 rounded-md px-3 text-sm ${kind === id ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>{label}</button>
        ))}
      </div>
      <div className="mt-4 grid gap-3">
        {kind !== "multisig" && kind !== "wallet" ? (
          <Field label={kind === "balance" ? "Address" : "To"}>
            <input className={fieldCls} value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
          </Field>
        ) : null}
        {kind === "send" ? (
          <Field label="Amount">
            <input className={fieldCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        ) : null}
        {kind === "send" ? (
          <Field label="From wallet">
            <input className={fieldCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        ) : null}
        {kind === "wallet" ? (
          <Field label="Name">
            <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
      </div>
      <pre className="mt-4 overflow-x-auto rounded-md bg-bg p-3 font-mono text-sm text-fg">{cmd}</pre>
      <div className="mt-3"><CopyButton text={cmd} label="Copy" /></div>
    </Panel>
  );
}

function Notary() {
  const [name, setName] = useState("");
  const [hash, setHash] = useState("");
  const [when, setWhen] = useState("");
  const envelope = hash ? `QTC-NOTARY v1\nfile: ${name}\nsha256: ${hash}\nstamped: ${when}\nanchor: not yet — submit a remark or a preimage from a wallet if you want this on chain.` : "";
  return (
    <Panel title="Hash a file" note="SHA-256 in the browser. The file is not uploaded. A hash is not an on-chain proof until a transaction commits to it.">
      <input
        type="file"
        className="block w-full text-sm text-muted file:mr-3 file:h-11 file:rounded-md file:border-0 file:bg-signal file:px-4 file:text-sm file:font-medium file:text-signal-ink"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const buf = await file.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", buf);
          const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          setName(file.name);
          setHash(hex);
          setWhen(new Date().toISOString());
        }}
      />
      {envelope ? (
        <div className="mt-4">
          <pre className="whitespace-pre-wrap rounded-md bg-bg p-3 font-mono text-xs text-fg">{envelope}</pre>
          <div className="mt-3"><CopyButton text={envelope} label="Copy envelope" /></div>
        </div>
      ) : null}
    </Panel>
  );
}

function Zk() {
  return (
    <Panel title="The tree, without a fake hash" note="Quantus uses a 4-ary Poseidon tree for wormhole-style notes. Recomputing a leaf with a different Poseidon would not match the chain, so this page does not offer a hash box.">
      <Row left="Arity" right="4" />
      <Row left="Hash" right="Poseidon2" />
      <Row left="What a proof shows" right="Knowledge of a secret, not the secret" />
      <Row left="What stays visible" right="Amounts and exit addresses" />
      <p className="mt-4 text-sm leading-6 text-muted">
        The published ZkTree desk recomputes leaves with the chain’s constants and can grow a local tree. Use that when you need a hash that has to match. Use this page to remember what the tree is for: burning into H(H(salt ‖ secret)), proving knowledge, aggregating, and withdrawing.
      </p>
    </Panel>
  );
}
