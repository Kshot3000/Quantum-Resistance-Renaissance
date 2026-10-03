import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TOOLS } from "./catalog";
import snap from "./snapshot.json";
import { monogram } from "./format";

export function Chrome({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return TOOLS.slice(0, 6);
    return TOOLS.filter((t) => `${t.title} ${t.group} ${t.summary} ${t.slug}`.toLowerCase().includes(s)).slice(0, 8);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        box.current?.querySelector("input")?.focus();
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-3 text-fg no-underline">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-signal font-serif text-lg text-signal-ink">Q</span>
            <span className="leading-tight">
              <span className="block font-serif text-xl">Muse</span>
              <span className="block text-xs tracking-wide text-muted">Quantus</span>
            </span>
          </Link>
          <div ref={box} className="relative ml-auto w-full max-w-sm">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              placeholder="Search instruments"
              aria-label="Search instruments"
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg outline-none placeholder:text-faint"
            />
            {open ? (
              <ul className="absolute right-0 z-30 mt-2 w-full overflow-hidden rounded-md border border-line bg-surface shadow-none">
                {hits.length === 0 ? (
                  <li className="px-3 py-3 text-sm text-muted">No instrument matches.</li>
                ) : (
                  hits.map((t) => (
                    <li key={t.slug}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-raised"
                        onClick={() => {
                          setOpen(false);
                          setQ("");
                          void navigate({ to: "/t/$slug", params: { slug: t.slug } });
                        }}
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-raised font-mono text-xs text-signal">
                          {monogram(t.title)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-fg">{t.title}</span>
                          <span className="block text-xs text-muted">{t.group}</span>
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
          <div className="hidden shrink-0 font-mono text-xs text-muted sm:block">
            #{snap.height.toLocaleString("en-US")}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-xl leading-6">
            Figures are the Oct 3, 2026 indexer snapshot unless a live RPC line says otherwise. Signing, key
            generation, and Poseidon2 derivation stay on the published desks.
          </p>
          <p className="font-mono text-xs text-faint">
            Built by Kshot · donate {snap.donate.slice(0, 8)}…{snap.donate.slice(-6)}
          </p>
        </div>
      </footer>
    </div>
  );
}
