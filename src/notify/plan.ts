import { addDays } from "@/core/time/zoned";
import type { NotificationPrefs, NotificationType, PushMessage } from "@/core/push/types";

/**
 * Pure rules for phone notifications: which stage a due date is in, and how
 * fresh reminders are grouped into one message per type.
 */
export type Candidate = { type: NotificationType; key: string; line: string; url: string };

/** Days of warning before the due date. */
export const LEAD_DAYS: Record<"upkeep" | "registrations" | "returns", number> = { upkeep: 3, registrations: 14, returns: 3 };

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * A due date becomes at most three reminders: "soon" (within the lead
 * days), "today", and "overdue" (once). The due date is part of the key, so
 * moving an item re-arms its reminders. Overdue reminders stop after 60 days
 * so old, forgotten items don't keep coming back after a reset.
 */
export function dueCandidate(
  type: "upkeep" | "registrations" | "returns",
  item: { id: string; title: string; due: string },
  today: string,
  url: string,
): Candidate | null {
  const d = daysBetween(today, item.due);
  let stage: "soon" | "today" | "overdue";
  let when: string;
  if (d > LEAD_DAYS[type]) return null;
  if (d > 0) {
    stage = "soon";
    when = d === 1 ? "due tomorrow" : `due ${shortDate(item.due)}`;
  } else if (d === 0) {
    stage = "today";
    when = type === "returns" ? "last day to return" : "due today";
  } else {
    if (type === "returns" || d < -60) return null;
    stage = "overdue";
    when = `overdue since ${shortDate(item.due)}`;
  }
  return { type, key: `${type}:${item.id}:${stage}:${item.due}`, line: `${item.title}, ${when}`, url };
}

const TITLES: Record<NotificationType, string> = {
  upkeep: "Upkeep",
  registrations: "Registration or inspection",
  returns: "Return deadline",
  suggestions: "New to review",
};

/** One message per type: the item itself, or a count with the first few lines. */
export function groupMessages(fresh: Candidate[], prefs: NotificationPrefs): { type: NotificationType; keys: string[]; message: PushMessage }[] {
  const out: { type: NotificationType; keys: string[]; message: PushMessage }[] = [];
  for (const type of Object.keys(TITLES) as NotificationType[]) {
    const items = fresh.filter((c) => c.type === type);
    if (items.length === 0 || !prefs[type]) continue;
    const urls = new Set(items.map((i) => i.url));
    // Identical lines ("A large purchase to review") collapse into one with a count.
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.line, (counts.get(i.line) ?? 0) + 1);
    const lines = [...counts].map(([line, n]) => (n > 1 ? `${line} (${n})` : line));
    const shown = lines.slice(0, 3);
    out.push({
      type,
      keys: items.map((i) => i.key),
      message: {
        title: items.length === 1 ? TITLES[type] : `${TITLES[type]}: ${items.length} items`,
        body: shown.join("\n") + (lines.length > 3 ? `\nand ${lines.length - 3} more` : ""),
        url: urls.size === 1 ? items[0].url : "/",
        tag: type,
      },
    });
  }
  return out;
}

/** Notifications go out between 8 AM and 9 PM household time. */
export function inSendingHours(localHour: number): boolean {
  return localHour >= 8 && localHour < 21;
}

export { addDays };
