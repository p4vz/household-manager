import { after } from "next/server";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { householdTimeZone } from "@/core/time/zoned";
import { KIOSK_DAYS_AHEAD, kioskCalendar, monthGridStart, syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { CalendarPanel } from "@/modules/family/ui/calendar-panel";
import { householdToday } from "@/modules/family/ui/dates";
import { LiveRefresh } from "@/modules/family/ui/live-refresh";
import { syncCalendarAction } from "../../kiosk/actions";
import { createEventAction, updateEventAction } from "../../kiosk/calendar-actions";
import { deleteEventAction } from "../family/actions";

export const metadata = { title: "Calendar" };

/**
 * The family calendar in the app (phone and computer): the same week, month
 * and 4-day views as the kitchen screen, plus deleting events, which only a
 * signed-in member can do. Refreshes every 45 s and pulls from Google when
 * the copy is over 90 s old.
 */
export default async function CalendarPage() {
  await requireUserOrRedirect();
  const now = new Date();
  const tz = householdTimeZone();
  const today = householdToday(now);
  const calendar = await kioskCalendar(KIOSK_DAYS_AHEAD, now, { from: monthGridStart(today) });
  after(() => syncGoogleCalendarsIfStale(90_000).then(() => undefined, () => undefined));
  const syncedLabel = calendar.sync.lastSyncAt
    ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(calendar.sync.lastSyncAt))
    : null;

  return (
    <section className="-mx-2 flex h-[calc(100dvh-8.5rem)] min-h-[34rem] flex-col sm:mx-0">
      <h1 className="sr-only">Calendar</h1>
      <CalendarPanel
        days={calendar.days}
        earlier={calendar.earlier}
        legend={calendar.legend}
        configured={calendar.configured}
        syncedLabel={syncedLabel}
        syncError={calendar.sync.ok ? null : calendar.sync.message}
        sync={syncCalendarAction.bind(null, {})}
        today={today}
        writableLabel={calendar.writableLabel}
        eventActions={{ create: createEventAction, update: updateEventAction, remove: deleteEventAction }}
      />
      <LiveRefresh />
    </section>
  );
}
