import Link from "next/link";
import { listChangesets } from "@/assistant/changesets";
import { contextFor } from "@/assistant/service";
import { toCard } from "@/assistant/view";
import { ChangesetCard } from "@/components/assistant/changeset-card";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { applyChangesetAction, discardChangesetAction, undoChangeAction, undoChangesetAction } from "../actions";

const actions = { apply: applyChangesetAction, discard: discardChangesetAction, undoOne: undoChangeAction, undoAll: undoChangesetAction };

export default async function AssistantHistoryPage() {
  const user = await requireUserOrRedirect();
  const sets = await listChangesets(contextFor(user), { limit: 100 });
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/assistant" className="text-sm underline opacity-80">
        ← Ask Claude
      </Link>
      <h1 className="text-xl font-semibold">Change history</h1>
      <p className="text-sm opacity-70">
        Every change Claude made or proposed for you, newest first, with the values before and after. Undo restores the old value unless
        the item was changed again since.
      </p>
      {sets.length === 0 && <p className="text-sm">No changes yet.</p>}
      <ul className="space-y-4">
        {sets.map((s) => (
          <li key={s.id}>
            <p className="text-xs opacity-60">
              {s.createdAt.toLocaleString("en-US")}
              {s.conversationId && (
                <>
                  {" · "}
                  <Link className="underline" href={`/assistant?c=${s.conversationId}`}>
                    conversation
                  </Link>
                </>
              )}
            </p>
            <p className="text-sm">&ldquo;{s.summary}&rdquo;</p>
            <ChangesetCard set={toCard(s)} actions={actions} />
          </li>
        ))}
      </ul>
    </div>
  );
}
