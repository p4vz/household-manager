import { KitchenModeButton } from "@/components/kitchen-mode-button";
import { enterKitchenModeAction } from "../../kiosk/pair/actions";
import { after } from "next/server";
import { syncGoogleCalendarsIfStale } from "@/modules/calendar/api";
import { LiveRefresh } from "@/modules/family/ui/live-refresh";
import { requireUserOrRedirect } from "@/core/auth/guard";
import { CHORE_ICONS, listReturnSuggestions, memberFromLabel } from "@/modules/family/api";
import { relativeDue, shortDate } from "@/modules/family/ui/dates";
import type { SuggestionView } from "@/modules/family/ui/return-suggestions";
import { FamilyPhone } from "@/modules/family/ui/family-phone";
import {
  addOneTimeChoreAction,
  addReturnAction,
  completeUpkeepAction,
  setChoreDoneAction,
  setReturnStatusAction,
  syncCalendarAction,
} from "../../kiosk/actions";
import { addEventPhotoAction, createEventAction, eventPhotosAction, updateEventAction } from "../../kiosk/calendar-actions";
import { loadHub } from "../../kiosk/load";
import { shoppingActions } from "../../kiosk/shopping-actions-map";
import {
  addChoreAction,
  acceptSuggestionAction,
  addKidAction,
  addStarterChoresAction,
  dismissSuggestionAction,
  extractReturnAction,
  markSuggestionReturnedAction,
  archiveChoreAction,
  setChoreStarsAction,
  deleteEventAction,
  removeEventPhotoAction,
  deleteReturnAction,
  deleteShoppingItemAction,
  deleteShoppingListAction,
  deleteShoppingTemplateAction,
  removeShoppingStoreAction,
  removeKidAction,
} from "./actions";

/** Phone companion to the kitchen kiosk: calendar, lists, chores, returns, upkeep and setup. Refreshes every 45 s. */
export default async function FamilyPage() {
  const user = await requireUserOrRedirect();
  const [hub, found] = await Promise.all([loadHub(), listReturnSuggestions(memberFromLabel(user.owner))]);
  // Found in this member's own mailboxes; never loaded for the other member or the kiosk.
  const suggestions: SuggestionView[] = found.map((s) => ({
    ...s,
    deadlineLabel: s.returnDeadline ? `by ${shortDate(s.returnDeadline)} (${relativeDue(hub.today, s.returnDeadline)})` : null,
  }));
  after(() => syncGoogleCalendarsIfStale(90_000).then(() => undefined, () => undefined));
  return (
    <section className="-m-6 space-y-3 p-3 sm:m-0 sm:p-0">
      <div className="mx-auto flex max-w-md items-center justify-between">
        <h1 className="text-xl font-semibold">Family hub</h1>
        <KitchenModeButton className="min-h-12 rounded-xl border px-4 text-sm font-medium" enter={enterKitchenModeAction} />
      </div>
      <FamilyPhone
        kids={hub.kids}
        progress={hub.progress}
        shopping={hub.shopping}
        stores={hub.stores}
        returns={hub.returns}
        upkeep={hub.upkeep}
        today={hub.calendar.days[0]}
        todayIso={hub.today}
        calendar={{
          days: hub.calendar.days.slice(0, 7),
          today: hub.today,
          writableLabel: hub.calendar.writableLabel,
          configured: hub.calendar.configured,
          syncError: hub.calendar.syncError,
        }}
        dateLabel={hub.todayLabel}
        printing={hub.printing}
        icons={CHORE_ICONS}
        actions={{
          setChoreDone: setChoreDoneAction,
          addOneTimeChore: addOneTimeChoreAction,
          shopping: shoppingActions,
          shoppingMember: {
            deleteItem: deleteShoppingItemAction,
            removeStore: removeShoppingStoreAction,
            deleteList: deleteShoppingListAction,
            deleteTemplate: deleteShoppingTemplateAction,
          },
          addReturn: addReturnAction,
          setReturnStatus: setReturnStatusAction,
          completeUpkeep: completeUpkeepAction,
          addKid: addKidAction,
          removeKid: removeKidAction,
          addStarterChores: addStarterChoresAction,
          addChore: addChoreAction,
          archiveChore: archiveChoreAction,
          setChoreStars: setChoreStarsAction,
          deleteReturn: deleteReturnAction,
          memberReturns: {
            suggestions,
            accept: acceptSuggestionAction,
            markReturned: markSuggestionReturnedAction,
            dismiss: dismissSuggestionAction,
            extract: extractReturnAction,
          },
          calendar: {
            create: createEventAction,
            update: updateEventAction,
            remove: deleteEventAction,
            photos: { list: eventPhotosAction, add: addEventPhotoAction, remove: removeEventPhotoAction },
          },
          syncCalendar: syncCalendarAction.bind(null, {}),
        }}
      />
      <LiveRefresh />
    </section>
  );
}
