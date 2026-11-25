import Link from "next/link";
import type { AttentionGroup, AttentionTone } from "@/assistant/attention";

const DOT: Record<AttentionTone, string> = {
  overdue: "bg-red-500",
  soon: "bg-amber-500",
  info: "bg-slate-400",
};
const TONE_WORD: Record<AttentionTone, string> = { overdue: "Overdue", soon: "Due soon", info: "" };

/** Home page "Needs attention": one small card per area that has something to show. */
export function NeedsAttention({ groups }: { groups: AttentionGroup[] }) {
  const shown = groups.filter((g) => g.items.length > 0 || g.failed);
  const urgent = groups.reduce((n, g) => n + g.items.filter((i) => i.tone === "overdue").length, 0);
  return (
    <section className="space-y-3" aria-labelledby="attention-heading">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="attention-heading" className="text-lg font-medium">
          Needs attention
        </h2>
        {urgent > 0 ? <span className="text-sm text-red-600">{urgent} overdue</span> : null}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border p-4 text-sm opacity-70">Nothing needs you right now.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((g) => (
            <div key={g.key} className="rounded-xl border p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="font-medium">{g.title}</h3>
                <Link href={g.href} className="text-xs underline opacity-70">
                  Open
                </Link>
              </div>
              {g.failed ? <p className="text-sm opacity-60">Couldn&apos;t load this right now.</p> : null}
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i.key}>
                    <Link href={i.href} className="flex gap-2 rounded-md hover:bg-foreground/5">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[i.tone]}`} aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm">{i.title}</span>
                        <span className="block text-xs opacity-70">
                          {TONE_WORD[i.tone] ? <span className="sr-only">{TONE_WORD[i.tone]}: </span> : null}
                          {i.detail}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {g.more > 0 ? (
                <Link href={g.href} className="mt-2 block text-xs underline opacity-70">
                  and {g.more} more
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
