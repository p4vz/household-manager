import type { ChangesetCardData } from "@/components/assistant/changeset-card";
import type { ChangesetView } from "./changesets";

/** Plain props for the changeset card (dates as strings). */
export function toCard(s: ChangesetView): ChangesetCardData {
  return {
    id: s.id,
    summary: s.summary,
    status: s.status,
    autoApplied: s.autoApplied,
    createdAt: s.createdAt.toISOString(),
    changes: s.changes.map((c) => ({
      id: c.id,
      entity: c.entity,
      op: c.op,
      label: c.label,
      before: c.before,
      after: c.after,
      status: c.status,
      error: c.error,
    })),
  };
}
