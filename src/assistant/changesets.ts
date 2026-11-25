import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/core/db/client";
import { adapterFor, sameFields, type AssistantCtx, type Fields } from "./entities";
import { needsApproval } from "./policy";
import { assistantChanges, assistantChangesets, type ChangeOp, type ChangeStatus, type ChangesetStatus } from "./schema";

/**
 * Changesets: every edit the assistant makes goes through here.
 *
 * - The assistant only drafts changes. Each draft records the editable
 *   fields before and after, read from the module at draft time.
 * - Small batches apply straight away (see policy.ts); the rest wait for the
 *   member to press Apply.
 * - Applying re-reads each row first. If it no longer matches "before"
 *   (someone changed it meanwhile), that change is skipped as a conflict.
 * - Undo is per change or per batch, newest first, and likewise skips a
 *   row that changed again after the assistant's edit.
 */

export const MAX_CHANGES_PER_BATCH = 200;

export type DraftChange = {
  entity: string;
  op: ChangeOp;
  key: string | null;
  label: string;
  before: Fields | null;
  after: Fields | null;
};

export class ChangeLimitError extends Error {}

/**
 * Collects the drafts of one assistant turn. Two edits to the same row merge
 * into one change, so "before" stays the value at the start of the turn.
 */
export class DraftBook {
  readonly drafts: DraftChange[] = [];

  add(d: DraftChange) {
    const existing = d.key ? this.drafts.find((x) => x.entity === d.entity && x.key === d.key) : undefined;
    if (existing) {
      if (existing.op === "create" && d.op === "delete") {
        this.drafts.splice(this.drafts.indexOf(existing), 1);
        return;
      }
      if (existing.op === "update" && d.op === "update") {
        existing.before = { ...d.before, ...existing.before };
        existing.after = { ...existing.after, ...d.after };
        return;
      }
      if (existing.op === "update" && d.op === "delete") {
        existing.op = "delete";
        existing.before = { ...d.before, ...existing.before };
        existing.after = null;
        return;
      }
    }
    if (this.drafts.length >= MAX_CHANGES_PER_BATCH) {
      throw new ChangeLimitError(`At most ${MAX_CHANGES_PER_BATCH} changes per batch. Propose the rest in a later turn.`);
    }
    this.drafts.push(d);
  }

  get size() {
    return this.drafts.length;
  }
}

/** Saves the drafts as one changeset; applies it now if policy allows. */
export async function recordChangeset(
  ctx: AssistantCtx,
  conversationId: string | null,
  summary: string,
  drafts: DraftChange[],
): Promise<string | null> {
  if (!drafts.length) return null;
  const auto = !needsApproval(drafts);
  const [set] = await db()
    .insert(assistantChangesets)
    .values({ conversationId, ownerEmail: ctx.email, summary: summary.slice(0, 300) || "Changes", autoApplied: auto })
    .returning({ id: assistantChangesets.id });
  await db()
    .insert(assistantChanges)
    .values(
      drafts.map((d, seq) => ({
        changesetId: set.id,
        seq,
        entity: d.entity,
        op: d.op,
        targetKey: d.key,
        label: d.label.slice(0, 200),
        before: d.before,
        after: d.after,
      })),
    );
  if (auto) await applyChangeset(ctx, set.id);
  return set.id;
}

async function ownSet(ctx: AssistantCtx, id: string) {
  const [set] = await db()
    .select()
    .from(assistantChangesets)
    .where(and(eq(assistantChangesets.id, id), eq(assistantChangesets.ownerEmail, ctx.email)));
  if (!set) throw new Error("Changeset not found");
  return set;
}

async function changesOf(changesetId: string) {
  return db().select().from(assistantChanges).where(eq(assistantChanges.changesetId, changesetId)).orderBy(asc(assistantChanges.seq));
}

async function setChange(id: string, patch: Partial<typeof assistantChanges.$inferInsert>) {
  await db().update(assistantChanges).set(patch).where(eq(assistantChanges.id, id));
}

function errText(e: unknown) {
  return (e instanceof Error ? e.message : "failed").slice(0, 200);
}

export async function applyChangeset(ctx: AssistantCtx, id: string) {
  const set = await ownSet(ctx, id);
  if (set.status !== "proposed") throw new Error("This changeset was already decided");
  for (const c of await changesOf(id)) {
    if (c.status !== "proposed") continue;
    const a = adapterFor(c.entity);
    try {
      if (c.op === "create") {
        const key = await a.create!(ctx, c.after!);
        await setChange(c.id, { status: "applied", targetKey: key, appliedAt: new Date() });
        continue;
      }
      const current = await a.get(ctx, c.targetKey!);
      if (!current || !sameFields(current.fields, c.before ?? {})) {
        await setChange(c.id, { status: "conflict", error: current ? "Changed since Claude looked at it" : "No longer exists" });
        continue;
      }
      if (c.op === "update") await a.update(ctx, c.targetKey!, c.after!);
      else await a.remove!(ctx, c.targetKey!);
      await setChange(c.id, { status: "applied", appliedAt: new Date() });
    } catch (e) {
      await setChange(c.id, { status: "failed", error: errText(e) });
    }
  }
  await db()
    .update(assistantChangesets)
    .set({ status: await rollUp(id), decidedAt: new Date() })
    .where(eq(assistantChangesets.id, id));
}

export async function discardChangeset(ctx: AssistantCtx, id: string) {
  const set = await ownSet(ctx, id);
  if (set.status !== "proposed") throw new Error("This changeset was already decided");
  await db()
    .update(assistantChanges)
    .set({ status: "discarded" })
    .where(and(eq(assistantChanges.changesetId, id), eq(assistantChanges.status, "proposed")));
  await db().update(assistantChangesets).set({ status: "discarded", decidedAt: new Date() }).where(eq(assistantChangesets.id, id));
}

async function undoOne(ctx: AssistantCtx, c: typeof assistantChanges.$inferSelect) {
  if (c.status !== "applied") return;
  const a = adapterFor(c.entity);
  try {
    if (c.op === "delete") {
      const key = await a.restore!(ctx, c.targetKey!, c.before!);
      await setChange(c.id, { status: "undone", targetKey: key, undoneAt: new Date() });
      return;
    }
    const current = await a.get(ctx, c.targetKey!);
    if (!current || !sameFields(current.fields, c.after ?? {})) {
      await setChange(c.id, {
        status: "undo_conflict",
        error: current ? "Changed again since, so it was left as it is" : "No longer exists",
      });
      return;
    }
    if (c.op === "create") await a.remove!(ctx, c.targetKey!);
    else await a.update(ctx, c.targetKey!, c.before!);
    await setChange(c.id, { status: "undone", undoneAt: new Date() });
  } catch (e) {
    await setChange(c.id, { status: "undo_conflict", error: errText(e) });
  }
}

export async function undoChange(ctx: AssistantCtx, changeId: string) {
  const [c] = await db().select().from(assistantChanges).where(eq(assistantChanges.id, changeId));
  if (!c) throw new Error("Change not found");
  await ownSet(ctx, c.changesetId);
  await undoOne(ctx, c);
  await db().update(assistantChangesets).set({ status: await rollUp(c.changesetId) }).where(eq(assistantChangesets.id, c.changesetId));
}

export async function undoChangeset(ctx: AssistantCtx, id: string) {
  await ownSet(ctx, id);
  const changes = await changesOf(id);
  for (const c of changes.reverse()) await undoOne(ctx, c);
  await db().update(assistantChangesets).set({ status: await rollUp(id) }).where(eq(assistantChangesets.id, id));
}

async function rollUp(id: string): Promise<ChangesetStatus> {
  const statuses = (await changesOf(id)).map((c) => c.status as ChangeStatus);
  if (statuses.every((s) => s === "discarded")) return "discarded";
  if (statuses.some((s) => s === "proposed")) return "proposed";
  if (statuses.every((s) => s === "undone")) return "undone";
  if (statuses.every((s) => s === "applied")) return "applied";
  return "partial";
}

export type ChangesetView = typeof assistantChangesets.$inferSelect & {
  changes: (typeof assistantChanges.$inferSelect)[];
};

export async function listChangesets(ctx: AssistantCtx, opts: { ids?: string[]; limit?: number } = {}): Promise<ChangesetView[]> {
  const sets = await db()
    .select()
    .from(assistantChangesets)
    .where(
      and(
        eq(assistantChangesets.ownerEmail, ctx.email),
        opts.ids ? inArray(assistantChangesets.id, opts.ids.length ? opts.ids : ["00000000-0000-0000-0000-000000000000"]) : undefined,
      ),
    )
    .orderBy(desc(assistantChangesets.createdAt))
    .limit(opts.limit ?? 50);
  if (!sets.length) return [];
  const changes = await db()
    .select()
    .from(assistantChanges)
    .where(inArray(assistantChanges.changesetId, sets.map((s) => s.id)))
    .orderBy(asc(assistantChanges.seq));
  return sets.map((s) => ({ ...s, changes: changes.filter((c) => c.changesetId === s.id) }));
}
