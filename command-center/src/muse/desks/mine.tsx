import { useMemo, useState } from "react";
import snap from "../snapshot.json";
import {
  formatHashrate,
  formatNum,
  formatQtc,
  parseHashrate,
  rewardPlancks,
  shortAddr,
} from "../format";
import { CopyButton, Field, Metric, Panel, Row, fieldCls } from "../ui";

const UNITS = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];
const reward = rewardPlancks(BigInt(snap.supplyPlancks));
const NET = snap.netHashTH * 1e12;

export function MineDesk({ slug }: { slug: string }) {
  if (slug === "mining-calculator") return <Calculator />;
  if (slug === "mining-studio") return <Studio />;
  if (slug === "mining-observatory") return <Observatory />;
  if (slug === "pool-desk") return <Pools />;
  if (slug === "luck-lab") return <Luck />;
  return <Energy />;
}

function Calculator() {
  const [user, setUser] = useState("500");
  const [userUnit, setUserUnit] = useState("MH/s");
  const [net, setNet] = useState(String(snap.netHashTH));
  const [netUnit, setNetUnit] = useState("TH/s");
  const [watts, setWatts] = useState("450");
  const [rate, setRate] = useState("0.12");
  const userH = parseHashrate(Number(user) || 0, userUnit);
  const netH = parseHashrate(Number(net) || 0, netUnit);
  const share = netH > 0 ? userH / netH : 0;
  const perBlock = Number(reward) / 1e12 * share;
  const perDay = perBlock * (86400 / snap.blockTimeS);
  const kwh = ((Number(watts) || 0) * 24) / 1000;
  const powerCost = kwh * (Number(rate) || 0);
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Panel title="Your rig" note="Network rate defaults to the difficulty-implied 68.08 TH/s recorded with the Oct 3 snapshot. Edit it and your number wins.">
        <div className="grid gap-4">
          <HashField label="Your hashrate" value={user} unit={userUnit} onValue={setUser} onUnit={setUserUnit} />
          <HashField label="Network hashrate" value={net} unit={netUnit} onValue={setNet} onUnit={setNetUnit} />
          <Field label="Rig power (watts)">
            <input className={fieldCls} inputMode="decimal" value={watts} onChange={(e) => setWatts(e.target.value)} />
          </Field>
          <Field label="Electricity ($/kWh)" hint="QTC has no public price, so this is cost only — not profit.">
            <input className={fieldCls} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
      </Panel>
      <div className="grid gap-4 lg:col-span-3 sm:grid-cols-2">
        <Panel title="Expected QTC">
          <div className="grid gap-4">
            <Metric k="Per block" v={formatNum(perBlock, 6)} s={`${formatNum(share * 100, 4)}% of the block`} />
            <Metric k="Per day" v={formatNum(perDay, 4)} s={`using observed ${formatNum(snap.blockTimeS, 2)}s blocks`} />
            <Metric k="Per month" v={formatNum(perDay * 30, 3)} s="30 × daily. Luck is not included." />
          </div>
        </Panel>
        <Panel title="Power">
          <Row left="kWh / day" right={formatNum(kwh, 2)} />
          <Row left="Electricity / day" right={`$${formatNum(powerCost, 2)}`} />
          <Row left="Block reward used" right={`${formatQtc(reward, 4)} QTC`} />
          <p className="mt-3 text-sm leading-6 text-faint">
            Last snapshot blocks paid 0.30–0.32 QTC. The formula on indexer supply is {formatQtc(reward, 4)}. The supply audit flagged indexer balances about 0.75% above the emission recurrence.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function HashField({
  label,
  value,
  unit,
  onValue,
  onUnit,
}: {
  label: string;
  value: string;
  unit: string;
  onValue: (v: string) => void;
  onUnit: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input className={fieldCls} inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} />
        <select className={`${fieldCls} w-28`} value={unit} onChange={(e) => onUnit(e.target.value)} aria-label={`${label} unit`}>
          {UNITS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
    </Field>
  );
}

function Studio() {
  const [os, setOs] = useState("Linux");
  const steps = [
    "Get the quantus-node and quantus-miner pair from the same chain release. Mismatched versions fail the QUIC handshake (ALPN quantus-miner/2).",
    "Generate a wormhole identity: quantus-node key quantus --scheme wormhole. Keep the inner hash. Rewards go to that address.",
    "Start the node with --chain mainnet --validator --miner-listen-port 9833 --rewards-inner-hash 0x…. Leave 9833 off the public internet.",
    "Point the miner at 127.0.0.1:9833 with the auth token and TLS pin the node wrote under the chain base path.",
    "Wait until the log says Idle. The freshness gate refuses to mine while the tip is more than 24 hours behind.",
    `Hardware floor from the mining guide: 2 cores, 4 GB RAM, 100 GB disk, 3 Mbps. ${os} uses the same flags; only the path to the binary changes.`,
  ];
  return (
    <Panel title="Six steps" note="Commands that depend on your inner hash are built on the Node Desk, where a bad hash is refused.">
      <div className="mb-4 flex flex-wrap gap-2">
        {["Linux", "macOS", "Windows", "Docker"].map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setOs(name)}
            className={`h-10 rounded-md px-3 text-sm ${os === name ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}
          >
            {name}
          </button>
        ))}
      </div>
      <ol className="grid gap-3">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3 text-sm leading-6 text-muted">
            <span className="font-mono text-signal">{String(i + 1).padStart(2, "0")}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Observatory() {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Nakamoto">
          <Metric k="Coefficient" v={String(snap.nakamoto)} s="Miners needed to pass 50% of the window" />
        </Panel>
        <Panel title="Herfindahl">
          <Metric k="HHI" v={formatNum(snap.hhi * 10000, 0)} s="DOJ calls above 2,500 highly concentrated" />
        </Panel>
        <Panel title="Window">
          <Metric k="Blocks" v={snap.windowBlocks.toLocaleString("en-US")} s={`${snap.windowStart.toLocaleString("en-US")} → ${snap.windowEnd.toLocaleString("en-US")}`} />
        </Panel>
      </div>
      <Panel title="Recent leaderboard" note={`${snap.minerCount} miners in ${snap.windowBlocks.toLocaleString("en-US")} blocks. Top address holds ${formatNum(snap.topShare, 1)}%. Top five hold ${formatNum(snap.top5Share, 1)}%.`}>
        {snap.miners.map((m) => (
          <div key={m.address} className="mb-2">
            <div className="mb-1 flex justify-between gap-3 text-sm">
              <span className="font-mono text-fg">{shortAddr(m.address, 10, 8)}</span>
              <span className="text-muted">{formatNum(m.share, 2)}% · {m.blocks.toLocaleString("en-US")}</span>
            </div>
            <div className="h-1.5 rounded-sm bg-raised">
              <div className="h-1.5 rounded-sm bg-signal" style={{ width: `${Math.min(100, m.share)}%` }} />
            </div>
          </div>
        ))}
      </Panel>
      <Panel title="All-time blocks" note="Coinbase counts from the indexer, not a hashrate claim.">
        {snap.allTimeMiners.map((m, i) => (
          <Row key={m.address} left={`${i + 1}. ${shortAddr(m.address)}`} right={m.blocks.toLocaleString("en-US")} />
        ))}
      </Panel>
    </div>
  );
}

function Pools() {
  const [mh, setMh] = useState("500");
  const day = useMemo(() => {
    const h = parseHashrate(Number(mh) || 0, "MH/s");
    const share = h / NET;
    return (Number(reward) / 1e12) * share * (86400 / snap.blockTimeS);
  }, [mh]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Checked pools" note="Fees read Oct 1, 2026. Re-copy the live start command from the pool. Do not invent a TLS pin.">
        <Row left="AriaPool · PPLNS" right="1% pool · 0% stock miner" />
        <Row left="Min payout" right="0.11 QTC" />
        <Row left="Quanpool · PPLNS or solo" right="1% pool" />
        <Row left="Their miner dev fee" right="5% → 6% stacked" />
        <Row left="Min payout" right="0.25 QTC · 105 confs" />
        <p className="mt-3 text-sm leading-6 text-muted">
          <a className="text-signal" href="https://pool.ariabrain.com/qtc.html">AriaPool</a>
          {" · "}
          <a className="text-signal" href="https://quanpool.com/">Quanpool</a>
        </p>
      </Panel>
      <Panel title="What you keep" note="Same gross estimate as the calculator, then the fee. Solo keeps the block when you find it and nothing in between.">
        <Field label="Your hashrate (MH/s)">
          <input className={fieldCls} inputMode="decimal" value={mh} onChange={(e) => setMh(e.target.value)} />
        </Field>
        <div className="mt-4">
          <Row left="Gross / day" right={`${formatNum(day, 4)} QTC`} />
          <Row left="After AriaPool 1%" right={`${formatNum(day * 0.99, 4)} QTC`} />
          <Row left="After Quanpool miner 6%" right={`${formatNum(day * 0.94, 4)} QTC`} />
        </div>
      </Panel>
    </div>
  );
}

function Luck() {
  const [mh, setMh] = useState("500");
  const share = parseHashrate(Number(mh) || 0, "MH/s") / NET;
  const rate = share / snap.blockTimeS;
  const median = rate > 0 ? Math.log(2) / rate : Infinity;
  function q(p: number) {
    if (!(rate > 0)) return Infinity;
    return -Math.log(1 - p) / rate;
  }
  return (
    <Panel title="Solo wait" note="Exponential waits. The median is not the mean — the mean is longer, because long droughts pull it.">
      <Field label="Your hashrate (MH/s)" hint={`Network ${formatHashrate(NET)} from the snapshot.`}>
        <input className={fieldCls} inputMode="decimal" value={mh} onChange={(e) => setMh(e.target.value)} />
      </Field>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Metric k="Share of network" v={`${formatNum(share * 100, 6)}%`} />
        <Metric k="Median wait" v={human(median)} />
        <Metric k="90% chance by" v={human(q(0.9))} />
        <Metric k="Mean wait" v={human(rate > 0 ? 1 / rate : Infinity)} />
      </div>
    </Panel>
  );
}

function human(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 120) return `${formatNum(seconds, 0)} s`;
  if (seconds < 7200) return `${formatNum(seconds / 60, 1)} min`;
  if (seconds < 86400 * 3) return `${formatNum(seconds / 3600, 1)} h`;
  return `${formatNum(seconds / 86400, 1)} days`;
}

function Energy() {
  const [mh, setMh] = useState("500");
  const [lo, setLo] = useState("0.8");
  const [hi, setHi] = useState("2.5");
  const [price, setPrice] = useState("0.12");
  const hash = Number(mh) || 0;
  const wLo = hash * (Number(lo) || 0);
  const wHi = hash * (Number(hi) || 0);
  const p = Number(price) || 0;
  return (
    <Panel title="Efficiency band" note="Joules per megahash is a device property. The desk shows the band you enter — it does not pick a GPU and pretend that is the network.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hashrate (MH/s)">
          <input className={fieldCls} inputMode="decimal" value={mh} onChange={(e) => setMh(e.target.value)} />
        </Field>
        <Field label="Power price ($/kWh)">
          <input className={fieldCls} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Efficient end (J/MH)">
          <input className={fieldCls} inputMode="decimal" value={lo} onChange={(e) => setLo(e.target.value)} />
        </Field>
        <Field label="Hungry end (J/MH)">
          <input className={fieldCls} inputMode="decimal" value={hi} onChange={(e) => setHi(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <Row left="Draw" right={`${formatNum(wLo, 0)}–${formatNum(wHi, 0)} W`} />
        <Row left="Energy / day" right={`${formatNum((wLo * 24) / 1000, 2)}–${formatNum((wHi * 24) / 1000, 2)} kWh`} />
        <Row left="Cost / day" right={`$${formatNum(((wLo * 24) / 1000) * p, 2)}–$${formatNum(((wHi * 24) / 1000) * p, 2)}`} />
      </div>
    </Panel>
  );
}
