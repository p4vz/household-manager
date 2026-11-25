import "server-only";
import { homeWeather } from "@/core/weather/home-weather";
import { householdTimeZone } from "@/core/time/zoned";
import { KIOSK_DAYS_AHEAD, kioskCalendar, monthGridStart } from "@/modules/calendar/api";
import { choreBoard, deadlineUrgency, kidProgress, listReturns, shoppingBoard } from "@/modules/family/api";
import type { KidProgressView } from "@/modules/family/ui/goal-strip";
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

  const [calendar, kids, shopping, returns, tasks, weather, progressRows] = await Promise.all([
    kioskCalendar(KIOSK_DAYS_AHEAD, now, { from: monthGridStart(today) }),
    choreBoard(now),
    shoppingBoard(now),
    listReturns(),
    listDueTasks(twoWeeks.toISOString().slice(0, 10)),
    homeWeather(),
    kidProgress(now),
  ]);
  const progress: Record<string, KidProgressView> = Object.fromEntries(
    progressRows.map((p) => [
      p.kidId,
      {
        goals: p.goals.map((g) => ({
          id: g.id,
          choreTitle: g.choreTitle,
          choreIcon: g.choreIcon,
          kind: g.kind,
          target: g.target,
          progress: g.progress,
          reached: g.reached,
          reward: g.reward,
          rewardEmoji: g.rewardEmoji,
          unit: g.unit,
        })),
        badges: p.badges,
        bestStreak: p.bestStreak,
        nextBadge: p.nextBadge,
      },
    ]),
  );

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
    /** Bluetooth slip printing is parked until there is a printer; KIOSK_PRINTING=on brings the buttons back. */
    printing: process.env.KIOSK_PRINTING === "on",
    /** Changes on every server render; the kiosk watchdog uses it as a heartbeat. */
    renderedAt: now.getTime(),
    weather,
    today,
    todayLabel: longDate(today),
    calendar: { ...calendar, syncedLabel, syncError: calendar.sync.ok ? null : calendar.sync.message },
    kids,
    progress,
    shopping,
    stores: shopping.stores,
    returns: returnViews,
    upkeep,
  };
}
