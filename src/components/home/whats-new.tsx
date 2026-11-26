import Link from "next/link";
import type { NewsItem } from "@/assistant/whats-new";

/**
 * Home page "Since your last visit". `sinceLabel` is null on the very first
 * visit, when there is nothing to compare with yet.
 */
export function WhatsNew({ items, sinceLabel }: { items: NewsItem[]; sinceLabel: string | null }) {
  return (
    <section className="space-y-3 rounded-xl border p-4 sm:p-5" aria-labelledby="news-heading">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="news-heading" className="text-lg font-medium">
          Since your last visit
        </h2>
        {sinceLabel ? <span className="text-sm text-muted-foreground">{sinceLabel}</span> : null}
      </div>
      {!sinceLabel ? (
        <p className="text-sm text-muted-foreground">Next time you open the app, what changed in between shows here: new events, chores and reading, returns, upkeep done, new transactions.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing new since then.</p>
      ) : (
        <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {items.map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="flex gap-3 rounded-md hover:bg-accent">
                <span className="w-6 shrink-0 text-center text-lg leading-6" aria-hidden>
                  {i.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{i.title}</span>
                  {i.detail ? <span className="block text-sm text-muted-foreground">{i.detail}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
