import "server-only";
import type { OwnerLabel } from "@/core/auth/allowlist";
import { getSetting, setSetting } from "@/core/settings/store";

/**
 * When each member last opened the home page, for "Since your last visit".
 * `last` is the latest visit; `prev` is the one before the current sitting.
 * Visits closer together than SITTING_MS count as one sitting, so refreshing
 * the page keeps showing the same changes instead of clearing them.
 */
export type VisitRecord = { last: string; prev: string | null; first: string };

export const SITTING_MS = 30 * 60_000;

const key = (owner: OwnerLabel) => `home.visits.${owner === "User 1" ? "user1" : "user2"}`;

export async function readVisits(owner: OwnerLabel): Promise<VisitRecord | null> {
  const v = (await getSetting(key(owner))) as Partial<VisitRecord> | undefined;
  return v?.last ? { last: v.last, prev: v.prev ?? null, first: v.first ?? v.last } : null;
}

/** Pure: the record after a visit at `now`, and the time changes are shown since (null on a first visit). */
export function nextVisit(rec: VisitRecord | null, now: Date): { rec: VisitRecord; since: Date | null } {
  const at = now.toISOString();
  if (!rec) return { rec: { last: at, prev: null, first: at }, since: null };
  const gap = now.getTime() - Date.parse(rec.last);
  if (gap >= SITTING_MS) return { rec: { last: at, prev: rec.last, first: rec.first }, since: new Date(rec.last) };
  return { rec: { ...rec, last: at }, since: rec.prev ? new Date(rec.prev) : null };
}

/** Records a home page visit and returns when "since your last visit" starts. */
export async function recordVisit(owner: OwnerLabel, now = new Date()): Promise<{ since: Date | null; firstVisit: boolean }> {
  const before = await readVisits(owner);
  const { rec, since } = nextVisit(before, now);
  await setSetting(key(owner), rec);
  return { since, firstVisit: before === null };
}
