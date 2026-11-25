import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The in-app assistant ("Ask Claude"): conversations, and every change it
 * made or proposed, with the value before and after, so each change can be
 * undone. Rows belong to the member who had the conversation (`ownerEmail`);
 * nobody else sees them, since a conversation can touch that member's
 * private accounts.
 */

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: string;
  changesetId?: string;
};

/** Short handle the model uses for a row ("t12") -> the real row. Never sent out. */
export type RefTarget = { entity: string; key: string };

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerEmail: text("owner_email").notNull(),
    title: text("title").notNull(),
    messages: jsonb("messages").$type<ChatMessage[]>().notNull().default([]),
    refs: jsonb("refs").$type<Record<string, RefTarget>>().notNull().default({}),
    nextRef: integer("next_ref").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assistant_conversations_owner_idx").on(t.ownerEmail, t.updatedAt)],
);

export const CHANGESET_STATUSES = ["proposed", "applied", "partial", "discarded", "undone"] as const;
export type ChangesetStatus = (typeof CHANGESET_STATUSES)[number];

export const assistantChangesets = pgTable(
  "assistant_changesets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").references(() => assistantConversations.id, { onDelete: "set null" }),
    ownerEmail: text("owner_email").notNull(),
    summary: text("summary").notNull(),
    status: text("status", { enum: CHANGESET_STATUSES }).notNull().default("proposed"),
    /** Applied without a click: small edits only (see policy.ts). */
    autoApplied: boolean("auto_applied").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("assistant_changesets_owner_idx").on(t.ownerEmail, t.createdAt)],
);

export const CHANGE_OPS = ["create", "update", "delete"] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export const CHANGE_STATUSES = ["proposed", "applied", "conflict", "failed", "discarded", "undone", "undo_conflict"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const assistantChanges = pgTable(
  "assistant_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changesetId: uuid("changeset_id")
      .notNull()
      .references(() => assistantChangesets.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    entity: text("entity").notNull(),
    op: text("op", { enum: CHANGE_OPS }).notNull(),
    /** Row id (or key) in the owning module. Null for a create until applied. */
    targetKey: text("target_key"),
    /** What the person sees, e.g. "2026-11-02 Shell -$48.10". Shown on screen only. */
    label: text("label").notNull(),
    /** Editable fields before the change (null for a create). */
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    /** Editable fields after the change (null for a delete). */
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    status: text("status", { enum: CHANGE_STATUSES }).notNull().default("proposed"),
    error: text("error"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [index("assistant_changes_set_idx").on(t.changesetId, t.seq)],
);
