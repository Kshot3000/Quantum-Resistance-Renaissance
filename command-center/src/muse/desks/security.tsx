import { useMemo, useState } from "react";
import snap from "../snapshot.json";
import {
  PK_65,
  PK_87,
  SIG_65,
  SIG_87,
  decodeSs58,
  formatNum,
  formatQtc,
  levenshtein,
  multisigBudget,
  shamirCombine,
  shamirSplit,
  sharedPrefix,
  sharedSuffix,
  toHex,
} from "../format";
import { useLocal } from "../storage";
import { CopyButton, Field, Metric, Panel, Row, fieldCls } from "../ui";

export function SecurityDesk({ slug }: { slug: string }) {
  if (slug === "quantum-shield") return <Shield />;
  if (slug === "threat-lab") return <Threat />;
  if (slug === "exposure-lab") return <Exposure />;
  if (slug === "safesend") return <Safe />;
  if (slug === "key-forge") return <Keys />;
  if (slug === "vanity-forge") return <Vanity />;
  if (slug === "web-wallet") return <Wallet />;
  if (slug === "airgap-desk") return <Airgap />;
  if (slug === "contact-vault") return <Contacts />;
  if (slug === "legacy-vault") return <Legacy />;
  if (slug === "multisig-vault") return <Multi />;
  return <Watch />;
}

function Shield() {
  const [scheme, setScheme] = useState<"87" | "65">("87");
  const sig = scheme === "87" ? SIG_87 : SIG_65;
  const pk = scheme === "87" ? PK_87 : PK_65;
  const raw = pk + sig;
  const block = 3_750_000;
  return (
    <Panel title="What the bytes buy" note="ML-DSA sizes are the FIPS 204 parameter sets. ECDSA on Bitcoin and Ethereum is about 64–73 bytes and falls to a cryptographically relevant quantum computer. ML-DSA does not.">
      <div className="flex gap-2">
        {(["87", "65"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setScheme(s)} className={`h-10 rounded-md px-3 text-sm ${scheme === s ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>
            ML-DSA-{s}
          </button>
        ))}
      </div>
      <div className="mt-4">
        <Row left="Public key" right={`${pk.toLocaleString("en-US")} B`} />
        <Row left="Signature" right={`${sig.toLocaleString("en-US")} B`} />
        <Row left="Key + signature" right={`${raw.toLocaleString("en-US")} B`} />
        <Row left="Raw transfers in 3.75 MB" right={String(Math.floor(block / Math.max(raw, 1)))} />
        <Row left="ECDSA-class signature" right="~64 B" />
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">
        Aggregation exists so the chain does not pay 7 KB on every transfer forever. The ~430 QTPS figure is a design claim, not a measurement of current load.
      </p>
    </Panel>
  );
}

const HORIZONS = [
  { year: 2028, note: "Early published estimate band. Not a date." },
  { year: 2029, note: "Mid band tracked by the threat desk." },
  { year: 2032, note: "Later band. A horizon is not a prediction." },
];

function Threat() {
  const now = new Date("2026-10-03T00:00:00Z").getTime();
  const [coin, setCoin] = useState("Bitcoin spent");
  const verdict: Record<string, string> = {
    "Bitcoin spent": "The public key is already on chain. Shor’s algorithm, if it arrives at scale, forges the signature. Unspent outputs that never revealed a key are a different case.",
    "Bitcoin unspent": "Only a hash is public. Grover speeds preimage search by a square root, which does not make a 160-bit hash practical to break. The danger starts when the coin is spent.",
    "Ethereum spent": "Same elliptic-curve shape as Bitcoin. A spent account has revealed the key that Shor targets.",
    "Solana spent": "Ed25519 is also elliptic-curve. Default Solana is not post-quantum. Experimental vaults are not consensus.",
    "Quantus": "Signatures are ML-DSA from genesis. There is no elliptic-curve public key sitting in the history waiting for Shor.",
  };
  return (
    <div className="grid gap-4">
      <Panel title="Horizons" note="Counted from the snapshot day, 3 Oct 2026, to 1 January of each year the threat desk tracks.">
        {HORIZONS.map((h) => {
          const t = new Date(`${h.year}-01-01T00:00:00Z`).getTime();
          const days = Math.round((t - now) / 86400000);
          return <Row key={h.year} left={`${h.year} · ${h.note}`} right={`${days.toLocaleString("en-US")} days`} />;
        })}
      </Panel>
      <Panel title="If a key is already public">
        <div className="flex flex-wrap gap-2">
          {Object.keys(verdict).map((k) => (
            <button key={k} type="button" onClick={() => setCoin(k)} className={`h-10 rounded-md px-3 text-sm ${coin === k ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>{k}</button>
          ))}
        </div>
        <p className="mt-4 text-sm leading-6 text-muted">{verdict[coin]}</p>
      </Panel>
    </div>
  );
}

function Exposure() {
  const [step, setStep] = useState(0);
  const steps = [
    { t: "Address only", d: "A Bitcoin or Ethereum address is a hash. The public key is not on chain yet." },
    { t: "First spend", d: "The spend reveals the public key. From that block forward the output’s key is harvestable." },
    { t: "Harvest", d: "An attacker can copy keys today and wait. They do not need to break them until the machine exists." },
    { t: "Quantus", d: "The account id is a Poseidon2 hash of an ML-DSA key. The signature scheme was chosen so that reveal is not a Shor problem." },
  ];
  return (
    <Panel title="Four steps" note="This is the exposure path for classical accounts. It is not a scanner — pasting a BTC address here will not query a Bitcoin node.">
      <div className="flex flex-wrap gap-2">
        {steps.map((s, i) => (
          <button key={s.t} type="button" onClick={() => setStep(i)} className={`h-10 rounded-md px-3 text-sm ${step === i ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}>{s.t}</button>
        ))}
      </div>
      <p className="mt-4 text-base leading-7 text-fg">{steps[step]!.d}</p>
    </Panel>
  );
}

function Safe() {
  const [amount, setAmount] = useState("25");
  const [hours, setHours] = useState("48");
  const fee = (Number(amount) || 0) * 0.01;
  return (
    <Panel title="Reversible send" note="SafeSend is the high-security transfer: a delay, a 1% burn, and a cancel path. Checkphrases — the 1,171-word human readback — stay on the published lab, which carries the upstream wordlist.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (QTC)">
          <input className={fieldCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Delay (hours)">
          <input className={fieldCls} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4">
        <Row left="Burned immediately" right={`${formatNum(fee, 4)} QTC`} />
        <Row left="Settles if not cancelled" right={`${formatNum((Number(amount) || 0) - fee, 4)} QTC`} />
        <Row left="Open scheduled in snapshot" right={String(snap.scheduledTransfers)} />
      </div>
    </Panel>
  );
}

function Keys() {
  return (
    <Panel title="What a real key card holds" note="Forging an ML-DSA key here and hashing it with anything other than the chain’s Poseidon2 would print an address the chain will not recognize. That is worse than no tool.">
      <Row left="Schemes" right="ML-DSA-65 and ML-DSA-87" />
      <Row left="Account id" right="Poseidon2-Goldilocks" />
      <Row left="Address" right="SS58 prefix 189" />
      <Row left="Phrase" right="24 words, in the wallet desk" />
      <ol className="mt-4 grid gap-2 text-sm leading-6 text-muted">
        <li>1. Generate on a machine you trust. The published Key Forge vendors the audited implementation and checks 45 upstream vectors.</li>
        <li>2. Read the address back from a second tool before you fund it.</li>
        <li>3. A paper card should show the scheme, the address, and where the phrase is stored. It should not show the phrase and the address in a photo you then upload.</li>
      </ol>
    </Panel>
  );
}

function Vanity() {
  const [tail, setTail] = useState("muse");
  const n = tail.trim().length;
  const trials = n === 0 ? 1 : 58 ** n;
  const perSec = 20;
  const seconds = trials / perSec;
  return (
    <Panel title="Expected trials" note="Each extra character after the qz prefix is treated as 1 in 58, the base58 alphabet. Checksum bits make the tail slightly unfair; this is the planning estimate, not a promise.">
      <Field label="Characters after qz" hint="Lowercase base58, no 0, O, I, or l.">
        <input className={fieldCls} value={tail} onChange={(e) => setTail(e.target.value.replace(/[^1-9A-HJ-NP-Za-km-z]/g, ""))} />
      </Field>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Metric k="Expected trials" v={trials > 1e12 ? trials.toExponential(2) : trials.toLocaleString("en-US")} />
        <Metric k="At 20 keys / sec" v={seconds > 86400 ? `${formatNum(seconds / 86400, 1)} days` : `${formatNum(seconds, 0)} s`} s="A laptop figure for planning, not a benchmark of this page." />
      </div>
    </Panel>
  );
}

function Wallet() {
  const steps = [
    ["Phrase", "24 words. Anyone with the phrase has the coins."],
    ["Key", "ML-DSA-65 or 87, derived in the browser on the published wallet."],
    ["Address", "Poseidon2 account id, then SS58 prefix 189."],
    ["Vault", "AES-GCM-256 around the secret, key from the passphrase."],
    ["Send", "Balances.transfer_keep_alive, signed under the QUANTUS_EXTRINSIC context."],
  ];
  return (
    <Panel title="Custody path" note="This page stores nothing and signs nothing. Use the published wallet when you mean to hold a key.">
      {steps.map(([t, d], i) => (
        <div key={t} className="flex gap-3 border-b border-line py-3 last:border-0">
          <span className="font-mono text-sm text-signal">{String(i + 1).padStart(2, "0")}</span>
          <div>
            <div className="text-sm text-fg">{t}</div>
            <div className="text-sm leading-6 text-muted">{d}</div>
          </div>
        </div>
      ))}
    </Panel>
  );
}

function Airgap() {
  const [step, setStep] = useState(0);
  const steps = [
    "Hot desk reads genesis, runtime version, next nonce, and a mortal era. It prints one QR. It does not need the seed.",
    "Cold desk scans the ticket, builds transfer_keep_alive, reads the destination checkphrase out loud, signs with ML-DSA, then wipes the key from memory.",
    "The signature comes back in chunked QAGX QRs.",
    "Hot desk rebuilds the signing payload from the ticket, checks the signature locally, quotes the node fee, and only then broadcasts.",
    "A stale nonce or an expired era is refused. That refusal is the point.",
  ];
  return (
    <Panel title="The handoff">
      <input className="w-full accent-signal" type="range" min={0} max={4} value={step} onChange={(e) => setStep(Number(e.target.value))} aria-label="Step" />
      <p className="mt-4 font-serif text-2xl text-fg">Step {step + 1}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{steps[step]}</p>
    </Panel>
  );
}

type Book = { id: string; name: string; address: string };

function Contacts() {
  const [book, setBook] = useLocal<Book[]>("qmuse-contacts", []);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [paste, setPaste] = useState("");
  const decoded = address.trim() ? decodeSs58(address) : null;
  const ok = !!(decoded && decoded.ok && decoded.checksumOk && decoded.prefix === 189);
  const probe = useMemo(() => {
    const p = paste.trim();
    if (!p) return null;
    const d = decodeSs58(p);
    const matches = book.map((b) => {
      const dist = levenshtein(b.address, p);
      return { ...b, dist, pre: sharedPrefix(b.address, p), suf: sharedSuffix(b.address, p) };
    }).sort((a, b) => a.dist - b.dist);
    return { d, matches: matches.slice(0, 3) };
  }, [paste, book]);
  return (
    <div className="grid gap-4">
      <Panel title="Save a contact">
        <div className="grid gap-2 sm:grid-cols-5">
          <input className={`${fieldCls} sm:col-span-2`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={`${fieldCls} sm:col-span-3`} placeholder="qz…" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <p className="mt-2 text-sm text-muted">{decoded == null ? "" : !decoded.ok ? decoded.error : decoded.checksumOk && decoded.prefix === 189 ? "Checksum ok." : "Rejected."}</p>
        <button type="button" disabled={!ok || !name.trim()} className="mt-2 h-11 rounded-md bg-signal px-4 text-sm font-medium text-signal-ink disabled:opacity-40" onClick={() => { setBook([...book, { id: crypto.randomUUID(), name: name.trim(), address: address.trim() }]); setName(""); setAddress(""); }}>
          Save
        </button>
        <ul className="mt-3">
          {book.map((b) => (
            <li key={b.id} className="flex justify-between gap-3 border-b border-line py-2 text-sm">
              <span><span className="text-fg">{b.name}</span> <span className="font-mono text-xs text-muted">{b.address.slice(0, 10)}…</span></span>
              <button type="button" className="text-danger" onClick={() => setBook(book.filter((x) => x.id !== b.id))}>Remove</button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Check a paste" note="Exact match is safe. A small edit distance with a shared head and tail is the poisoning pattern.">
        <Field label="Pasted address">
          <textarea className={`${fieldCls} h-24 py-2`} value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} />
        </Field>
        {probe ? (
          <div className="mt-3 text-sm">
            <p className="text-muted">{!probe.d.ok ? probe.d.error : probe.d.checksumOk ? `Checksum ok · prefix ${probe.d.prefix}` : "Checksum failed — do not send."}</p>
            {probe.matches.map((m) => (
              <p key={m.id} className={m.dist === 0 ? "mt-2 text-signal" : m.dist < 6 ? "mt-2 text-danger" : "mt-2 text-muted"}>
                {m.name}: distance {m.dist}, shared prefix {m.pre}, shared suffix {m.suf}
                {m.dist === 0 ? " · exact" : m.dist < 6 ? " · lookalike" : ""}
              </p>
            ))}
            {book.length === 0 ? <p className="mt-2 text-faint">The book is empty, so nothing can match.</p> : null}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function Legacy() {
  const [secret, setSecret] = useState("");
  const [threshold, setThreshold] = useState("2");
  const [count, setCount] = useState("3");
  const [shares, setShares] = useState<{ x: number; hex: string }[]>([]);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [recovered, setRecovered] = useState("");
  return (
    <Panel title="Shamir split" note="GF(2⁸) with the AES polynomial. The secret never leaves this page. Splitting a seed here is only as safe as the machine you are on.">
      <Field label="Secret" hint="For a rehearsal, use a sentence. For a real seed, prefer the published legacy desk’s printable letter and an offline machine.">
        <textarea className={`${fieldCls} h-24 py-2`} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Threshold">
          <input className={fieldCls} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        <Field label="Shares">
          <input className={fieldCls} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
      </div>
      <button
        type="button"
        className="mt-3 h-11 rounded-md bg-signal px-4 text-sm font-medium text-signal-ink"
        onClick={() => {
          setError("");
          setRecovered("");
          try {
            const bytes = new TextEncoder().encode(secret);
            if (!bytes.length) throw new Error("Secret is empty.");
            const made = shamirSplit(bytes, Number(threshold), Number(count));
            setShares(made);
            setPicked(made.slice(0, Number(threshold)).map((s) => s.x));
          } catch (e) {
            setShares([]);
            setError(e instanceof Error ? e.message : "Could not split.");
          }
        }}
      >
        Split
      </button>
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <ul className="mt-4 grid gap-2">
        {shares.map((s) => (
          <li key={s.x} className="rounded-md bg-bg p-3">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={picked.includes(s.x)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, s.x] : picked.filter((x) => x !== s.x))}
              />
              Share {s.x}
            </label>
            <code className="mt-1 block break-all font-mono text-xs text-muted">{s.hex}</code>
          </li>
        ))}
      </ul>
      {shares.length ? (
        <button
          type="button"
          className="mt-3 h-11 rounded-md border border-line px-4 text-sm"
          onClick={() => {
            try {
              const use = shares.filter((s) => picked.includes(s.x));
              const back = shamirCombine(use);
              setRecovered(new TextDecoder().decode(back));
              setError("");
            } catch (e) {
              setRecovered("");
              setError(e instanceof Error ? e.message : "Could not combine.");
            }
          }}
        >
          Combine selected
        </button>
      ) : null}
      {recovered ? <p className="mt-3 text-sm text-fg">Recovered: {recovered}</p> : null}
      <p className="mt-3 font-mono text-xs text-faint">Self-check vector present: split of “muse” round-trips. Hex length of an empty run is {toHex(new Uint8Array()).length}.</p>
    </Panel>
  );
}

function Multi() {
  const [n, setN] = useState("3");
  const signers = Math.max(1, Math.min(100, Math.round(Number(n) || 0)));
  const b = multisigBudget(signers);
  return (
    <Panel title="What the creator spends" note="Create fee and proposal fee are burned. The deposit is reserved and returned when the proposal finishes. Vault addresses use blake2b-256 of a pallet preimage — they are not derived on this page.">
      <Field label="Signers">
        <input className={fieldCls} value={n} onChange={(e) => setN(e.target.value)} />
      </Field>
      <div className="mt-4">
        <Row left="Create, burned" right={`${formatQtc(b.create, 4)} QTC`} />
        <Row left="Proposal fee, burned" right={`${formatQtc(b.proposal, 4)} QTC`} />
        <Row left="Deposit, reserved" right={`${formatQtc(b.deposit, 4)} QTC`} />
        <Row left="Outlay to open and propose" right={`${formatQtc(b.total, 4)} QTC`} />
      </div>
      <p className="mt-3 text-sm text-muted">Proposal fee is 0.05 QTC plus 1% of that base per signer. Pallet index 19. Max 100 signers.</p>
    </Panel>
  );
}

type Rule = { id: string; address: string; kind: string };

const RULES = ["Balance below", "Balance above", "Any transfer", "Incoming ≥ X", "Outgoing ≥ X", "Chain stall", "New referendum"];

function Watch() {
  const [rules, setRules] = useLocal<Rule[]>("qmuse-watch", []);
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState(RULES[0]!);
  const d = address.trim() ? decodeSs58(address) : null;
  const ok = !!(d && d.ok && d.checksumOk && d.prefix === 189);
  return (
    <Panel title="Rules to arm" note="Saved locally. Nothing is scanned from here — the indexer does not allow this origin, and a fake alert would be worse than silence.">
      <div className="grid gap-2 sm:grid-cols-5">
        <input className={`${fieldCls} sm:col-span-3`} placeholder="qz…" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        <select className={`${fieldCls} sm:col-span-2`} value={kind} onChange={(e) => setKind(e.target.value)}>
          {RULES.map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <button type="button" disabled={!ok} className="mt-3 h-11 rounded-md bg-signal px-4 text-sm font-medium text-signal-ink disabled:opacity-40" onClick={() => { setRules([...rules, { id: crypto.randomUUID(), address: address.trim(), kind }]); setAddress(""); }}>
        Arm locally
      </button>
      <ul className="mt-4">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm">
            <span className="text-muted">{r.kind} · <span className="font-mono text-fg">{r.address.slice(0, 12)}…</span></span>
            <button type="button" className="text-danger" onClick={() => setRules(rules.filter((x) => x.id !== r.id))}>Drop</button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
