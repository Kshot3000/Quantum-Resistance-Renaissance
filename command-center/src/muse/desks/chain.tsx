import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import snap from "../snapshot.json";
import { calculateDifficulty, formatNum, selfCheck, shortAddr } from "../format";
import { Badge, CopyButton, Field, Metric, Panel, Row, fieldCls } from "../ui";

const RPC = "wss://rpc.quantus.network";

export function ChainDesk({ slug }: { slug: string }) {
  if (slug === "network-dashboard") return <Network />;
  if (slug === "block-explorer") return <Explorer />;
  if (slug === "consensus-lab") return <Consensus />;
  if (slug === "mempool-desk") return <Mempool />;
  if (slug === "governance-tracker") return <Gov />;
  if (slug === "reversal-desk") return <Reversal />;
  if (slug === "node-desk") return <Node />;
  return <Console />;
}

function useRpc(method: string, params: unknown[] = []) {
  const paramsKey = JSON.stringify(params);
  const [state, setState] = useState<{ status: "idle" | "open" | "done" | "error"; text: string }>({
    status: "idle",
    text: "",
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let dead = false;
    setState({ status: "open", text: "Connecting…" });
    try {
      ws = new WebSocket(RPC);
    } catch {
      setState({ status: "error", text: "WebSocket is not available." });
      return;
    }
    const timer = window.setTimeout(() => {
      if (!dead) setState({ status: "error", text: "The public node did not answer in 8 seconds." });
      ws?.close();
    }, 8000);
    ws.onerror = () => {
      if (!dead) setState({ status: "error", text: "The socket failed. The snapshot below is still valid." });
    };
    ws.onopen = () => {
      ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: JSON.parse(paramsKey) as unknown[] }));
    };
    ws.onmessage = (ev) => {
      if (dead) return;
      window.clearTimeout(timer);
      setState({ status: "done", text: String(ev.data) });
      ws?.close();
    };
    return () => {
      dead = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [method, nonce, paramsKey]);
  return { ...state, retry: () => setNonce((n) => n + 1) };
}

function Network() {
  const rpc = useRpc("chain_getHeader");
  let live = "";
  if (rpc.status === "done") {
    try {
      const body = JSON.parse(rpc.text) as { result?: { number?: string } };
      if (body.result?.number) live = parseInt(body.result.number, 16).toLocaleString("en-US");
    } catch {
      live = "";
    }
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Snapshot height"><Metric k="Indexer" v={snap.height.toLocaleString("en-US")} s={snap.fetchedAt.slice(0, 16).replace("T", " ") + " UTC"} /></Panel>
        <Panel title="Live head"><Metric k={rpc.status === "done" && live ? "RPC" : "RPC"} v={live || (rpc.status === "error" ? "offline" : "…")} s={RPC} /></Panel>
        <Panel title="Accounts"><Metric k="Total" v={snap.accounts.toLocaleString("en-US")} s={`${snap.transfers.toLocaleString("en-US")} immediate transfers`} /></Panel>
      </div>
      <Panel title="Fourteen days" note="Blocks and transfers per UTC day from the snapshot. The last day may be partial.">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={snap.daily}>
              <XAxis dataKey="date" tick={{ fill: "#9a9588", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#9a9588", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
              <Tooltip contentStyle={{ background: "#181b16", border: "1px solid #31372c", color: "#f4f0e6" }} />
              <Area dataKey="blocks" stroke="#d6f25c" fill="#d6f25c" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel title="Latest blocks">
        {snap.blocks.map((b) => (
          <Row key={b.height} left={`#${b.height.toLocaleString("en-US")} · ${b.time.slice(11, 19)} UTC`} right={`${formatNum(b.reward, 2)} QTC`} />
        ))}
      </Panel>
    </div>
  );
}

function Explorer() {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const hits = snap.blocks.filter((b) => !query || String(b.height).includes(query) || b.hash.toLowerCase().includes(query));
  return (
    <Panel title="Snapshot window" note="Fifteen blocks around the capture. This is not the full chain.">
      <Field label="Height or hash">
        <input className={fieldCls} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} placeholder="158855 or 0xb38a…" />
      </Field>
      <div className="mt-4">
        {hits.length === 0 ? <p className="text-sm text-muted">Nothing in this window.</p> : hits.map((b) => (
          <div key={b.height} className="border-b border-line py-3">
            <div className="flex justify-between text-sm">
              <span className="font-mono text-fg">#{b.height.toLocaleString("en-US")}</span>
              <span className="text-muted">{formatNum(b.reward, 2)} QTC</span>
            </div>
            <div className="mt-1 break-all font-mono text-xs text-faint">{b.hash}</div>
          </div>
        ))}
      </div>
      <a className="mt-4 inline-block text-sm text-signal" href="https://explorer.quantus.com/">Open the chain explorer</a>
    </Panel>
  );
}

function Consensus() {
  const [parent, setParent] = useState("2048000");
  const [ms, setMs] = useState("9000");
  const fails = selfCheck();
  let result = "—";
  let adj = "—";
  try {
    const r = calculateDifficulty(BigInt(parent), BigInt(ms));
    result = r.difficulty.toString();
    adj = r.adjustment.toString();
  } catch {
    result = "Not an integer.";
  }
  return (
    <Panel title="One block of retarget" note="Integer division, same as the pallet. A block faster than 10s steps difficulty up by parent/2048. Slower than 20s steps it down. The fall is capped at 99 steps.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Parent difficulty">
          <input className={fieldCls} value={parent} onChange={(e) => setParent(e.target.value)} />
        </Field>
        <Field label="Block time (ms)" hint="Times under 500 ms are floored. Target is 12,000.">
          <input className={fieldCls} value={ms} onChange={(e) => setMs(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <Row left="Next difficulty" right={result} />
        <Row left="Adjustment steps" right={adj} />
        <Row left="Known-answer check" right={fails.length ? fails.join(", ") : "four vectors match"} />
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">
        Observed mean in the 15,000-block window: {formatNum(snap.blockTimeS, 2)} seconds, against a 12 second target. Settlement depth is 100 blocks.
      </p>
    </Panel>
  );
}

function Mempool() {
  const rpc = useRpc("author_pendingExtrinsics");
  let count = "—";
  let detail = rpc.text;
  if (rpc.status === "done") {
    try {
      const body = JSON.parse(rpc.text) as { result?: unknown; error?: { message?: string } };
      if (Array.isArray(body.result)) count = String(body.result.length);
      else if (body.error?.message) {
        count = "refused";
        detail = body.error.message;
      }
    } catch {
      count = "unreadable";
    }
  } else if (rpc.status === "error") {
    count = "offline";
    detail = rpc.text;
  }
  return (
    <Panel title="Pending extrinsics" note="author_pendingExtrinsics on the public node. An empty pool is a real answer. A refusal is also a real answer.">
      <Metric k="In the pool" v={count} s={rpc.status} />
      <pre className="mt-4 max-h-48 overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-muted">{detail.slice(0, 1200) || "Waiting."}</pre>
      <button type="button" className="mt-3 h-11 rounded-md border border-line px-4 text-sm" onClick={rpc.retry}>Ask again</button>
    </Panel>
  );
}

function Gov() {
  return (
    <div className="grid gap-4">
      <Panel title="Tracks">
        <Row left="tech_collective_members" right="61% support / 60% approval" />
        <Row left="fast_upgrade" right="80% / 80%" />
        <Row left="Undeciding timeout" right="45 days" />
        <p className="mt-3 text-sm text-muted">Flat curve, not a conviction-weighted turnout curve. Numbers are the runtime’s, from the governance desk’s source read.</p>
      </Panel>
      <Panel title="Referendum 0" note="The only referendum in the snapshot. It authorized a runtime upgrade and confirmed.">
        {snap.referenda.map((r, i) => (
          <div key={`${r.type}-${i}`} className="flex items-start justify-between gap-3 border-b border-line py-2">
            <div>
              <div className="text-sm text-fg">{r.type.replaceAll("_", " ")}</div>
              <div className="text-xs text-faint">{r.time.slice(0, 16).replace("T", " ")} UTC · {r.track}</div>
            </div>
            <Badge>{r.summary || "—"}</Badge>
          </div>
        ))}
        {snap.upgradeAt ? <p className="mt-3 text-sm text-muted">Runtime upgrade event: {snap.upgradeAt.slice(0, 16).replace("T", " ")} UTC.</p> : null}
      </Panel>
    </div>
  );
}

function Reversal() {
  const [hours, setHours] = useState("24");
  const [amount, setAmount] = useState("10");
  const fee = (Number(amount) || 0) * 0.01;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Delay planner" note="A reversible transfer burns 1% and stays cancellable until the delay elapses. This does not submit anything.">
        <div className="grid gap-4">
          <Field label="Amount (QTC)">
            <input className={fieldCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Delay (hours)" hint="You choose the delay. The chain enforces the one you sign.">
            <input className={fieldCls} value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4">
          <Row left="Burned fee" right={`${formatNum(fee, 4)} QTC`} />
          <Row left="Recipient sees" right={`${formatNum((Number(amount) || 0) - fee, 4)} QTC if it executes`} />
          <Row left="Cancel window" right={`${hours || "0"} h`} />
        </div>
      </Panel>
      <Panel title="Still scheduled" note={`${snap.scheduledTransfers} scheduled transfers on the status row.`}>
        {snap.scheduled.map((s) => (
          <div key={s.time + s.from} className="border-b border-line py-3 text-sm">
            <div className="flex justify-between"><span className="font-mono text-fg">{formatNum(s.amount, 4)} QTC</span><span className="text-faint">{s.time.slice(0, 10)}</span></div>
            <div className="mt-1 font-mono text-xs text-muted">{shortAddr(s.from)} → {shortAddr(s.to)}</div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Node() {
  const [name, setName] = useState("muse-node");
  const [mode, setMode] = useState<"external" | "local" | "full">("external");
  const [hash, setHash] = useState("");
  const nameOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name);
  const hashOk = mode === "full" || /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  const errors = [
    !nameOk ? "Name: start with a letter or digit, ≤ 40 characters, dots dashes underscores." : "",
    !hashOk ? "Inner hash must be 0x and 64 hex characters. Generate it with quantus-node key quantus --scheme wormhole." : "",
  ].filter(Boolean);
  const cmd = errors.length
    ? ""
    : [
        "./quantus-node",
        "--name", name,
        "--validator",
        mode === "external" ? "--miner-listen-port 9833" : "",
        mode !== "full" ? `--rewards-inner-hash ${hash.trim().toLowerCase()}` : "",
        "--chain mainnet",
        "--max-blocks-per-request 64",
        "--sync full",
      ].filter(Boolean).join(" ");
  const docker = "docker run -d --name quantus-node -p 30333:30333 -v quantus-data:/var/lib/quantus ghcr.io/quantus-network/quantus-node:latest --validator --base-path /var/lib/quantus --chain mainnet --name my-node";
  return (
    <div className="grid gap-4">
      <Panel title="Launch command" note="Flags from chain/node cli and the mining guide. External mode binds the miner QUIC port on all interfaces — keep it off the public internet.">
        <div className="grid gap-4">
          <Field label="Node name">
            <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Mode">
            <select className={fieldCls} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="external">External QUIC miner</option>
              <option value="local">Local CPU mining</option>
              <option value="full">Full node, no mining</option>
            </select>
          </Field>
          {mode !== "full" ? (
            <Field label="Rewards inner hash">
              <input className={fieldCls} value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} placeholder="0x…" />
            </Field>
          ) : null}
        </div>
        {errors.map((e) => <p key={e} className="mt-3 text-sm text-danger">{e}</p>)}
        {cmd ? (
          <div className="mt-4 flex flex-col gap-2">
            <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs text-fg">{cmd}</pre>
            <CopyButton text={cmd} label="Copy command" />
          </div>
        ) : null}
      </Panel>
      <Panel title="Docker" note="The image’s default chain is the retired planck testnet. This command overrides it to mainnet.">
        <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs text-fg">{docker}</pre>
        <div className="mt-3"><CopyButton text={docker} label="Copy docker" /></div>
      </Panel>
    </div>
  );
}

function Console() {
  const [method, setMethod] = useState("system_health");
  const rpc = useRpc(method);
  const recipes = ["system_health", "system_chain", "chain_getHeader", "chain_getFinalizedHead", "system_syncState"];
  return (
    <Panel title="Public RPC" note="Read methods only. Broadcasting a signed extrinsic stays behind the review gate on the published console.">
      <div className="flex flex-wrap gap-2">
        {recipes.map((m) => (
          <button key={m} type="button" onClick={() => setMethod(m)} className={`h-10 rounded-md px-3 font-mono text-xs ${method === m ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>{m}</button>
        ))}
      </div>
      <Field label="Method">
        <input className={fieldCls} value={method} onChange={(e) => setMethod(e.target.value.trim())} />
      </Field>
      <pre className="mt-4 max-h-80 overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-muted">{rpc.text || rpc.status}</pre>
    </Panel>
  );
}
