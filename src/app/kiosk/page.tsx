import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { currentUser } from "@/core/auth/guard";
import { currentKioskDevice } from "@/core/kiosk/devices";
import { KIOSK_LOCK_COOKIE } from "@/core/kiosk/pairing";
import { isAdult } from "@/core/kiosk/permissions";
import { KitchenModeButton } from "@/components/kitchen-mode-button";
import { WeatherWidget } from "@/components/weather-widget";
import { KioskControls } from "@/modules/family/ui/kiosk-controls";
import { clearUnpairedScreenAction, enterKitchenModeAction } from "./pair/actions";
import { askKitchenAction, deleteEventAdultAction, exitKitchenModeAction, lockAdultAction, removeEventPhotoAdultAction, unlockAdultAction } from "./adult-actions";
import { syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { CHORE_ICONS, openStoreCount } from "@/modules/family/api";
import { CalendarPanel } from "@/modules/family/ui/calendar-panel";
import { ChoreBoard } from "@/modules/family/ui/chore-board";
import { HubTabs } from "@/modules/family/ui/hub-tabs";
import { KioskShell } from "@/modules/family/ui/kiosk-shell";
import { PrintTodayButtons } from "@/modules/family/ui/print-today";
import { ResizableSplit } from "@/modules/family/ui/resizable-split";
import { ReturnsPanel } from "@/modules/family/ui/returns-panel";
import { ShoppingPanel } from "@/modules/family/ui/shopping-panel";
import { UpkeepPanel } from "@/modules/family/ui/upkeep-panel";
import { addOneTimeChoreAction, addReturnAction, completeUpkeepAction, setChoreDoneAction, setReturnStatusAction, syncCalendarAction } from "./actions";
import { addEventPhotoAction, createEventAction, eventPhotosAction, updateEventAction } from "./calendar-actions";
import { loadHub } from "./load";
import { shoppingActions } from "./shopping-actions-map";

/** Installs as its own full-screen landscape app (public/kiosk.webmanifest). */
export const metadata = { title: "Aprelev Kitchen", manifest: "/kiosk.webmanifest" };

const CALENDAR_MAX_AGE_MS = 90_000;

/**
 * The kitchen wall screen (1920x1080 landscape, touch). Open to a paired
 * kiosk device only; see docs/SECURITY.md ("Kitchen kiosk"). Left: calendar
 * (55% to start; the divider drags). Right: chores, shopping, returns and
 * upkeep as tabs. Kids use this screen, so it is locked to /kiosk and
 * deleting, finishing upkeep, moving returns along and leaving need adult
 * mode (adult PIN, five minutes).
 */
export default async function KioskPage() {
  const device = await currentKioskDevice();
  if (!device) return <NotKitchenScreen />;
  const actor = { kind: "kiosk" as const, adultUntil: device.adultUntil };
  const adult = isAdult(actor);
  const hub = await loadHub();
  // Keep the Google mirror fresh while the screen is on: the page refreshes
  // every 30 s, and pulls from Google when the copy is over 90 s old.
  after(() =>
    syncGoogleCalendarsIfStale(CALENDAR_MAX_AGE_MS).then(
      () => undefined,
      () => undefined,
    ),
  );

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
          <KioskControls
            adult={{
              until: adult && device.adultUntil ? device.adultUntil.toISOString() : null,
              unlock: unlockAdultAction,
              lock: lockAdultAction,
              exit: exitKitchenModeAction,
              ask: askKitchenAction,
            }}
          />
          {hub.printing ? (
            <PrintTodayButtons
              className={printBtn}
              dateLabel={hub.todayLabel}
              kids={hub.kids}
              today={hub.calendar.days[0]}
              returns={hub.returns}
              upkeep={hub.upkeep}
            />
          ) : null}
        </>
      }
    >
      <ResizableSplit
        left={
          <section className="h-full min-h-0 rounded-2xl bg-white/70 p-4 dark:bg-slate-900/70">
            <CalendarPanel
              days={hub.calendar.days}
              earlier={hub.calendar.earlier}
              legend={hub.calendar.legend}
              configured={hub.calendar.configured}
              syncedLabel={hub.calendar.syncedLabel}
              syncError={hub.calendar.syncError}
              sync={syncCalendarAction.bind(null, {})}
              today={hub.today}
              writableLabel={hub.calendar.writableLabel}
              eventActions={{
                create: createEventAction,
                update: updateEventAction,
                remove: adult ? deleteEventAdultAction : undefined,
                photos: { list: eventPhotosAction, add: addEventPhotoAction, remove: adult ? removeEventPhotoAdultAction : undefined },
              }}
            />
          </section>
        }
        right={
          <section className="h-full min-h-0 rounded-2xl bg-white/70 p-3 dark:bg-slate-900/70">
            <HubTabs
              tabs={[
                {
                  key: "chores",
                  label: "⭐ Chores",
                  badge: choresLeft,
                  content: (
                    <ChoreBoard
                      kids={hub.kids}
                      progress={hub.progress}
                      icons={CHORE_ICONS}
                      actions={{
                        setDone: setChoreDoneAction,
                        addOneTime: addOneTimeChoreAction,
                      }}
                    />
                  ),
                },
                {
                  key: "shopping",
                  label: "🛒 Shopping",
                  badge: openStoreCount(hub.shopping),
                  content: (
                    <ShoppingPanel
                      board={hub.shopping}
                      today={hub.today}
                      dateLabel={hub.todayLabel}
                      actions={shoppingActions}
                      expandable
                      printing={hub.printing}
                    />
                  ),
                },
                {
                  key: "returns",
                  label: "📦 Returns",
                  badge: hub.returns.length,
                  alert: urgentReturns > 0,
                  content: (
                    <ReturnsPanel
                      returns={hub.returns}
                      stores={hub.stores}
                      actions={{
                        setStatus: adult ? setReturnStatusAction : undefined,
                        add: addReturnAction,
                      }}
                    />
                  ),
                },
                {
                  key: "upkeep",
                  label: "🔧 Upkeep",
                  badge: hub.upkeep.length,
                  alert: overdueUpkeep > 0,
                  content: <UpkeepPanel tasks={hub.upkeep} complete={adult ? completeUpkeepAction : undefined} />,
                },
              ]}
            />
          </section>
        }
      />
    </KioskShell>
  );
}

/**
 * /kiosk without a working pairing. A signed-in member can turn this device
 * into the kitchen screen; a screen whose pairing was removed in Settings
 * can be cleared; anyone else goes to the pairing page.
 */
async function NotKitchenScreen() {
  const locked = (await cookies()).has(KIOSK_LOCK_COOKIE);
  const member = locked ? null : await currentUser();
  if (!locked && !member) redirect("/kiosk/pair");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5 rounded-2xl border p-8">
        {locked ? (
          <>
            <h1 className="text-2xl font-semibold">This screen was unpaired</h1>
            <p className="opacity-80">Someone removed it in Settings. Pair it again with a code from Settings, or turn it back into an ordinary browser.</p>
            <div className="flex flex-wrap gap-2">
              <a href="/kiosk/pair" className="min-h-12 rounded-xl bg-sky-600 px-4 py-3 font-medium text-white">
                Pair again
              </a>
              <form action={clearUnpairedScreenAction}>
                <button type="submit" className="min-h-12 rounded-xl border px-4 font-medium">
                  Use as a normal browser
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">This isn&apos;t the kitchen screen</h1>
            <p className="opacity-80">
              The kitchen screen runs on its own pairing, without your Google sign-in, so kids can&apos;t get into the app. Make this device the kitchen
              screen, or pair the wall screen with a code from Settings.
            </p>
            <KitchenModeButton className="min-h-12 rounded-xl bg-sky-600 px-4 font-medium text-white" label="Make this the kitchen screen" enter={enterKitchenModeAction} />
          </>
        )}
      </div>
    </main>
  );
}
