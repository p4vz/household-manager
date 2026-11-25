"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { signOut } from "@/core/auth/config";
import { hasAdultPin } from "@/core/kiosk/adult";
import { currentKioskDevice, pairDeviceForMember, redeemPairingCode } from "@/core/kiosk/devices";
import { KIOSK_COOKIE, KIOSK_COOKIE_MAX_AGE, KIOSK_LOCK_COOKIE } from "@/core/kiosk/pairing";
import { rateLimit } from "@/core/net/rate-limit";

/**
 * The one public action: a wall screen trades a one-time pairing code (made
 * in Settings by a signed-in member) for a kiosk device cookie. Reviewed in
 * docs/SECURITY.md ("Kitchen kiosk"). Rate limited per address and in total;
 * the code itself is 40 bits, single use and lives 10 minutes.
 */
const Input = z.object({ code: z.string().max(20), name: z.string().max(60).optional() });

export type PairState = { error: string | null };

export async function pairKioskAction(_prev: PairState, form: FormData): Promise<PairState> {
  const h = await headers();
  const address = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`kiosk-pair:${address}`, 5, 10 * 60_000) || !rateLimit("kiosk-pair:all", 30, 60 * 60_000)) {
    return { error: "Too many tries. Wait a few minutes and make a new code." };
  }
  const parsed = Input.safeParse({ code: form.get("code") ?? "", name: form.get("name") || undefined });
  if (!parsed.success) return { error: "That code doesn't look right." };

  const token = await redeemPairingCode(parsed.data.code, parsed.data.name ?? "Kitchen screen");
  if (!token) return { error: "That code is wrong, used or expired. Make a new one in Settings." };

  await setKioskCookie(token);
  redirect("/kiosk");
}

/** The device cookie (rides on /kiosk only) and the lock that keeps this browser on /kiosk. */
async function setKioskCookie(token: string) {
  const jar = await cookies();
  const base = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, maxAge: KIOSK_COOKIE_MAX_AGE };
  jar.set(KIOSK_COOKIE, token, { ...base, path: "/kiosk" });
  // Lax, so it still rides on a link opened from another app.
  jar.set(KIOSK_LOCK_COOKIE, "1", { ...base, sameSite: "lax", path: "/" });
}

/**
 * "Kitchen mode" from the signed-in app: turns the device the member is
 * holding into the kitchen screen. Member-only (authedAction): a kiosk cookie
 * alone can never pair another device. Needs an adult PIN first, because
 * leaving kitchen mode needs one. Signs the member out on this device, so the
 * screen runs only on its kiosk pairing and kids can't reach the app.
 */
export const enterKitchenModeAction = authedAction(z.object({}), async (_input, user): Promise<{ error: string | null }> => {
  if (!(await hasAdultPin())) return { error: "Set an adult PIN in Settings first: leaving kitchen mode needs it." };
  const token = await pairDeviceForMember(user.owner, "Kitchen screen");
  await setKioskCookie(token);
  await signOut({ redirect: false });
  return { error: null };
});

/**
 * A screen in kitchen mode whose pairing was removed in Settings: clears its
 * kiosk cookies so it becomes an ordinary browser. Open to anyone, but it
 * does nothing while this browser still has a working pairing, so it can't
 * be used to leave kitchen mode without the adult PIN.
 */
export async function clearUnpairedScreenAction(): Promise<void> {
  if (await currentKioskDevice()) return;
  const jar = await cookies();
  jar.delete({ name: KIOSK_COOKIE, path: "/kiosk" });
  jar.delete({ name: KIOSK_LOCK_COOKIE, path: "/" });
  redirect("/signin");
}
