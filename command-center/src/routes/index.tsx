import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chrome } from "@/muse/chrome";
import { GROUPS, TOOLS, type Group } from "@/muse/catalog";
import { Briefing } from "@/muse/briefing";
import { monogram } from "@/muse/format";

export const Route = createFileRoute("/")({ component: Home });

const GROUP_NOTE: Record<Group, string> = {
  Mine: "Hashrate, luck, and who actually found the blocks.",
  Money: "Emission, vesting, fees. No invented price.",
  Chain: "Head, retarget, governance, and the node flags.",
  Security: "Lattice sizes, exposure, and local vaults. Nothing signs.",
  Build: "SS58, SCALE, and CLI shapes that were checked against the tool.",
};

function Home() {
  const [group, setGroup] = useState<Group | "All">("All");
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return TOOLS.filter((t) => (group === "All" || t.group === group) && (!s || `${t.title} ${t.summary} ${t.group}`.toLowerCase().includes(s)));
  }, [group, q]);
  const sections = useMemo(() => {
    if (group !== "All" || q.trim()) return [{ name: null as Group | null, items: list }];
    return GROUPS.map((g) => ({ name: g, items: list.filter((t) => t.group === g) }));
  }, [group, q, list]);

  return (
    <Chrome>
      <Briefing />

      <div id="instruments" className="mt-16 border-t border-line pt-12">
        <p className="text-xs font-medium tracking-widest text-signal">THE BENCH</p>
        <h2 className="mt-3 max-w-3xl font-serif text-4xl leading-tight text-fg sm:text-5xl">
          {TOOLS.length} instruments. The same snapshot underneath all of them.
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted">
          Mining, supply, governance, addresses. Each one either recomputes a public rule or says, plainly, what it
          refuses to invent.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Groups">
            {(["All", ...GROUPS] as const).map((g) => (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={group === g}
                onClick={() => setGroup(g)}
                className={`h-11 rounded-md px-3 text-sm font-medium ${group === g ? "bg-signal text-signal-ink" : "border border-line text-muted"}`}
              >
                {g}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter this list"
            aria-label="Filter instruments"
            className="h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg outline-none sm:ml-auto sm:max-w-xs"
          />
        </div>
        <p className="mt-3 text-sm text-faint">{list.length} instruments</p>

        {sections.map((section) => (
          <section key={section.name ?? "flat"} className="mt-8">
            {section.name ? (
              <div className="mb-2">
                <h3 className="font-serif text-2xl text-fg">{section.name}</h3>
                <p className="mt-1 text-sm text-faint">{GROUP_NOTE[section.name]}</p>
              </div>
            ) : null}
            <ul className="divide-y divide-line border-y border-line">
              {section.items.map((t) => (
                <li key={t.slug}>
                  <Link
                    to="/t/$slug"
                    params={{ slug: t.slug }}
                    className="flex items-start gap-4 py-4 text-fg no-underline hover:bg-surface"
                  >
                    <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-md bg-raised font-mono text-xs text-signal">
                      {monogram(t.title)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-3">
                        <span className="font-serif text-2xl">{t.title}</span>
                        <span className="text-xs tracking-wide text-faint">{t.group}</span>
                      </span>
                      <span className="mt-1 block text-sm leading-6 text-muted">{t.summary}</span>
                    </span>
                  </Link>
                </li>
              ))}
              {section.items.length === 0 ? <li className="py-6 text-sm text-muted">Nothing in this cut.</li> : null}
            </ul>
          </section>
        ))}
      </div>
    </Chrome>
  );
}
