import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { db } from "@/core/db/client";
import { coreKioskAdultPin, coreKioskDevices } from "@/core/db/core-schema";
import { endAdultMode, hasAdultPin, setAdultPin, tryAdultPin } from "@/core/kiosk/adult";
import { verifyDeviceToken } from "@/core/kiosk/devices";
import { sha256 } from "@/core/kiosk/pairing";
import { hashPin, pinMatches, weakPinReason } from "@/core/kiosk/pin";

const TOKEN = "a".repeat(43);
let deviceId = "";

beforeAll(async () => {
  await freshDb();
  const [row] = await db().insert(coreKioskDevices).values({ name: "Kitchen", tokenHash: sha256(TOKEN), createdBy: "User 1" }).returning({ id: coreKioskDevices.id });
  deviceId = row.id;
});

describe("adult PIN rules", () => {
  it("hashes with a salt and checks in constant time", () => {
    const a = hashPin("2580");
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toContain("2580");
    expect(hashPin("2580")).not.toBe(a);
    expect(pinMatches("2580", a)).toBe(true);
    expect(pinMatches("2581", a)).toBe(false);
    expect(pinMatches("2580", "garbage")).toBe(false);
  });

  it("refuses PINs kids guess first", () => {
    expect(weakPinReason("123")).toMatch(/4 to 8/);
    expect(weakPinReason("12a4")).toMatch(/4 to 8/);
    expect(weakPinReason("0000")).toMatch(/same digit/);
    expect(weakPinReason("1234")).toMatch(/in a row/);
    expect(weakPinReason("4321")).toMatch(/in a row/);
    expect(weakPinReason("2580")).toBeNull();
    expect(weakPinReason("739164")).toBeNull();
  });
});

describe("adult mode on the kitchen screen", () => {
  const t0 = new Date("2026-11-25T12:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it("does nothing until a member sets a PIN", async () => {
    expect(await hasAdultPin()).toBe(false);
    expect(await tryAdultPin(deviceId, "2580", t0)).toEqual({ ok: false, reason: "no-pin" });
  });

  it("unlocks for five minutes with the right PIN, held on the server", async () => {
    await setAdultPin("2580", "User 1", t0);
    expect(await hasAdultPin()).toBe(true);
    const [row] = await db().select().from(coreKioskAdultPin);
    expect(row.pinHash).not.toContain("2580");

    const res = await tryAdultPin(deviceId, "2580", t0);
    expect(res).toEqual({ ok: true, until: at(5 * 60_000) });
    expect((await verifyDeviceToken(TOKEN, t0))?.adultUntil).toEqual(at(5 * 60_000));
    await endAdultMode(deviceId);
    expect((await verifyDeviceToken(TOKEN, t0))?.adultUntil).toBeNull();
  });

  it("locks the screen out for 15 minutes after five wrong PINs, even for the right one", async () => {
    for (let i = 4; i >= 1; i--) expect(await tryAdultPin(deviceId, "9999", at(i))).toEqual({ ok: false, reason: "wrong", triesLeft: i });
    expect(await tryAdultPin(deviceId, "9999", at(5))).toEqual({ ok: false, reason: "locked", lockedUntil: at(5 + 15 * 60_000) });
    expect(await tryAdultPin(deviceId, "2580", at(60_000))).toMatchObject({ ok: false, reason: "locked" });
    // After the lockout the right PIN works again and the count starts over.
    expect(await tryAdultPin(deviceId, "2580", at(16 * 60_000))).toMatchObject({ ok: true });
    const [dev] = await db().select().from(coreKioskDevices).where(eq(coreKioskDevices.id, deviceId));
    expect(dev.pinFailures).toBe(0);
  });

  it("changing the PIN ends adult mode on every screen", async () => {
    expect((await tryAdultPin(deviceId, "2580", t0)).ok).toBe(true);
    await setAdultPin("739164", "User 2", t0);
    expect((await verifyDeviceToken(TOKEN, t0))?.adultUntil).toBeNull();
    expect(await tryAdultPin(deviceId, "2580", t0)).toMatchObject({ ok: false, reason: "wrong" });
    expect((await tryAdultPin(deviceId, "739164", t0)).ok).toBe(true);
    await expect(setAdultPin("1111", "User 1")).rejects.toThrow(/same digit/);
  });
});
