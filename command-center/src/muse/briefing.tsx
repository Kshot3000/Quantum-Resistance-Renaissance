import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import snap from "./snapshot.json";
import {
  EMISSION_DIV,
  PK_65,
  PK_87,
  SIG_65,
  SIG_87,
  calculateDifficulty,
  formatNum,
  formatQtc,
  plancksToNumber,
  rewardPlancks,
  selfCheck,
  shortAddr,
} from "./format";

const BLOCKS_PER_YEAR = Math.round((365.25 * 24 * 3600) / 12);
const BLOCKS_PER_DAY = 7_200;
const BUDGET = 3_750_000;
const BASE_SUPPLY = BigInt(snap.supplyPlancks);

const SPEC = [
  ["Signature", "ML-DSA-87 · FIPS 204"],
  ["Proof of work", "Poseidon2 · QPoW"],
  ["Emission", "(21M − S) / 50,000,000"],
  ["Target", "12 s · floor 500 ms"],
  ["Retarget", "integer step / 2048"],
  ["Account", "SS58 prefix 189"],
  ["Planck", "10¹² per QTC"],
  ["Miner tax", "none on the coinbase"],
] as const;

function walkForward(start: bigint, blocks: number): bigint {
  let s = start;
  for (let i = 0; i < blocks; i++) {
    const r = rewardPlancks(s);
    if (r === 0n) return s;
    s += r;
  }
  return s;
}

export function Briefing() {
  const fails = useMemo(() => selfCheck(), []);
  return (
    <div>
      <p className="text-xs font-medium tracking-widest text-signal">
        BRIEFING · BLOCK {snap.height.toLocaleString("en-US")} · 3 OCT 2026
      </p>
      <div className="mt-4 grid items-start gap-10 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h1 className="max-w-xl font-serif text-5xl leading-none text-fg sm:text-7xl">
            Lattice,
            <span className="mt-2 block italic text-signal">before block one.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted">
            Three pieces of the runtime, recomputed in the browser from the Oct 3 indexer snapshot: the emission
            recurrence in integer plancks, the per-block difficulty step, and what an ML-DSA signature costs a 3.75&nbsp;MB
            block. The other instruments are below. Nothing here signs, and nothing here is a price.
          </p>
          <p className="mt-4 font-mono text-xs text-faint">
            {fails.length === 0
              ? "Integer self-check passed · flat, +1, −1, and the −99 cap · compact canonical forms"
              : `Self-check failed · ${fails.join(", ")}`}
          </p>
        </div>
        <div className="border-y border-line lg:col-span-5">
          {SPEC.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-b-0">
              <span className="text-sm text-muted">{k}</span>
              <span className="text-right font-mono text-sm text-fg">{v}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-14">
        <EmissionWalk />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Retarget />
        <SignatureBudget />
      </div>
      <div className="mt-6">
        <Concentration />
      </div>
    </div>
  );
}

function EmissionWalk() {
  const [blocks, setBlocks] = useState(0);
  const [supply, setSupply] = useState(BASE_SUPPLY);
  const [walking, setWalking] = useState(false);
  const supplyRef = useRef(BASE_SUPPLY);
  const blocksRef = useRef(0);
  const reward = rewardPlancks(supply);
  const next = rewardPlancks(reward === 0n ? supply : supply + reward);
  const delta = next - reward;
  const r0 = plancksToNumber(rewardPlancks(BASE_SUPPLY));
  const halfLifeYears = Math.log(2) / (BLOCKS_PER_YEAR / Number(EMISSION_DIV));

  const pts = useMemo(() => {
    const out: { year: number; reward: number }[] = [];
    for (let i = 0; i <= 72; i++) {
      const year = (i / 72) * 36;
      out.push({ year, reward: r0 * Math.exp((-BLOCKS_PER_YEAR * year) / Number(EMISSION_DIV)) });
    }
    return out;
  }, [r0]);

  function add(n: number) {
    if (walking) return;
    setWalking(true);
    window.setTimeout(() => {
      const nextSupply = walkForward(supplyRef.current, n);
      const nextBlocks = blocksRef.current + n;
      supplyRef.current = nextSupply;
      blocksRef.current = nextBlocks;
      setSupply(nextSupply);
      setBlocks(nextBlocks);
      setWalking(false);
    }, 30);
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif text-3xl text-fg">Emission, one block at a time</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            R = ⌊(21,000,000×10¹² − S) / 50,000,000⌋. Press once. The last digits move. There is no halving event — the
            reward halves in about {formatNum(halfLifeYears, 1)} years only if every block is exactly 12 seconds.
          </p>
        </div>
        <Link to="/t/$slug" params={{ slug: "emission-lab" }} className="text-sm text-signal no-underline">
          Open the full curve
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <p className="text-sm text-muted">{walking ? "Walking the recurrence…" : "This block"}</p>
          <p className="mt-1 font-mono text-3xl text-fg sm:text-4xl">{formatQtc(reward, 12)}</p>
          <p className="mt-1 font-mono text-sm text-faint">{reward.toLocaleString("en-US")} plancks</p>
          <div className="mt-5 border-t border-line">
            <SpecRow k="Next block" v={formatQtc(next, 12)} />
            <SpecRow k="Change" v={`${delta.toLocaleString("en-US")} plancks`} />
            <SpecRow k="Blocks walked" v={blocks.toLocaleString("en-US")} />
            <SpecRow k="Supply after the walk" v={`${formatQtc(supply, 4)} QTC`} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Step onClick={() => add(1)} disabled={walking} label="+1 block" />
            <Step onClick={() => add(BLOCKS_PER_DAY)} disabled={walking} label="+1 day" />
            <Step onClick={() => add(BLOCKS_PER_YEAR)} disabled={walking} label="+1 target-year" />
            <Step
              onClick={() => {
                supplyRef.current = BASE_SUPPLY;
                blocksRef.current = 0;
                setBlocks(0);
                setSupply(BASE_SUPPLY);
              }}
              disabled={walking || blocks === 0}
              label="Reset"
            />
          </div>
          <p className="mt-3 text-sm leading-6 text-faint">
            A target-year is {BLOCKS_PER_YEAR.toLocaleString("en-US")} blocks. The indexer sum sat about 0.75% above the
            emission recurrence in the supply audit — this walk starts from the indexer figure, not a corrected S.
          </p>
        </div>
        <Curve pts={pts} walkedYears={blocks / BLOCKS_PER_YEAR} halfLifeYears={halfLifeYears} />
      </div>
    </section>
  );
}

function Curve({
  pts,
  walkedYears,
  halfLifeYears,
}: {
  pts: { year: number; reward: number }[];
  walkedYears: number;
  halfLifeYears: number;
}) {
  const W = 640;
  const H = 220;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const maxR = pts[0]?.reward || 1;
  const x = (year: number) => padL + (year / 36) * (W - padL - padR);
  const y = (r: number) => padT + (1 - r / maxR) * (H - padT - padB);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.year).toFixed(1)},${y(p.reward).toFixed(1)}`).join(" ");
  const area = `${line} L${x(36).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const mark = Math.min(36, Math.max(0, walkedYears));
  return (
    <div className="lg:col-span-7">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-faint" role="img" aria-label="Continuous sketch of block reward over 36 years">
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1={padL} x2={W - padR} y1={y(maxR * g)} y2={y(maxR * g)} className="stroke-line" strokeWidth="1" />
        ))}
        <path d={area} className="fill-signal/15" />
        <path d={line} className="fill-none stroke-signal" strokeWidth="2" />
        <line x1={x(halfLifeYears)} x2={x(halfLifeYears)} y1={padT} y2={H - padB} className="stroke-muted" strokeDasharray="3 4" />
        {walkedYears > 0.01 ? (
          <line x1={x(mark)} x2={x(mark)} y1={padT} y2={H - padB} className="stroke-fg" strokeWidth="1.5" />
        ) : null}
        <text x={padL} y={H - 8} className="fill-faint text-xs">
          now
        </text>
        <text x={x(halfLifeYears) + 6} y={padT + 12} className="fill-muted text-xs">
          ~{formatNum(halfLifeYears, 1)} y half
        </text>
        <text x={W - padR} y={H - 8} textAnchor="end" className="fill-faint text-xs">
          36 years
        </text>
      </svg>
      <p className="text-sm text-faint">Continuous sketch of the same recurrence. On-chain rewards stay integer plancks.</p>
    </div>
  );
}

function Retarget() {
  const observed = Math.round(snap.blockTimeS * 1000);
  const [ms, setMs] = useState(observed);
  const [parentText, setParentText] = useState("2048000");
  const parent = /^\d+$/.test(parentText) ? BigInt(parentText) : null;
  const step = parent != null && parent > 0n ? calculateDifficulty(parent, BigInt(ms)) : null;
  const pct =
    step && parent
      ? (Number(step.difficulty - parent) / Number(parent)) * 100
      : null;

  const stairs = useMemo(() => {
    const bands = [];
    for (let sec = 0; sec < 60; sec += 10) {
      const at = calculateDifficulty(2_048_000n, BigInt(Math.max(500, sec * 1000 + 500)));
      bands.push({ from: sec, adj: at.adjustment });
    }
    return bands;
  }, []);

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-end justify-between gap-3">
        <h2 className="font-serif text-3xl text-fg">The 2048ths</h2>
        <Link to="/t/$slug" params={{ slug: "consensus-lab" }} className="text-sm text-signal no-underline">
          Full lab
        </Link>
      </div>
      <p className="mt-1 text-sm leading-6 text-muted">
        divisor = ⌊12,000 × 10 / 12⌋ = 10,000 ms. Anything from 10 s to 20 s is a flat step. The snapshot mean,{" "}
        {formatNum(snap.blockTimeS, 2)} s, sits on it.
      </p>

      <div className="mt-4 flex h-24 items-end gap-1" aria-hidden>
        {stairs.map((b) => (
          <div key={b.from} className="flex flex-1 flex-col items-center gap-1">
            <div
              className={`w-full rounded-sm ${ms >= b.from * 1000 && ms < (b.from + 10) * 1000 ? "bg-signal" : "bg-raised"}`}
              style={{ height: `${12 + (Number(b.adj) + 4) * 10}px` }}
            />
            <span className="font-mono text-xs text-faint">{b.adj > 0n ? `+${b.adj}` : String(b.adj)}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-faint">Adjustment by 10-second band, from 0 s to 60 s. The −99 cap is at 1,000 s.</p>

      <label className="mt-4 block">
        <span className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="font-medium text-fg">Block time</span>
          <span className="font-mono text-muted">{formatNum(ms / 1000, 2)} s</span>
        </span>
        <input
          className="h-11 w-full accent-signal"
          type="range"
          min={500}
          max={60000}
          step={100}
          value={Math.min(60000, ms)}
          aria-label="Block time in milliseconds"
          onChange={(e) => setMs(Number(e.target.value))}
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Step onClick={() => setMs(observed)} label="Snapshot mean" />
        <Step onClick={() => setMs(9000)} label="9 s · +1" />
        <Step onClick={() => setMs(12000)} label="12 s · flat" />
        <Step onClick={() => setMs(25000)} label="25 s · −1" />
        <Step onClick={() => setMs(1_000_000)} label="1,000 s · cap" />
      </div>

      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium text-fg">Parent difficulty</span>
        <input
          value={parentText}
          onChange={(e) => setParentText(e.target.value.replace(/[^\d]/g, ""))}
          inputMode="numeric"
          aria-label="Parent difficulty"
          className="h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-sm text-fg outline-none"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Step onClick={() => setParentText("2048000")} label="2,048,000" />
        <Step onClick={() => setParentText("131072")} label="Minimum" />
        <Step onClick={() => setParentText("792000000000000")} label="7.92×10¹⁴ illustrative" />
      </div>
      {step && parent ? (
        <div className="mt-4 border-t border-line">
          <SpecRow k="adj" v={step.adjustment >= 0n ? `+${step.adjustment}` : String(step.adjustment)} />
          <SpecRow k="⌊parent / 2048⌋" v={step.increment.toLocaleString("en-US")} />
          <SpecRow k="Next difficulty" v={step.difficulty.toLocaleString("en-US")} />
          <SpecRow k="Change" v={pct == null ? "—" : `${pct >= 0 ? "+" : ""}${formatNum(pct, 4)}%`} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-danger">Parent must be a positive integer.</p>
      )}
      <p className="mt-3 text-sm leading-6 text-faint">
        2,048,000 is the self-check parent: the increment is exactly 1,000, so a fast block lands on 2,049,000. The
        7.92×10¹⁴ figure is an illustrative order of magnitude, not a value stored in this snapshot.
      </p>
    </section>
  );
}

function SignatureBudget() {
  const [scheme, setScheme] = useState<"87" | "65">("87");
  const sig = scheme === "87" ? SIG_87 : SIG_65;
  const pk = scheme === "87" ? PK_87 : PK_65;
  const raw = sig + pk;
  const fit = Math.floor(BUDGET / raw);
  const [count, setCount] = useState(1);
  const used = Math.min(count, fit) * raw;
  const pct = (used / BUDGET) * 100;
  const classical = 64;
  const scale = SIG_87 + PK_87;

  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-end justify-between gap-3">
        <h2 className="font-serif text-3xl text-fg">What 4,627 bytes buy</h2>
        <Link to="/t/$slug" params={{ slug: "quantum-shield" }} className="text-sm text-signal no-underline">
          Shield
        </Link>
      </div>
      <p className="mt-1 text-sm leading-6 text-muted">
        FIPS 204 sizes. A classical signature is a hairline on the same scale. The block budget is the 3.75 MB normal
        extrinsic limit, not a promise about throughput.
      </p>
      <div className="mt-4 flex gap-2">
        {(["87", "65"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setScheme(s);
              setCount(1);
            }}
            className={`h-11 rounded-md px-3 text-sm font-medium ${scheme === s ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}
          >
            ML-DSA-{s}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <Bar label={`ML-DSA-${scheme} signature + key · ${raw.toLocaleString("en-US")} B`} width={(raw / scale) * 100} hot />
        <Bar label={`Classical signature · ${classical} B`} width={(classical / scale) * 100} />
      </div>

      <label className="mt-5 block">
        <span className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="font-medium text-fg">Raw transfers in one block</span>
          <span className="font-mono text-muted">
            {count.toLocaleString("en-US")} / {fit.toLocaleString("en-US")}
          </span>
        </span>
        <input
          className="h-11 w-full accent-signal"
          type="range"
          min={1}
          max={fit}
          value={Math.min(count, fit)}
          aria-label="Number of raw transfers"
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <div className="mt-3 h-3 overflow-hidden rounded-sm bg-raised">
        <div className="h-3 bg-signal" style={{ width: `${Math.max(pct, 0.6)}%` }} />
      </div>
      <p className="mt-2 text-sm text-faint">
        {formatNum(pct, 2)}% of 3.75 MB. One transfer barely marks the meter — that is why aggregation exists. Design-claim
        throughput stays on the fee desk, not here.
      </p>
      <div className="mt-3">
        <Step onClick={() => setCount(fit)} label="Fill the block" />
      </div>
    </section>
  );
}

function Bar({ label, width, hot }: { label: string; width: number; hot?: boolean }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-sm text-muted">{label}</div>
      <div className="h-3 rounded-sm bg-raised">
        <div className={`h-3 rounded-sm ${hot ? "bg-signal" : "bg-fg"}`} style={{ width: `${Math.max(width, 0.8)}%` }} />
      </div>
    </div>
  );
}

function Concentration() {
  const top = snap.miners.slice(0, 4);
  const topBlocks = top.reduce((a, m) => a + m.blocks, 0);
  const rest = snap.windowBlocks - topBlocks;
  const rows = [
    ...top.map((m) => ({ key: m.address, label: shortAddr(m.address, 6, 4), blocks: m.blocks, share: (m.blocks / snap.windowBlocks) * 100 })),
    { key: "rest", label: `${snap.minerCount - top.length} other finders`, blocks: rest, share: (rest / snap.windowBlocks) * 100 },
  ];
  const bar = ["bg-signal", "bg-fg", "bg-muted", "bg-faint", "bg-line"];
  return (
    <section className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif text-3xl text-fg">Who found the last 15,000 blocks</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Nakamoto coefficient {snap.nakamoto}. Herfindahl {formatNum(snap.hhi, 4)}. The largest address found{" "}
            {formatNum(snap.topShare, 2)}%. This is the snapshot, not a comfort.
          </p>
        </div>
        <Link to="/t/$slug" params={{ slug: "mining-observatory" }} className="text-sm text-signal no-underline">
          Observatory
        </Link>
      </div>
      <div className="mt-5 flex h-10 overflow-hidden rounded-md" aria-hidden>
        {rows.map((r, i) => (
          <div
            key={r.key}
            className={`${bar[i] ?? "bg-line"} ${i < rows.length - 1 ? "border-r-2 border-bg" : ""}`}
            style={{ width: `${r.share}%` }}
            title={`${r.label} ${formatNum(r.share, 2)}%`}
          />
        ))}
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span className={i === 0 ? "font-mono text-signal" : "font-mono text-muted"}>{r.label}</span>
            <span className="font-mono text-fg">
              {formatNum(r.share, 2)}% · {r.blocks.toLocaleString("en-US")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpecRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-b-0">
      <span className="text-muted">{k}</span>
      <span className="text-right font-mono text-fg">{v}</span>
    </div>
  );
}

function Step({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-11 rounded-md border border-line px-3 text-sm font-medium text-fg disabled:opacity-40"
    >
      {label}
    </button>
  );
}
