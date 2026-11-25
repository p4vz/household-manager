import "server-only";
import { kioskCalendar } from "@/modules/calendar/api";
import { choreBoard, listReturns } from "@/modules/family/api";
import {
  budgetOverview,
  houseQuestions,
  largePurchases,
  largeThreshold,
  signupBonusOverview,
  type Viewer,
} from "@/modules/finance/api";
import { listAssets, listOpenTasks } from "@/modules/maintenance/api";
import { expiringDocuments, outstandingBookings } from "@/modules/trips/api";
import { addDays } from "@/core/time/zoned";

/**
 * The home page's "Needs attention" summary: one short list per area, built
 * only from module api.ts calls. Shared household things (upkeep, cars,
 * returns, calendar, chores, trips) are the same for both members. Money
 * items go through the finance access rules for `viewer`, so each member
 * sees counts for joint accounts and their own only.
 *
 * Nothing here leaves the server or goes to an AI; it is rendered on the
 * signed-in member's own page.
 */
export type AttentionTone = "overdue" | "soon" | "info";

export type AttentionItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  tone: AttentionTone;
};

export type AttentionGroupKey = "upkeep" | "cars" | "returns" | "money" | "calendar" | "trips" | "chores";

export type AttentionGroup = {
  key: AttentionGroupKey;
  title: string;
  href: string;
  items: AttentionItem[];
  /** Items left out of `items` to keep the card short. */
  more: number;
  /** Set when this area could not be read; the rest of the page still shows. */
  failed?: boolean;
};

/** How far ahead "due soon" looks for each kind of deadline. */
export const WINDOWS = { upkeepDays: 14, carMiles: 500, returnDays: 7, bonusDays: 30, tripDays: 30, documentDays: 180, calendarDays: 3 } as const;
const PER_GROUP = 5;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** "today", "tomorrow", "in 3 days", "2 days late". */
export function dueWords(today: string, due: string): string {
  const d = daysBetween(today, due);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "1 day late";
  return d < 0 ? `${-d} days late` : `in ${d} days`;
}

/** Overdue when the date has passed, soon when it is within `windowDays`, else null (not shown). */
export function dateTone(today: string, due: string | null, windowDays: number): AttentionTone | null {
  if (!due) return null;
  const d = daysBetween(today, due);
  if (d < 0) return "overdue";
  return d <= windowDays ? "soon" : null;
}

const TONE_ORDER: Record<AttentionTone, number> = { overdue: 0, soon: 1, info: 2 };

function group(key: AttentionGroupKey, title: string, href: string, items: AttentionItem[], limit = PER_GROUP): AttentionGroup {
  const sorted = [...items].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  return { key, title, href, items: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

const miles = (n: number) => `${n.toLocaleString("en-US")} mi`;
const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function upkeepAndCars(today: string): Promise<[AttentionGroup, AttentionGroup]> {
  const [tasks, assets] = await Promise.all([listOpenTasks(), listAssets()]);
  const cars = new Map(assets.filter((a) => a.kind === "vehicle").map((a) => [a.id, a]));
  const upkeep: AttentionItem[] = [];
  const carItems: AttentionItem[] = [];
  for (const t of tasks) {
    const car = t.assetId ? cars.get(t.assetId) : undefined;
    let tone = dateTone(today, t.dueDate, WINDOWS.upkeepDays);
    let detail = tone ? `Due ${dueWords(today, t.dueDate)}` : "";
    if (car && t.dueMileage != null && car.mileage != null) {
      const left = t.dueMileage - car.mileage;
      if (left <= 0) {
        tone = "overdue";
        detail = `Due at ${miles(t.dueMileage)}; car is at ${miles(car.mileage)}`;
      } else if (left <= WINDOWS.carMiles && tone !== "overdue") {
        tone = "soon";
        detail = `${miles(left)} to go${detail ? ` · ${detail.toLowerCase()}` : ""}`;
      }
    }
    if (!tone) continue;
    const item = { key: `task:${t.id}`, title: t.title, detail: t.parts ? `${detail} · ${t.parts}` : detail, href: car ? "/maintenance#vehicles" : "/maintenance#items", tone };
    (car ? carItems : upkeep).push(item);
  }
  for (const a of assets) {
    if (!a.recalls?.length) continue;
    const item: AttentionItem = {
      key: `recall:${a.id}`,
      title: `${a.name}: ${plural(a.recalls.length, "recall")} on file`,
      detail: a.recalls[0].title,
      href: "/maintenance",
      tone: "soon",
    };
    (a.kind === "vehicle" ? carItems : upkeep).push(item);
  }
  return [group("upkeep", "House upkeep", "/maintenance#items", upkeep), group("cars", "Cars", "/maintenance#vehicles", carItems)];
}

async function returnsGroup(today: string): Promise<AttentionGroup> {
  const rows = await listReturns();
  const items: AttentionItem[] = [];
  for (const r of rows) {
    const tone = dateTone(today, r.returnDeadline, WINDOWS.returnDays);
    if (tone) {
      items.push({
        key: `return:${r.id}`,
        title: `${r.itemName} (${r.store})`,
        detail: `Return ${tone === "overdue" ? "deadline passed" : "by"} ${dueWords(today, r.returnDeadline!)}${r.status === "packed_in_car" ? " · packed in the car" : ""}`,
        href: "/family",
        tone,
      });
    } else if (r.status === "packed_in_car") {
      items.push({ key: `return:${r.id}`, title: `${r.itemName} (${r.store})`, detail: "Packed in the car, not dropped off yet", href: "/family", tone: "info" });
    }
  }
  return group("returns", "Returns", "/family", items);
}

async function moneyGroup(viewer: Viewer, today: string, now: Date): Promise<AttentionGroup> {
  const threshold = await largeThreshold(viewer);
  const [large, questions, budget, bonuses] = await Promise.all([
    largePurchases(viewer, threshold, 1),
    houseQuestions(viewer, { limit: 1 }),
    budgetOverview(viewer, now),
    signupBonusOverview(viewer, now),
  ]);
  const items: AttentionItem[] = [];
  if (large.openCount > 0) {
    items.push({
      key: "large",
      title: `${plural(large.openCount, "large purchase")} to explain`,
      detail: `Over ${money(threshold)}, not answered yet`,
      href: "/finance/review",
      tone: "soon",
    });
  }
  if (questions.count > 0) {
    items.push({
      key: "questions",
      title: `${plural(questions.count, "questionable transaction")} to review`,
      detail: "Cash, uncategorized, house and car payments",
      href: "/maintenance#questions",
      tone: "info",
    });
  }
  for (const b of budget.rows) {
    if (!b.status || b.status === "ok" || !b.budget) continue;
    items.push({
      key: `budget:${b.category}`,
      title: `${b.category} budget ${b.status === "over" ? "is over" : "is close"}`,
      detail: `${money(b.spent)} of ${money(b.budget.limit)} this month`,
      href: "/finance/budget",
      tone: b.status === "over" ? "overdue" : "soon",
    });
  }
  for (const s of bonuses) {
    if (s.remaining <= 0 || s.daysLeft > WINDOWS.bonusDays) continue;
    items.push({
      key: `bonus:${s.accountId}`,
      title: `${s.card} sign-up bonus`,
      detail: `${money(s.remaining)} more spend by ${dueWords(today, s.deadline)}`,
      href: "/finance/rewards",
      tone: s.daysLeft < 0 ? "overdue" : "soon",
    });
  }
  return group("money", "Money", "/finance", items);
}

async function calendarGroup(now: Date): Promise<AttentionGroup> {
  const cal = await kioskCalendar(WINDOWS.calendarDays, now);
  const items: AttentionItem[] = [];
  for (const day of cal.days) {
    for (const e of day.items) {
      items.push({ key: `event:${day.date}:${e.key}`, title: e.title, detail: `${day.label} · ${e.timeLabel}${e.location ? ` · ${e.location}` : ""}`, href: "/calendar", tone: "info" });
    }
  }
  return group("calendar", "Coming up", "/calendar", items, 6);
}

async function tripsGroup(today: string): Promise<AttentionGroup> {
  const [bookings, docs] = await Promise.all([outstandingBookings(today), expiringDocuments(addDays(today, WINDOWS.documentDays))]);
  const items: AttentionItem[] = [];
  for (const b of bookings) {
    const due = b.verifyBy ?? b.bookingOpensOn ?? b.startsAt.toISOString().slice(0, 10);
    const tone = dateTone(today, due, WINDOWS.tripDays);
    if (!tone) continue;
    const what = b.bookingStatus === "booked" ? "Check the booking" : b.bookingStatus === "idea" ? "Decide and book" : "Book";
    items.push({ key: `booking:${b.id}`, title: `${b.title} (${b.tripName})`, detail: `${what} ${dueWords(today, due)}`, href: `/trips/${b.tripSlug}`, tone });
  }
  for (const d of docs) {
    if (!d.expiresOn) continue;
    items.push({
      key: `doc:${d.id}`,
      title: d.title,
      detail: d.expiresOn < today ? "Expired" : `Expires ${dueWords(today, d.expiresOn)}`,
      href: "/trips/documents",
      tone: d.expiresOn < today ? "overdue" : "soon",
    });
  }
  return group("trips", "Trips", "/trips", items);
}

async function choresGroup(now: Date): Promise<AttentionGroup> {
  const kids = await choreBoard(now);
  const items: AttentionItem[] = kids.map((k) => {
    const s = k.stats;
    const parts = [`${s.todayDone} of ${s.todayTotal} today`, `${s.weekPercent}% this week`];
    if (s.streak > 0) parts.push(`${s.streak}-day streak`);
    parts.push(`${s.starsWeek} ⭐ this week`);
    return {
      key: `kid:${k.id}`,
      title: `${k.emoji} ${k.name}`,
      detail: parts.join(" · "),
      href: "/family",
      tone: s.todayTotal > 0 && s.todayDone < s.todayTotal ? "soon" : "info",
    };
  });
  return group("chores", "Kids' chores", "/family", items, 6);
}

async function safely(key: AttentionGroupKey, title: string, href: string, fn: () => Promise<AttentionGroup>): Promise<AttentionGroup> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[attention] ${key}: ${err instanceof Error ? err.message : "failed"}`);
    return { key, title, href, items: [], more: 0, failed: true };
  }
}

export async function needsAttention(viewer: Viewer, today: string, now = new Date()): Promise<AttentionGroup[]> {
  const [houseAndCars, ...rest] = await Promise.all([
    upkeepAndCars(today).catch((err) => {
      console.error(`[attention] upkeep: ${err instanceof Error ? err.message : "failed"}`);
      return null;
    }),
    safely("returns", "Returns", "/family", () => returnsGroup(today)),
    safely("money", "Money", "/finance", () => moneyGroup(viewer, today, now)),
    safely("trips", "Trips", "/trips", () => tripsGroup(today)),
    safely("calendar", "Coming up", "/calendar", () => calendarGroup(now)),
    safely("chores", "Kids' chores", "/family", () => choresGroup(now)),
  ]);
  const [upkeep, cars] = houseAndCars ?? [
    { key: "upkeep" as const, title: "House upkeep", href: "/maintenance", items: [], more: 0, failed: true },
    { key: "cars" as const, title: "Cars", href: "/maintenance", items: [], more: 0, failed: true },
  ];
  return [upkeep, cars, ...rest];
}
