import "server-only";
import type { HouseholdUser } from "@/core/auth/guard";
import { viewerFromLabel } from "@/modules/finance/api";
import { runAssistantTurn } from "./agent";
import { listChangesets, recordChangeset } from "./changesets";
import { createConversation, getConversation, RefBook, saveConversation } from "./conversations";
import type { AssistantCtx } from "./entities";
import { withPhotoText } from "./inbox";
import type { ChatMessage } from "./schema";

/** Entry points for the Ask Claude page (server actions call these). */

export function contextFor(user: HouseholdUser, now = new Date()): AssistantCtx {
  return { email: user.email, owner: user.owner, viewer: viewerFromLabel(user.owner), now };
}

export const MAX_MESSAGE_CHARS = 4000;

export async function sendMessage(user: HouseholdUser, conversationId: string | null, text: string, photoText: string | null = null) {
  const ctx = contextFor(user);
  const typed = text.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!typed) throw new Error("Type a message first");
  // Text read from an attached photo goes in scrubbed, and stays in the conversation for later turns.
  const userText = withPhotoText(typed, photoText);
  const convo = conversationId ? await getConversation(user.email, conversationId) : await createConversation(user.email, typed);
  if (!convo) throw new Error("Conversation not found");

  const refs = new RefBook({ ...convo.refs }, convo.nextRef);
  const history = convo.messages;
  const userMsg: ChatMessage = { role: "user", text: userText, at: new Date().toISOString() };
  const { reply, drafts } = await runAssistantTurn({ ctx, refs, history, userText });
  const changesetId = await recordChangeset(ctx, convo.id, userText, drafts.drafts);
  const assistantMsg: ChatMessage = { role: "assistant", text: reply, at: new Date().toISOString(), ...(changesetId ? { changesetId } : {}) };
  await saveConversation(user.email, convo.id, { messages: [...history, userMsg, assistantMsg], refs: refs.refs, nextRef: refs.nextRef });
  return { conversationId: convo.id };
}

export async function conversationView(user: HouseholdUser, id: string) {
  const convo = await getConversation(user.email, id);
  if (!convo) return null;
  const ids = convo.messages.map((m) => m.changesetId).filter((x): x is string => Boolean(x));
  const sets = ids.length ? await listChangesets(contextFor(user), { ids, limit: ids.length }) : [];
  return { id: convo.id, title: convo.title, messages: convo.messages, changesets: Object.fromEntries(sets.map((s) => [s.id, s])) };
}
