import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import type { OwnerLabel } from "@/core/auth/allowlist";
import type { PermissionKey } from "@/core/oauth/permissions";
import { viewerFromLabel } from "@/modules/finance/api";
import { DraftBook, listChangesets, recordChangeset } from "./changesets";
import { RefBook } from "./conversations";
import type { AssistantCtx } from "./entities";
import { assistantConversations } from "./schema";
import { TOOLS, type AssistantTool as AppTool } from "./tools";

/**
 * Ask Claude's tools over the Household connector (MCP), for assistants a
 * member connected and gave a "Make changes" permission in Settings > AI
 * assistants (Pavel, 2026-11-25). The tools are the same ones the app's Ask
 * Claude uses, with the same rules:
 *
 * - Reads act as the member who connected the assistant (joint accounts and
 *   their own only) and answer with short refs, never ids.
 * - Edits become one changeset per call in that member's Ask Claude history:
 *   up to 10 changes without deletes apply at once and can be undone there;
 *   deletes and bigger batches wait for the member's Apply in the app.
 * - Answers are scrubbed by the MCP server like every other connector answer.
 *
 * Refs live in a hidden conversation row per connection, so a ref from one
 * call works in the next.
 */

export type ConnectorCaller = { grantId: string; email: string; owner: OwnerLabel };

/** Which app tools each permission brings. Reads come with their edits, since edits need their refs. */
export const CONNECTOR_TOOLS: Record<string, { requires: PermissionKey[]; tools: string[] }> = {
  "manage.family": {
    requires: ["manage.family"],
    tools: [
      "chores",
      "chore_goals",
      "shopping_list",
      "shopping_lists",
      "purchase_returns",
      "edit_kid",
      "edit_chore",
      "edit_chore_goal",
      "edit_shopping_item",
      "edit_shopping_list",
      "edit_shopping_template",
      "edit_purchase_return",
    ],
  },
  "manage.home": {
    requires: ["manage.home"],
    tools: ["upkeep_tasks", "home_equipment", "house_projects", "home_binder", "edit_upkeep_task", "edit_home_equipment", "edit_house_project", "edit_binder_entry"],
  },
  "manage.calendar": { requires: ["manage.calendar"], tools: ["calendar", "edit_calendar_event"] },
  "manage.finance": {
    requires: ["manage.finance", "finance.transactions"],
    tools: ["search_transactions", "category_overview", "merchant_rule", "edit_transactions", "set_merchant_rule"],
  },
};

const OWNER_PREFIX = "connector:";
/** A connection starts a fresh ref book after this many refs. */
const MAX_REFS = 5000;

async function refBookFor(grantId: string) {
  const owner = `${OWNER_PREFIX}${grantId}`;
  const [row] = await db()
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.ownerEmail, owner))
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(1);
  if (row && row.nextRef < MAX_REFS) return { id: row.id, owner, refs: new RefBook({ ...row.refs }, row.nextRef) };
  const [created] = await db().insert(assistantConversations).values({ ownerEmail: owner, title: "Household connector" }).returning();
  return { id: created.id, owner, refs: new RefBook({}, 1) };
}

async function saveRefs(id: string, owner: string, refs: RefBook) {
  await db()
    .update(assistantConversations)
    .set({ refs: refs.refs, nextRef: refs.nextRef, updatedAt: new Date() })
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerEmail, owner)));
}

function contextFor(caller: ConnectorCaller, now: Date): AssistantCtx {
  return { email: caller.email, owner: caller.owner, viewer: viewerFromLabel(caller.owner), now };
}

/** Runs one app tool for a connected assistant. Returns the raw answer; the MCP server scrubs it. */
export async function runConnectorTool(tool: AppTool, args: Record<string, unknown>, caller: ConnectorCaller, now = new Date()): Promise<unknown> {
  const ctx = contextFor(caller, now);
  const book = await refBookFor(caller.grantId);
  const drafts = new DraftBook();
  const result = await tool.run(args, { ctx, refs: book.refs, drafts });
  await saveRefs(book.id, book.owner, book.refs);
  if (tool.kind !== "edit" || !drafts.size) return result;

  const id = await recordChangeset(ctx, null, `Via a connected assistant: ${tool.name.replace(/_/g, " ")}`, drafts.drafts);
  const [set] = id ? await listChangesets(ctx, { ids: [id] }) : [];
  const failed = set?.changes.filter((c) => c.status === "failed" || c.status === "conflict").map((c) => ({ change: c.label, error: c.error })) ?? [];
  return {
    status:
      set?.status === "proposed"
        ? "Waiting for the member: deletes and batches over 10 changes are applied from Ask Claude > History in the app."
        : failed.length
          ? "Partly applied; see failed. Everything applied can be undone from Ask Claude > History in the app."
          : "Applied. The member can undo it from Ask Claude > History in the app.",
    changes: set?.changes.map((c) => ({ change: c.label, op: c.op, status: c.status })) ?? [],
    ...(failed.length && { failed }),
  };
}

/** The app tools a connection may use, with the permissions each needs. */
export function connectorToolList(): { tool: AppTool; requires: PermissionKey[] }[] {
  return Object.values(CONNECTOR_TOOLS).flatMap((g) =>
    g.tools.map((name) => {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`missing assistant tool ${name}`);
      return { tool, requires: g.requires };
    }),
  );
}
