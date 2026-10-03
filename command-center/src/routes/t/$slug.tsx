import { createFileRoute, Link } from "@tanstack/react-router";
import { Chrome } from "@/muse/chrome";
import { PAGES, toolBySlug } from "@/muse/catalog";
import { Desk } from "@/muse/desk";

export const Route = createFileRoute("/t/$slug")({
  component: ToolPage,
});

function ToolPage() {
  const { slug } = Route.useParams();
  const tool = toolBySlug(slug);
  if (!tool) {
    return (
      <Chrome>
        <h1 className="font-serif text-4xl">That instrument is not on the bench.</h1>
        <Link to="/" className="mt-4 inline-block text-signal">
          Back to the index
        </Link>
      </Chrome>
    );
  }
  return (
    <Chrome>
      <Link to="/" className="text-sm text-muted no-underline hover:text-fg">
        All instruments
      </Link>
      <p className="mt-4 text-xs font-medium tracking-widest text-signal">{tool.group.toUpperCase()}</p>
      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="font-serif text-4xl text-fg sm:text-5xl">{tool.title}</h1>
        <a
          href={`${PAGES}/${tool.slug}/`}
          className="inline-flex h-11 items-center rounded-md border border-line px-4 text-sm font-medium text-fg no-underline"
        >
          Published desk
        </a>
      </div>
      <p className="mt-3 max-w-2xl text-base leading-7 text-muted">{tool.summary}</p>
      <div className="mt-8">
        <Desk slug={tool.slug} />
      </div>
    </Chrome>
  );
}
