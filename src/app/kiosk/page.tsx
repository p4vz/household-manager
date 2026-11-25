import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireKioskOrMember } from "@/core/actions/kiosk-action";
import { currentKioskDevice } from "@/core/kiosk/devices";
import { WeatherWidget } from "@/components/weather-widget";
import { KioskControls } from "@/modules/family/ui/kiosk-controls";
import { pairThisScreenAction } from "./pair/actions";
import { syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { CHORE_ICONS, openStoreCount } from "@/modules/family/api";
import { CalendarPanel } from "@/modules/family/ui/calendar-panel";
import { ChoreBoard } from "@/modules/family/ui/chore-board";
import { HubTabs } from "@/modules/family/ui/hub-tabs";
import { KioskShell } from "@/modules/family/ui/kiosk-shell";
import { PrintTodayButtons } from "@/modules/family/ui/print-today";
import { ReturnsPanel } from "@/modules/family/ui/returns-panel";
import { ShoppingPanel } from "@/modules/family/ui/shopping-panel";
import { UpkeepPanel } from "@/modules/family/ui/upkeep-panel";
import {
  addOneTimeChoreAction,
  addReturnAction,
  completeUpkeepAction,
  setChoreDoneAction,
  setReturnStatusAction,
  syncCalendarAction,
} from "./actions";
import { createEventAction, deleteEventAction, updateEventAction } from "./calendar-actions";
import { loadHub } from "./load";
import { shoppingActions } from "./shopping-actions-map";

/** Installs as its own full-screen landscape app (public/kiosk.webmanifest). */
export const metadata = { title: "Kitchen", manifest: "/kiosk.webmanifest" };

const CALENDAR_MAX_AGE_MS = 90_000;

/**
 * The kitchen wall screen (1920x1080 landscape, touch). Open to a paired
 * kiosk device or a signed-in member; see docs/SECURITY.md ("Kitchen kiosk").
 * Left ~55%: calendar. Right: chore board on top, shopping / returns /
 * upkeep below.
 */
export default async function KioskPage() {
  let actor: Awaited<ReturnType<typeof requireKioskOrMember>>;
  try {
    actor = await requireKioskOrMember();
  } catch {
    redirect("/kiosk/pair");
  }
  // A parent opened Kitchen mode: offer one-tap pairing until this device has its own kiosk cookie.
  const paired = actor.kind === "kiosk" || (await currentKioskDevice()) !== null;
  const hub = await loadHub();
  // Keep the Google mirror fresh while the screen is on: the page refreshes
  // every 30 s, and pulls from Google when the copy is over 90 s old.
  after(() => syncGoogleCalendarsIfStale(CALENDAR_MAX_AGE_MS).then(() => undefined, () => undefined));

  const urgentReturns = hub.returns.filter((r) => r.urgency !== "ok" && r.status !== "returned").length;
  const choresLeft = hub.kids.reduce((n, k) => n + Math.max(0, k.stats.todayTotal - k.stats.todayDone), 0);
  const overdueUpkeep = hub.upkeep.filter((t) => t.overdue).length;
  const printBtn = "min-h-12 rounded-xl border px-4 text-lg font-medium";

  return (
    <KioskShell
      tz={hub.tz}
      renderedAt={hub.renderedAt}
      weather={<WeatherWidget weather={hub.weather} size="kiosk" />}
      header={
        <>
        <KioskControls member={actor.kind === "member"} paired={paired} pair={pairThisScreenAction} />
        <PrintTodayButtons
          className={printBtn}
          dateLabel={hub.todayLabel}
          kids={hub.kids}
          today={hub.calendar.days[0]}
          returns={hub.returns}
          upkeep={hub.upkeep}
        />
        </>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-[55fr_45fr] gap-4">
        <section className="min-h-0 rounded-2xl bg-white/70 p-4 dark:bg-slate-900/70">
          <CalendarPanel
            days={hub.calendar.days}
            legend={hub.calendar.legend}
            configured={hub.calendar.configured}
            syncedLabel={hub.calendar.syncedLabel}
            syncError={hub.calendar.syncError}
            sync={syncCalendarAction.bind(null, {})}
            today={hub.today}
            writableLabel={hub.calendar.writableLabel}
            eventActions={{ create: createEventAction, update: updateEventAction, remove: deleteEventAction }}
          />
        </section>
        <section className="min-h-0 rounded-2xl bg-white/70 p-3 dark:bg-slate-900/70">
          <HubTabs
            tabs={[
              {
                key: "chores",
                label: "⭐ Chores",
                badge: choresLeft,
                content: <ChoreBoard kids={hub.kids} icons={CHORE_ICONS} actions={{ setDone: setChoreDoneAction, addOneTime: addOneTimeChoreAction }} />,
              },
              {
                key: "shopping",
                label: "🛒 Shopping",
                badge: openStoreCount(hub.shopping),
                content: <ShoppingPanel board={hub.shopping} today={hub.today} dateLabel={hub.todayLabel} actions={shoppingActions} expandable />,
              },
              {
                key: "returns",
                label: "📦 Returns",
                badge: hub.returns.length,
                alert: urgentReturns > 0,
                content: <ReturnsPanel returns={hub.returns} stores={hub.stores} actions={{ setStatus: setReturnStatusAction, add: addReturnAction }} />,
              },
              {
                key: "upkeep",
                label: "🔧 Upkeep",
                badge: hub.upkeep.length,
                alert: overdueUpkeep > 0,
                content: <UpkeepPanel tasks={hub.upkeep} complete={completeUpkeepAction} />,
              },
            ]}
          />
        </section>
      </div>
    </KioskShell>
  );
}
