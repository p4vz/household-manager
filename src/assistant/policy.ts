import type { ChangeOp } from "./schema";

/**
 * Which assistant edits apply without a click (Pavel's choice, 2026-11-25:
 * "auto-apply small fixes"). Small = at most 10 changes and no deletes:
 * recategorizing, renaming, ticking chores, adding a shopping item. Every
 * applied change can still be undone from the history.
 */
export const AUTO_APPLY_MAX = 10;

export function needsApproval(drafts: readonly { op: ChangeOp }[]): boolean {
  return drafts.length > AUTO_APPLY_MAX || drafts.some((d) => d.op === "delete");
}
