"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { pairDeviceForMember, redeemPairingCode } from "@/core/kiosk/devices";
import { KIOSK_COOKIE, KIOSK_COOKIE_MAX_AGE } from "@/core/kiosk/pairing";
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

async function setKioskCookie(token: string) {
  (await cookies()).set(KIOSK_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/kiosk",
    maxAge: KIOSK_COOKIE_MAX_AGE,
  });
}

/**
 * "Pair this screen": a signed-in member at the kitchen screen pairs it in
 * one tap, no code needed. Member-only (authedAction): a kiosk cookie alone
 * can never pair another device. The new cookie has the same limits as one
 * from a code (path /kiosk, kiosk actions only), so the member can then sign
 * out of Google on that device and the screen keeps working.
 */
export const pairThisScreenAction = authedAction(z.object({}), async (_input, user) => {
  const token = await pairDeviceForMember(user.owner, "Kitchen screen");
  await setKioskCookie(token);
});
