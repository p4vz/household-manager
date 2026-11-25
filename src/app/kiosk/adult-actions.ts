"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { kioskAction } from "@/core/actions/kiosk-action";
import { askKitchen, KITCHEN_MAX_QUESTION, KITCHEN_MAX_TURNS } from "@/assistant/kitchen";
import { endAdultMode, tryAdultPin } from "@/core/kiosk/adult";
import { revokeKioskDevice } from "@/core/kiosk/devices";
import { KIOSK_COOKIE, KIOSK_LOCK_COOKIE } from "@/core/kiosk/pairing";
import { PIN_MAX } from "@/core/kiosk/pin";
import { rateLimit } from "@/core/net/rate-limit";
import { CalendarWriteError, deleteGoogleEvent, removeEventPhoto } from "@/modules/calendar/api";

/**
 * Adult mode on the kitchen screen (core/kiosk/adult.ts). Trying the PIN and
 * locking again are open to the screen; everything else here needs adult
 * mode, checked on the server by kioskAction's ability. Money, trips and
 * settings are not reachable from the screen even then, and Ask Claude here
 * only knows what the kitchen screen shows (assistant/kitchen.ts).
 */
const id = z.uuid();

function refresh() {
  revalidatePath("/kiosk");
  revalidatePath("/family");
  revalidatePath("/calendar");
}

export type UnlockResult = { ok: true; until: string } | { ok: false; error: string };

export const unlockAdultAction = kioskAction("adult.unlock", z.object({ pin: z.string().max(PIN_MAX + 4) }), async ({ pin }, actor): Promise<UnlockResult> => {
  if (actor.kind !== "kiosk") return { ok: false, error: "This is for the kitchen screen." };
  // Per-screen lockout lives in the database; this also caps bursts in memory.
  if (!rateLimit(`kiosk-pin:${actor.device.id}`, 10, 60_000)) return { ok: false, error: "Too many tries. Wait a minute." };
  const res = await tryAdultPin(actor.device.id, pin.trim());
  if (res.ok) {
    refresh();
    return { ok: true, until: res.until.toISOString() };
  }
  if (res.reason === "no-pin") return { ok: false, error: "No adult PIN yet. Set one in Settings on your phone." };
  if (res.reason === "locked") {
    const mins = Math.max(1, Math.ceil((res.lockedUntil.getTime() - Date.now()) / 60_000));
    return { ok: false, error: `Too many wrong PINs. Try again in ${mins} min.` };
  }
  return { ok: false, error: `Wrong PIN. ${res.triesLeft} ${res.triesLeft === 1 ? "try" : "tries"} left.` };
});

export const lockAdultAction = kioskAction("adult.lock", z.object({}), async (_input, actor) => {
  if (actor.kind === "kiosk") await endAdultMode(actor.device.id);
  refresh();
});

type Result = { error: string | null };

export const deleteEventAdultAction = kioskAction("calendar.delete", z.object({ id }), async ({ id: eventId }): Promise<Result> => {
  try {
    await deleteGoogleEvent(eventId);
  } catch (err) {
    if (!(err instanceof CalendarWriteError)) throw err;
    refresh();
    return { error: err.message };
  }
  refresh();
  return { error: null };
});

export const removeEventPhotoAdultAction = kioskAction("calendar.photo.remove", z.object({ id }), async ({ id: photoId }): Promise<Result> => {
  await removeEventPhoto(photoId);
  refresh();
  return { error: null };
});

/** Ask Claude about the calendar, chores, shopping, returns and upkeep. Nothing is stored. */
export const askKitchenAction = kioskAction(
  "assistant.kitchen",
  z.object({
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) })).max(KITCHEN_MAX_TURNS * 2),
    question: z.string().trim().min(1).max(KITCHEN_MAX_QUESTION),
  }),
  async ({ history, question }, actor): Promise<{ answer: string | null; error: string | null }> => {
    const who = actor.kind === "kiosk" ? actor.device.id : "member";
    if (!rateLimit(`kiosk-ask:${who}`, 20, 10 * 60_000)) return { answer: null, error: "That's a lot of questions. Try again in a few minutes." };
    try {
      return { answer: await askKitchen(history, question), error: null };
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      return { answer: null, error: /key|subscription|configur/i.test(m) ? "Claude isn't set up yet. Add it in Settings on your phone." : "Claude couldn't answer. Try again." };
    }
  },
);

/**
 * Leaves kitchen mode on this screen: unpairs it and removes both kiosk
 * cookies, so the browser is an ordinary signed-out browser again. Needs
 * adult mode, so kids can't get from the kitchen screen into the app.
 */
export const exitKitchenModeAction = kioskAction("kiosk.exit", z.object({}), async (_input, actor) => {
  if (actor.kind === "kiosk") await revokeKioskDevice(actor.device.id);
  const jar = await cookies();
  jar.delete({ name: KIOSK_COOKIE, path: "/kiosk" });
  jar.delete({ name: KIOSK_LOCK_COOKIE, path: "/" });
});
