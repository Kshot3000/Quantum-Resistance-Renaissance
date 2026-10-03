import { toolBySlug } from "./catalog";
import { BuildDesk } from "./desks/build";
import { ChainDesk } from "./desks/chain";
import { MineDesk } from "./desks/mine";
import { MoneyDesk } from "./desks/money";
import { SecurityDesk } from "./desks/security";

export function Desk({ slug }: { slug: string }) {
  const tool = toolBySlug(slug);
  if (!tool) return null;
  if (tool.group === "Mine") return <MineDesk slug={slug} />;
  if (tool.group === "Money") return <MoneyDesk slug={slug} />;
  if (tool.group === "Chain") return <ChainDesk slug={slug} />;
  if (tool.group === "Security") return <SecurityDesk slug={slug} />;
  return <BuildDesk slug={slug} />;
}
