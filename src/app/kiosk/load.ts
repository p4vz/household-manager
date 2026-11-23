import "server-only";
import { householdTimeZone } from "@/core/time/zoned";
import { kioskCalendar } from "@/modules/calendar/api";
import { choreBoard, deadlineUrgency, listReturns, listShopping, listStores } from "@/modules/family/api";
import type { ReturnView } from "@/modules/family/ui/returns-panel";
import type { UpkeepView } from "@/modules/family/ui/upkeep-panel";
import { householdToday, longDate, relativeDue, shortDate } from "@/modules/family/ui/dates";
import { listDueTasks } from "@/modules/maintenance/api";

/** Everything the kiosk and the phone view show, shaped for the client components. */
export async function loadHub(now = new Date()) {
  const tz = householdTimeZone();
  const today = householdToday(now);
  const twoWeeks = new Date(`${today}T00:00:00Z`);
  twoWeeks.setUTCDate(twoWeeks.getUTCDate() + 14);

  const [calendar, kids, shopping, stores, returns, tasks] = await Promise.all([
    kioskCalendar(7, now),
    choreBoard(now),
    listShopping(),
    listStores(),
    listReturns(),
    listDueTasks(twoWeeks.toISOString().slice(0, 10)),
  ]);

  const returnViews: ReturnView[] = returns.map((r) => ({
    ...r,
    urgency: deadlineUrgency(today, r.returnDeadline),
    deadlineLabel: r.returnDeadline ? `by ${shortDate(r.returnDeadline)} (${relativeDue(today, r.returnDeadline)})` : null,
  }));

  const upkeep: UpkeepView[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    dueLabel: `${shortDate(t.dueDate)} (${relativeDue(today, t.dueDate)})`,
    overdue: t.dueDate < today,
    repeatLabel: t.recurrenceDays ? `every ${t.recurrenceDays} days` : null,
    notes: t.notes,
  }));

  const syncedLabel = calendar.sync.lastSyncAt
    ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(calendar.sync.lastSyncAt))
    : null;

  return {
    tz,
    today,
    todayLabel: longDate(today),
    calendar: { ...calendar, syncedLabel, syncError: calendar.sync.ok ? null : calendar.sync.message },
    kids,
    shopping,
    stores,
    returns: returnViews,
    upkeep,
  };
}
