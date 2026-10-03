import { useState, type ReactNode } from "react";

export const fieldCls =
  "h-11 w-full rounded-md border border-line bg-bg px-3 text-base text-fg outline-none";

export function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <h2 className="font-serif text-2xl text-fg">{title}</h2>
      {note ? <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-fg">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-sm leading-5 text-faint">{hint}</span> : null}
    </label>
  );
}

export function Metric({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-muted">{k}</div>
      <div className="mt-1 truncate font-mono text-lg text-fg">{v}</div>
      {s ? <div className="mt-1 text-sm text-faint">{s}</div> : null}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="h-11 shrink-0 rounded-md border border-line bg-raised px-4 text-sm font-medium text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-sm border border-line px-2 font-mono text-xs uppercase tracking-wide text-muted">
      {children}
    </span>
  );
}

export function Row({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-b-0">
      <span className="text-muted">{left}</span>
      <span className="text-right font-mono text-fg">{right}</span>
    </div>
  );
}
