import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { assistantConversations, type ChatMessage, type RefTarget } from "./schema";

/**
 * Conversations with the in-app assistant. Each belongs to one member and is
 * only ever loaded for them.
 */

export const MAX_MESSAGES = 200;

export async function listConversations(email: string, limit = 30) {
  return db()
    .select({ id: assistantConversations.id, title: assistantConversations.title, updatedAt: assistantConversations.updatedAt })
    .from(assistantConversations)
    .where(eq(assistantConversations.ownerEmail, email))
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(limit);
}

export async function getConversation(email: string, id: string) {
  const [row] = await db()
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerEmail, email)));
  return row ?? null;
}

export async function createConversation(email: string, firstMessage: string) {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation";
  const [row] = await db().insert(assistantConversations).values({ ownerEmail: email, title }).returning();
  return row;
}

export async function saveConversation(
  email: string,
  id: string,
  patch: { messages: ChatMessage[]; refs: Record<string, RefTarget>; nextRef: number },
) {
  await db()
    .update(assistantConversations)
    .set({ messages: patch.messages.slice(-MAX_MESSAGES), refs: patch.refs, nextRef: patch.nextRef, updatedAt: new Date() })
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerEmail, email)));
}

export async function deleteConversation(email: string, id: string) {
  await db()
    .delete(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerEmail, email)));
}

const PREFIX: Record<string, string> = {
  transaction: "t",
  account: "a",
  upkeep_task: "u",
  shopping_item: "s",
  purchase_return: "r",
  chore: "c",
};

/**
 * Short handles ("t12") the model uses instead of database ids. The map
 * stays on the server, in the conversation row, so the model never sees an
 * internal id and can only point at rows it was shown in this conversation.
 */
export class RefBook {
  private byTarget = new Map<string, string>();

  constructor(
    readonly refs: Record<string, RefTarget>,
    public nextRef: number,
  ) {
    for (const [ref, t] of Object.entries(refs)) this.byTarget.set(`${t.entity}:${t.key}`, ref);
  }

  ref(entity: string, key: string): string {
    const k = `${entity}:${key}`;
    const existing = this.byTarget.get(k);
    if (existing) return existing;
    const ref = `${PREFIX[entity] ?? "x"}${this.nextRef++}`;
    this.refs[ref] = { entity, key };
    this.byTarget.set(k, ref);
    return ref;
  }

  resolve(ref: string, entity: string): string {
    const t = this.refs[ref.trim()];
    if (!t || t.entity !== entity) throw new Error(`Unknown ${entity.replace(/_/g, " ")} "${ref}". Look it up again with a read tool.`);
    return t.key;
  }
}
