import Link from "next/link";
import { after } from "next/server";
import { syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { LiveRefresh } from "@/modules/family/ui/live-refresh";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { CHORE_ICONS } from "@/modules/family/api";
import { FamilyPhone } from "@/modules/family/ui/family-phone";
import {
  addOneTimeChoreAction,
  addReturnAction,
  addShoppingItemAction,
  completeUpkeepAction,
  restockStaplesAction,
  setChoreDoneAction,
  setReturnStatusAction,
  setShoppingCheckedAction,
  syncCalendarAction,
} from "../../kiosk/actions";
import { createEventAction, deleteEventAction, updateEventAction } from "../../kiosk/calendar-actions";
import { loadHub } from "../../kiosk/load";
import {
  addChoreAction,
  addKidAction,
  addStapleAction,
  archiveChoreAction,
  deleteReturnAction,
  deleteShoppingItemAction,
  removeKidAction,
  setStapleAction,
} from "./actions";

/** Phone companion to the kitchen kiosk: calendar, lists, chores, returns, upkeep and setup. Refreshes every 45 s. */
export default async function FamilyPage() {
  await requireUserOrRedirect();
  const hub = await loadHub();
  after(() => syncGoogleCalendarsIfStale(90_000).then(() => undefined, () => undefined));
  return (
    <section className="-m-6 space-y-3 p-3 sm:m-0 sm:p-0">
      <div className="mx-auto flex max-w-md items-center justify-between">
        <h1 className="text-xl font-semibold">Family hub</h1>
        <Link href="/kiosk" className="text-sm underline">Open kiosk view</Link>
      </div>
      <FamilyPhone
        kids={hub.kids}
        shopping={hub.shopping}
        stores={hub.stores}
        returns={hub.returns}
        upkeep={hub.upkeep}
        today={hub.calendar.days[0]}
        calendar={{
          days: hub.calendar.days,
          today: hub.today,
          writableLabel: hub.calendar.writableLabel,
          configured: hub.calendar.configured,
          syncError: hub.calendar.syncError,
        }}
        dateLabel={hub.todayLabel}
        icons={CHORE_ICONS}
        actions={{
          setChoreDone: setChoreDoneAction,
          addOneTimeChore: addOneTimeChoreAction,
          addShopping: addShoppingItemAction,
          setShoppingChecked: setShoppingCheckedAction,
          restock: restockStaplesAction,
          addReturn: addReturnAction,
          setReturnStatus: setReturnStatusAction,
          completeUpkeep: completeUpkeepAction,
          addKid: addKidAction,
          removeKid: removeKidAction,
          addChore: addChoreAction,
          archiveChore: archiveChoreAction,
          addStaple: addStapleAction,
          setStaple: setStapleAction,
          deleteShopping: deleteShoppingItemAction,
          deleteReturn: deleteReturnAction,
          calendar: { create: createEventAction, update: updateEventAction, remove: deleteEventAction },
          syncCalendar: syncCalendarAction.bind(null, {}),
        }}
      />
      <LiveRefresh />
    </section>
  );
}
