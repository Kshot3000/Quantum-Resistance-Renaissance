import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import snap from "../snapshot.json";
import { CAP_QTC, decodeSs58, formatNum, formatQtc, rewardPlancks, shortAddr } from "../format";
import { useLocal } from "../storage";
import { Badge, CopyButton, Field, Metric, Panel, Row, fieldCls } from "../ui";

export function MoneyDesk({ slug }: { slug: string }) {
  if (slug === "tokenomics") return <Tokenomics />;
  if (slug === "emission-lab") return <Emission />;
  if (slug === "supply-audit") return <Audit />;
  if (slug === "vesting-desk") return <Vesting />;
  if (slug === "whale-watch") return <Whales />;
  if (slug === "fee-throughput-lab") return <Fees />;
  if (slug === "swap-desk") return <Swap />;
  if (slug === "pay-desk") return <Pay />;
  if (slug === "distribution-planner") return <Planner />;
  if (slug === "ledger-desk") return <Ledger />;
  if (slug === "flow-tracer") return <Flows />;
  return <Portfolio />;
}

function Tokenomics() {
  const issued = snap.supplyQtc;
  const remain = CAP_QTC - issued;
  const genesisPct = (snap.genesisQtc / CAP_QTC) * 100;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="The cap" note="27% was minted at genesis into vesting. The other 73% is the miner tail, paid by R = (21M − S) / 50,000,000. No halvings.">
        <Row left="Cap" right="21,000,000 QTC" />
        <Row left="Indexer supply" right={`${formatNum(issued, 3)} QTC`} />
        <Row left="Still to mine" right={`${formatNum(remain, 3)} QTC`} />
        <Row left="Genesis mint" right={`${formatNum(snap.genesisQtc, 3)} QTC`} />
        <Row left="Mined so far" right={`${formatNum(snap.minedQtc, 3)} QTC`} />
        <div className="mt-4 h-2 overflow-hidden rounded-sm bg-raised">
          <div className="h-2 bg-signal" style={{ width: `${(issued / CAP_QTC) * 100}%` }} />
        </div>
        <p className="mt-2 text-sm text-faint">{formatNum((issued / CAP_QTC) * 100, 2)}% of the cap is on the indexer. Genesis was {formatNum(genesisPct, 1)}% of the cap.</p>
      </Panel>
      <Panel title="Where a block reward goes">
        <Row left="Miner" right="100%" />
        <Row left="Dev tax" right="0" />
        <Row left="Treasury cut of the block" right="0" />
        <p className="mt-3 text-sm leading-6 text-muted">
          High-security transfers burn 1% of the amount. Wormhole exits take 0.04%, half of that burned. Those are fees, not a tax on the coinbase.
        </p>
      </Panel>
    </div>
  );
}

function Emission() {
  const [years, setYears] = useState(12);
  const data = useMemo(() => {
    const blocksYear = (365.25 * 24 * 3600) / 12;
    let remaining = CAP_QTC - snap.supplyQtc;
    const rows = [];
    for (let y = 0; y <= years; y++) {
      const supply = CAP_QTC - remaining;
      rows.push({ year: `Y${y}`, reward: (CAP_QTC - supply) / 50_000_000, supply: supply / 1_000_000 });
      remaining *= Math.exp(-blocksYear / 50_000_000);
    }
    return rows;
  }, [years]);
  const now = rewardPlancks(BigInt(snap.supplyPlancks));
  return (
    <Panel title="Decay" note="The curve is the closed form of the integer recurrence, plotted yearly. On-chain rewards are integer plancks, so the live pulse sits on 0.30–0.32 QTC.">
      <Field label={`Horizon · ${years} years`}>
        <input className="w-full accent-signal" type="range" min={1} max={40} value={years} onChange={(e) => setYears(Number(e.target.value))} />
      </Field>
      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <XAxis dataKey="year" tick={{ fill: "#9a9588", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#9a9588", fontSize: 12 }} axisLine={false} tickLine={false} width={48} />
            <Tooltip
              contentStyle={{ background: "#181b16", border: "1px solid #31372c", borderRadius: 8, color: "#f4f0e6" }}
              formatter={(v) => [typeof v === "number" ? formatNum(v, 4) : "—", "QTC / block"]}
            />
            <Area dataKey="reward" stroke="#d6f25c" fill="#d6f25c" fillOpacity={0.18} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <Row left="Reward now" right={`${formatQtc(now, 4)} QTC`} />
      <Row left="Reward at horizon" right={`${formatNum(data[data.length - 1]?.reward ?? 0, 4)} QTC`} />
    </Panel>
  );
}

function Audit() {
  return (
    <Panel title="Reconciliation" note="Protocol emission is a recurrence. The indexer balance sum is a second measurement. They are not the same number, and the published audit flagged the gap.">
      <Row left="Indexer total supply" right={`${formatNum(snap.supplyQtc, 4)} QTC`} />
      <Row left="Genesis transfers" right={`${formatNum(snap.genesisQtc, 4)} QTC`} />
      <Row left="Mined (reward events)" right={`${formatNum(snap.minedQtc, 4)} QTC`} />
      <Row left="Free balances" right={`${formatNum(snap.freeQtc, 4)} QTC`} />
      <Row left="Reserved" right={`${formatNum(snap.reservedQtc, 6)} QTC`} />
      <Row left="Vesting schedules" right={`${snap.vestingSchedules} · ${formatNum(snap.vestingTotalQtc, 2)} QTC`} />
      <Row left="Claimed from vesting" right={`${formatNum(snap.vestingClaimedQtc, 2)} QTC`} />
      <p className="mt-4 text-sm leading-6 text-danger">
        Indexer balances were flagged about +0.75% versus the emission recurrence in the Sept 30 supply audit. Do not treat the indexer sum as the pallet’s S.
      </p>
    </Panel>
  );
}

function Vesting() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return (
    <div className="grid gap-4">
      {snap.cohorts.map((c) => {
        const start = new Date(c.start);
        const end = new Date(c.end);
        const span = c.end - c.start;
        const pct = now == null || span <= 0 ? 0 : Math.min(100, Math.max(0, ((now - c.start) / span) * 100));
        return (
          <Panel key={c.key} title={c.label} note={c.note}>
            <Row left="Schedules" right={String(c.schedules)} />
            <Row left="Total" right={`${formatNum(c.total, 2)} QTC`} />
            <Row left="Vested by snapshot math" right={`${formatNum(c.vested, 4)} QTC`} />
            <Row left="Claimed" right={`${formatNum(c.claimed, 2)} QTC`} />
            <Row left="Window" right={`${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`} />
            <div className="mt-3 h-1.5 rounded-sm bg-raised">
              <div className="h-1.5 rounded-sm bg-signal" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-sm text-faint">{formatNum(pct, 1)}% of the calendar window has elapsed. Cliff equals start on the grant cohort — nothing unlocks as a lump.</p>
          </Panel>
        );
      })}
    </div>
  );
}

function Whales() {
  return (
    <div className="grid gap-4">
      <Panel title="Brackets" note="Counts are free-balance brackets from the indexer, including the vesting pool in the whale band.">
        {snap.brackets.map((b) => (
          <Row key={b.label} left={`${b.label} · ${b.count.toLocaleString("en-US")}`} right={`${formatNum(b.qtc, 2)} QTC`} />
        ))}
      </Panel>
      <Panel title="Top accounts" note="Locked is not spendable. The vesting pool is marked.">
        {snap.whales.map((w) => (
          <Row
            key={w.address}
            left={`${w.rank}. ${shortAddr(w.address)}${w.pool ? " · pool" : ""}`}
            right={`${formatNum(w.liquid, 3)} liquid`}
          />
        ))}
      </Panel>
    </div>
  );
}

function Fees() {
  const [bytes, setBytes] = useState("7500");
  const [amount, setAmount] = useState("10");
  const len = Math.max(0, Math.round(Number(bytes) || 0)) * 100_000;
  const amt = Math.max(0, Number(amount) || 0);
  const high = amt * 0.01;
  const worm = amt * 0.0004;
  const modes = [
    ["Transparent ML-DSA-87", "510 / block", "~43 QTPS", "claimed"],
    ["Encrypted, two-layer", "5,200 / block", "~430 QTPS", "claimed"],
    ["Packing ceiling", "33,000 / block", "~2,750 QTPS", "claimed"],
  ] as const;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Length fee" note="LengthToFee is 100,000 plancks per byte. Weight fee is benchmark-dependent and not added here.">
        <Field label="Extrinsic bytes" hint="A raw ML-DSA-87 transfer is on the order of 7 KB before aggregation.">
          <input className={fieldCls} inputMode="numeric" value={bytes} onChange={(e) => setBytes(e.target.value)} />
        </Field>
        <div className="mt-4">
          <Row left="Length fee" right={`${formatQtc(BigInt(len), 6)} QTC`} />
          <Row left="Plancks" right={len.toLocaleString("en-US")} />
        </div>
      </Panel>
      <Panel title="Volume fees">
        <Field label="Amount (QTC)">
          <input className={fieldCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="mt-4">
          <Row left="High-security 1%, burned" right={`${formatNum(high, 4)} QTC`} />
          <Row left="Wormhole exit 0.04%" right={`${formatNum(worm, 6)} QTC`} />
          <Row left="Of which burned (half)" right={`${formatNum(worm / 2, 6)} QTC`} />
        </div>
      </Panel>
      <Panel title="Throughput badges" note="These are design claims from the architecture notes, not a measurement of today’s mainnet.">
        {modes.map((m) => (
          <div key={m[0]} className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
            <div>
              <div className="text-sm text-fg">{m[0]}</div>
              <div className="text-sm text-muted">{m[1]}</div>
            </div>
            <div className="text-right">
              <div className="font-mono text-sm text-fg">{m[2]}</div>
              <Badge>{m[3]}</Badge>
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Swap() {
  return (
    <Panel title="No listing, no price" note="NEAR Intents was announced as the first venue. As of the Oct 3 snapshot this desk still has nothing to quote.">
      <Row left="Public market price" right="none" />
      <Row left="Venue" right="NEAR Intents" />
      <Row left="What a swap would be" right="1Click, both directions" />
      <p className="mt-4 text-sm leading-6 text-muted">
        When a listing exists, the order has a deadline, a slippage bound, and a refund path if it does not fill. Until the token list actually contains QTC, any “price” on a page is fiction. This one will not show one.
      </p>
    </Panel>
  );
}

function Pay() {
  const [addr, setAddr] = useState("");
  const [amt, setAmt] = useState("1");
  const [memo, setMemo] = useState("");
  const decoded = addr.trim() ? decodeSs58(addr) : null;
  const plancks = BigInt(Math.round((Number(amt) || 0) * 1e12));
  const ok = decoded?.ok && decoded.checksumOk && decoded.prefix === 189;
  const req = ok ? `qtc:${addr.trim()}?amount=${amt}${memo ? `&memo=${encodeURIComponent(memo)}` : ""}` : "";
  return (
    <Panel title="Payment request" note="A request is not a transaction. The payer still signs in a wallet.">
      <div className="grid gap-4">
        <Field label="Pay to">
          <input className={fieldCls} value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} placeholder="qz…" />
        </Field>
        <Field label="Amount (QTC)">
          <input className={fieldCls} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        </Field>
        <Field label="Memo">
          <input className={fieldCls} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-sm text-muted">
        {decoded == null ? "Address not checked yet." : !decoded.ok ? decoded.error : !decoded.checksumOk ? "Checksum failed." : decoded.prefix !== 189 ? `Prefix ${decoded.prefix}, not Quantus 189.` : `Checksum ok · ${plancks.toLocaleString("en-US")} plancks.`}
      </p>
      {req ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <code className="flex-1 break-all rounded-md bg-bg p-3 font-mono text-sm text-fg">{req}</code>
          <CopyButton text={req} />
        </div>
      ) : null}
    </Panel>
  );
}

type Line = { address: string; amount: string };

function Planner() {
  const [lines, setLines] = useLocal<Line[]>("qmuse-dist", [{ address: "", amount: "" }]);
  const rows = lines.map((l) => {
    const d = l.address.trim() ? decodeSs58(l.address) : null;
    const ok = !!(d && d.ok && d.checksumOk && d.prefix === 189 && Number(l.amount) > 0);
    return { ...l, ok, d };
  });
  const good = rows.filter((r) => r.ok);
  const total = good.reduce((s, r) => s + Math.round(Number(r.amount) * 1e12), 0);
  const script = good.length
    ? `quantus batch send \\\n${good.map((r) => `  --to ${r.address.trim()} --amount ${r.amount}`).join(" \\\n")}`
    : "";
  return (
    <Panel title="Recipients" note="Only checksum-valid prefix-189 addresses with a positive amount are totaled. The script is a draft.">
      <div className="grid gap-3">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-5">
            <input
              className={`${fieldCls} sm:col-span-3`}
              placeholder="qz…"
              value={l.address}
              spellCheck={false}
              onChange={(e) => {
                const next = lines.slice();
                next[i] = { ...l, address: e.target.value };
                setLines(next);
              }}
            />
            <input
              className={`${fieldCls} sm:col-span-2`}
              placeholder="QTC"
              inputMode="decimal"
              value={l.amount}
              onChange={(e) => {
                const next = lines.slice();
                next[i] = { ...l, amount: e.target.value };
                setLines(next);
              }}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mt-3 h-11 rounded-md border border-line px-4 text-sm text-fg"
        onClick={() => setLines([...lines, { address: "", amount: "" }])}
      >
        Add recipient
      </button>
      <div className="mt-4">
        <Row left="Valid rows" right={`${good.length} / ${lines.length}`} />
        <Row left="Total plancks" right={total.toLocaleString("en-US")} />
        <Row left="Approx bytes if unaggregated" right={`~${(good.length * 7500).toLocaleString("en-US")}`} />
      </div>
      {script ? (
        <div className="mt-3 flex flex-col gap-2">
          <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-xs text-fg">{script}</pre>
          <CopyButton text={script} label="Copy script" />
        </div>
      ) : null}
    </Panel>
  );
}

type Lot = { id: string; side: "in" | "out"; qty: string; cost: string; note: string };

function Ledger() {
  const [lots, setLots] = useLocal<Lot[]>("qmuse-ledger", []);
  const [side, setSide] = useState<"in" | "out">("in");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const fifo = useMemo(() => fifoBasis(lots), [lots]);
  return (
    <Panel title="FIFO lots" note="You type the events. Price is whatever you paid or received — there is no QTC market feed. Stored only in this browser.">
      <div className="grid gap-3 sm:grid-cols-4">
        <select className={fieldCls} value={side} onChange={(e) => setSide(e.target.value as "in" | "out")} aria-label="Side">
          <option value="in">In (mine or buy)</option>
          <option value="out">Out (sell or spend)</option>
        </select>
        <input className={fieldCls} placeholder="QTC" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input className={fieldCls} placeholder="Cost per QTC" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        <button
          type="button"
          className="h-11 rounded-md bg-signal px-4 text-sm font-medium text-signal-ink"
          onClick={() => {
            if (!(Number(qty) > 0)) return;
            setLots([...lots, { id: crypto.randomUUID(), side, qty, cost, note }]);
            setQty("");
            setCost("");
            setNote("");
          }}
        >
          Add
        </button>
      </div>
      <div className="mt-4">
        <Row left="Open lots" right={`${formatNum(fifo.openQty, 4)} QTC`} />
        <Row left="Open cost" right={formatNum(fifo.openCost, 2)} />
        <Row left="Realized" right={formatNum(fifo.realized, 2)} />
      </div>
      <ul className="mt-3">
        {lots.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm">
            <span className="text-muted">{l.side === "in" ? "In" : "Out"} · {l.qty} QTC @ {l.cost || "—"}</span>
            <button type="button" className="text-danger" onClick={() => setLots(lots.filter((x) => x.id !== l.id))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function fifoBasis(lots: Lot[]) {
  const queue: { qty: number; cost: number }[] = [];
  let realized = 0;
  for (const l of lots) {
    const q = Number(l.qty) || 0;
    const c = Number(l.cost) || 0;
    if (l.side === "in") queue.push({ qty: q, cost: c });
    else {
      let left = q;
      while (left > 0 && queue.length) {
        const head = queue[0]!;
        const take = Math.min(left, head.qty);
        realized += take * (c - head.cost);
        head.qty -= take;
        left -= take;
        if (head.qty <= 1e-12) queue.shift();
      }
    }
  }
  const openQty = queue.reduce((s, x) => s + x.qty, 0);
  const openCost = queue.reduce((s, x) => s + x.qty * x.cost, 0);
  return { openQty, openCost, realized };
}

function Flows() {
  return (
    <Panel title="Recent large moves" note="These are the latest whale-scale transfers in the snapshot, not a full hop graph. Amounts under the whale threshold are absent on purpose.">
      {snap.moves.map((m) => (
        <div key={`${m.height}-${m.from}-${m.to}`} className="border-b border-line py-3 last:border-0">
          <div className="flex justify-between gap-3 text-sm">
            <span className="font-mono text-fg">{formatNum(m.amount, 4)} QTC</span>
            <span className="text-faint">#{m.height.toLocaleString("en-US")}</span>
          </div>
          <div className="mt-1 font-mono text-xs text-muted">
            {shortAddr(m.from)} → {shortAddr(m.to)}
          </div>
        </div>
      ))}
    </Panel>
  );
}

type Contact = { id: string; name: string; address: string };

function Portfolio() {
  const [rows, setRows] = useLocal<Contact[]>("qmuse-portfolio", []);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const decoded = address.trim() ? decodeSs58(address) : null;
  const ok = !!(decoded && decoded.ok && decoded.checksumOk && decoded.prefix === 189);
  return (
    <Panel title="Addresses you control" note="Labels live in this browser. Balances are not shown, because the public indexer does not allow this origin.">
      <div className="grid gap-2 sm:grid-cols-5">
        <input className={`${fieldCls} sm:col-span-2`} placeholder="Label" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${fieldCls} sm:col-span-3`} placeholder="qz…" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {decoded == null ? "" : !decoded.ok ? decoded.error : !decoded.checksumOk ? "Checksum failed." : decoded.prefix !== 189 ? `Prefix ${decoded.prefix}.` : "Checksum ok."}
      </p>
      <button
        type="button"
        disabled={!ok}
        className="mt-2 h-11 rounded-md bg-signal px-4 text-sm font-medium text-signal-ink disabled:opacity-40"
        onClick={() => {
          setRows([...rows, { id: crypto.randomUUID(), name: name || "Untitled", address: address.trim() }]);
          setName("");
          setAddress("");
        }}
      >
        Save address
      </button>
      <ul className="mt-4">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 border-b border-line py-3">
            <div>
              <div className="text-sm text-fg">{r.name}</div>
              <div className="font-mono text-xs text-muted">{r.address}</div>
            </div>
            <button type="button" className="text-sm text-danger" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
