import "server-only";
import { householdTimeZone } from "@/core/time/zoned";
import { calendarChangesSince, type CalendarChange } from "@/modules/calendar/api";
import { familyActivitySince } from "@/modules/family/api";
import { financeActivitySince, type Viewer } from "@/modules/finance/api";
import { maintenanceActivitySince } from "@/modules/maintenance/api";
import { tripChangesSince } from "@/modules/trips/api";

/**
 * The home page's "Since your last visit": what changed in each area after
 * the member's previous sitting. Built only from module api.ts calls. Money
 * goes through the finance access rules for `viewer` (joint and their own
 * accounts) and shows counts and a total only: no merchants, no accounts.
 *
 * Rendered on the signed-in member's own page; nothing here goes to an AI.
 */
export type NewsItem = { key: string; icon: string; title: string; detail?: string; href: string };

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "Replace filter, Clean gutters and 2 more". */
export function listWords(titles: string[], max = 3): string {
  const shown = titles.slice(0, max);
  const rest = titles.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

function eventWhen(e: CalendarChange, tz: string): string {
  if (e.startsAt) return e.startsAt.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (e.startDate) return new Date(`${e.startDate}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return "";
}

async function soft<T>(area: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[whats-new] ${area}: ${err instanceof Error ? err.message : "failed"}`);
    return null;
  }
}

/** `sinceDay` is the household date of `since`; `today` the household date now. */
export async function whatsNew(viewer: Viewer, since: Date, opts: { now?: Date; today: string; sinceDay: string }): Promise<NewsItem[]> {
  const now = opts.now ?? new Date();
  const tz = householdTimeZone();
  const [money$, events, family, house, trips] = await Promise.all([
    soft("finance", () => financeActivitySince(viewer, since)),
    soft("calendar", () => calendarChangesSince(since, now, opts.today)),
    soft("family", () => familyActivitySince(since)),
    soft("maintenance", () => maintenanceActivitySince(since, opts.sinceDay)),
    soft("trips", () => tripChangesSince(since)),
  ]);
  const items: NewsItem[] = [];

  if (events?.length) {
    items.push({
      key: "calendar",
      icon: "📅",
      title: `${plural(events.length, "event")} added or changed`,
      detail: listWords(events.map((e) => `${e.title} (${eventWhen(e, tz)})`)),
      href: "/calendar",
    });
  }
  if (money$ && money$.transactions > 0) {
    const parts = [money$.spent > 0 ? `${money(money$.spent)} spent` : null, money$.uncategorized > 0 ? `${money$.uncategorized} without a category` : null].filter(Boolean);
    items.push({ key: "money", icon: "💳", title: `${plural(money$.transactions, "new transaction")} synced`, detail: parts.join(" · ") || undefined, href: "/finance/transactions" });
  }
  if (family) {
    for (const k of family.kids) {
      if (!k.chores && !k.readingMinutes) continue;
      const parts = [k.chores ? plural(k.chores, "chore") + " done" : null, k.stars ? `${k.stars} ⭐` : null, k.readingMinutes ? `${k.readingMinutes} min reading` : null].filter(Boolean);
      items.push({ key: `kid:${k.id}`, icon: k.emoji, title: k.name, detail: parts.join(" · "), href: "/family" });
    }
    if (family.prizes.length) {
      items.push({ key: "prizes", icon: "🎁", title: `${plural(family.prizes.length, "prize")} given`, detail: listWords(family.prizes.map((p) => `${p.kid}: ${p.prize}`)), href: "/family" });
    }
    if (family.returnsAdded || family.returnsDone) {
      const parts = [family.returnsAdded ? `${family.returnsAdded} added` : null, family.returnsDone ? `${family.returnsDone} returned` : null].filter(Boolean);
      items.push({ key: "returns", icon: "📦", title: "Returns", detail: parts.join(" · "), href: "/family" });
    }
    if (family.shoppingAdded || family.shoppingBought) {
      const parts = [family.shoppingAdded ? `${plural(family.shoppingAdded, "item")} added` : null, family.shoppingBought ? `${family.shoppingBought} bought` : null].filter(Boolean);
      items.push({ key: "shopping", icon: "🛒", title: "Shopping lists", detail: parts.join(" · "), href: "/family" });
    }
  }
  if (house) {
    if (house.done.length) items.push({ key: "done", icon: "✅", title: `Upkeep done: ${plural(house.done.length, "item")}`, detail: listWords(house.done.map((t) => t.title)), href: "/maintenance" });
    if (house.todosAdded.length) {
      items.push({
        key: "todos",
        icon: "🔨",
        title: `${plural(house.todosAdded.length, "new house to-do")}`,
        detail: listWords(house.todosAdded.map((t) => (t.assignee ? `${t.title} (${t.assignee})` : t.title))),
        href: "/maintenance",
      });
    }
    if (house.binderAdded.length) items.push({ key: "binder", icon: "📁", title: `Filed in the home binder`, detail: listWords(house.binderAdded.map((d) => d.title)), href: "/maintenance/binder" });
  }
  if (trips?.length) {
    const byTrip = new Map<string, { trip: string; slug: string; titles: string[] }>();
    for (const t of trips) {
      const g = byTrip.get(t.slug) ?? { trip: t.trip, slug: t.slug, titles: [] };
      g.titles.push(t.title);
      byTrip.set(t.slug, g);
    }
    for (const g of byTrip.values()) items.push({ key: `trip:${g.slug}`, icon: "✈️", title: `Added to ${g.trip}`, detail: listWords(g.titles), href: `/trips/${g.slug}` });
  }
  return items;
}
