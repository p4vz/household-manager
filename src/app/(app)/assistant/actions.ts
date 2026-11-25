"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { applyChangeset, discardChangeset, undoChange, undoChangeset } from "@/assistant/changesets";
import { deleteConversation } from "@/assistant/conversations";
import { MAX_PHOTO_TEXT } from "@/assistant/inbox";
import { contextFor, MAX_MESSAGE_CHARS, sendMessage } from "@/assistant/service";

/** Every module page may show data the assistant just changed. */
function refresh() {
  revalidatePath("/", "layout");
}

function friendly(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/No .* API key|subscription/i.test(m)) return `${m.slice(0, 200)} Check Settings > AI configuration.`;
  return m ? m.slice(0, 300) : "Something went wrong. Try again.";
}

export const sendMessageAction = authedAction(
  z.object({
    conversationId: z.uuid().nullable(),
    text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    photoText: z.string().max(MAX_PHOTO_TEXT * 2).nullish(),
  }),
  async (input, user) => {
    try {
      const r = await sendMessage(user, input.conversationId, input.text, input.photoText ?? null);
      refresh();
      return { ok: true as const, conversationId: r.conversationId };
    } catch (e) {
      return { ok: false as const, error: friendly(e) };
    }
  },
);

const Id = z.object({ id: z.uuid() });

export const applyChangesetAction = authedAction(Id, async ({ id }, user) => {
  await applyChangeset(contextFor(user), id);
  refresh();
});

export const discardChangesetAction = authedAction(Id, async ({ id }, user) => {
  await discardChangeset(contextFor(user), id);
  refresh();
});

export const undoChangeAction = authedAction(Id, async ({ id }, user) => {
  await undoChange(contextFor(user), id);
  refresh();
});

export const undoChangesetAction = authedAction(Id, async ({ id }, user) => {
  await undoChangeset(contextFor(user), id);
  refresh();
});

export const deleteConversationAction = authedAction(Id, async ({ id }, user) => {
  await deleteConversation(user.email, id);
  revalidatePath("/assistant");
});
