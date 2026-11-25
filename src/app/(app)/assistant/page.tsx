import Link from "next/link";
import { listConversations } from "@/assistant/conversations";
import { conversationView } from "@/assistant/service";
import { toCard } from "@/assistant/view";
import { ChangesetCard } from "@/components/assistant/changeset-card";
import { Composer } from "@/components/assistant/composer";
import { requireUserOrRedirect } from "@/core/auth/guard";
import {
  applyChangesetAction,
  discardChangesetAction,
  sendMessageAction,
  undoChangeAction,
  undoChangesetAction,
} from "./actions";

const actions = { apply: applyChangesetAction, discard: discardChangesetAction, undoOne: undoChangeAction, undoAll: undoChangesetAction };

export default async function AssistantPage({ searchParams }: PageProps<"/assistant">) {
  const user = await requireUserOrRedirect();
  const { c } = await searchParams;
  const id = typeof c === "string" && /^[0-9a-f-]{36}$/i.test(c) ? c : null;
  const [conversations, convo] = await Promise.all([listConversations(user.email), id ? conversationView(user, id) : null]);

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside className="space-y-3 text-sm">
        <Link href="/assistant" className="block rounded-md border px-3 py-2 font-medium hover:bg-foreground/5">
          + New conversation
        </Link>
        <Link href="/assistant/history" className="block px-1 underline opacity-80">
          Change history
        </Link>
        <ul className="space-y-1">
          {conversations.map((x) => (
            <li key={x.id}>
              <Link
                href={`/assistant?c=${x.id}`}
                className={`block truncate rounded px-2 py-1 hover:bg-foreground/5 ${x.id === convo?.id ? "bg-foreground/10" : ""}`}
              >
                {x.title}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold">Ask Claude</h1>
          <p className="text-sm opacity-70">
            Claude can read finance, upkeep, calendar, chores, shopping, returns and trips, and fix data. Small fixes apply right away;
            deletes and bigger batches wait for you. Everything can be undone. Account, card and routing numbers never leave the app.
          </p>
        </header>
        {id && !convo && <p className="text-sm">That conversation doesn&apos;t exist.</p>}
        <ol className="space-y-4">
          {convo?.messages.map((m, i) => (
            <li key={i} className={m.role === "user" ? "ml-auto max-w-[85%] rounded-lg bg-foreground/5 px-3 py-2" : "max-w-full"}>
              <p className="whitespace-pre-wrap text-sm">{m.text}</p>
              {m.changesetId && convo.changesets[m.changesetId] && (
                <ChangesetCard set={toCard(convo.changesets[m.changesetId])} actions={actions} />
              )}
            </li>
          ))}
        </ol>
        <Composer conversationId={convo?.id ?? null} send={sendMessageAction} empty={!convo} />
      </section>
    </div>
  );
}
