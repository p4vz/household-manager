import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ADULT_ABILITIES, CHILD_SAFE_ABILITIES, isAdult, kioskMay } from "@/core/kiosk/permissions";
import { freshDb } from "./helpers/db";

/**
 * Kids use the kitchen screen. Calls every server action in the app as a
 * paired kiosk device with no Google session, and checks that only the
 * child-safe kiosk actions get past the permission check.
 */
/** The paired screen making every call; adult mode off unless a test turns it on. */
const device = { id: "00000000-0000-4000-8000-000000000001", name: "Kitchen", adultUntil: null as Date | null };
vi.mock("@/core/auth/config", () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/core/kiosk/devices", async (orig) => ({
  ...(await orig<typeof import("@/core/kiosk/devices")>()),
  currentKioskDevice: vi.fn(async () => device),
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const actionFiles = walk(SRC)
  .filter((f) => /^\s*["']use server["'];/.test(readFileSync(f, "utf8")))
  .map((f) => relative(SRC, f))
  .sort();

/** Kiosk actions kids may run, with the ability each one needs. */
const CHILD_SAFE_ACTIONS: Record<string, string> = {
  setChoreDoneAction: "chores.tick",
  addOneTimeChoreAction: "chores.add",
  logReadingAction: "reading.log",
  deleteReadingAction: "reading.log",
  addReturnAction: "returns.add",
  syncCalendarAction: "calendar.sync",
  syncShoppingAction: "hub.view",
  addShoppingItemAction: "shopping.add",
  setShoppingCheckedAction: "shopping.tick",
  moveShoppingItemAction: "shopping.arrange",
  createShoppingListAction: "shopping.add",
  renameShoppingListAction: "shopping.arrange",
  deferShoppingListAction: "shopping.arrange",
  reorderShoppingListsAction: "shopping.arrange",
  addShoppingStoreAction: "shopping.add",
  reorderShoppingStoresAction: "shopping.arrange",
  saveShoppingTemplateAction: "shopping.arrange",
  createEventAction: "calendar.add",
  updateEventAction: "calendar.edit",
  eventPhotosAction: "hub.view",
  addEventPhotoAction: "calendar.photo.add",
  unlockAdultAction: "adult.unlock",
  lockAdultAction: "adult.lock",
};
/** Kiosk actions that need adult mode (adult PIN) on the screen. */
const ADULT_ACTIONS: Record<string, string> = {
  setReturnStatusAction: "returns.status",
  completeUpkeepAction: "upkeep.complete",
  deleteEventAdultAction: "calendar.delete",
  removeEventPhotoAdultAction: "calendar.photo.remove",
  exitKitchenModeAction: "kiosk.exit",
  askKitchenAction: "assistant.kitchen",
  kitchenChangeAction: "assistant.kitchen",
};
/**
 * Public by design: the rate-limited code exchange that pairs a screen, and
 * clearing an unpaired screen (does nothing while the pairing works; tested below).
 */
const PUBLIC = new Set(["app/kiosk/pair/actions.ts:pairKioskAction", "app/kiosk/pair/actions.ts:clearUnpairedScreenAction"]);

function refusal(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (err.message === "Unauthorized") return "no session";
  if (err.name === "KioskNotAllowedError") return "needs an adult";
  const digest = (err as { digest?: string }).digest ?? "";
  if (digest.startsWith("NEXT_REDIRECT") && digest.includes("/signin")) return "sent to sign-in";
  // Trip forms report errors by redirecting back with the message.
  if (digest.startsWith("NEXT_REDIRECT") && digest.includes("error=Unauthorized")) return "refused on the form";
  return null;
}

beforeAll(async () => {
  await freshDb();
});

describe("kid-proof kitchen screen", () => {
  it("only child-safe abilities work without an adult", () => {
    const kiosk = { kind: "kiosk" as const, adultUntil: null };
    for (const a of CHILD_SAFE_ABILITIES) expect(kioskMay(kiosk, a)).toBe(true);
    for (const a of ADULT_ABILITIES) expect(kioskMay(kiosk, a)).toBe(false);
    for (const a of ADULT_ABILITIES) expect(kioskMay({ kind: "member" }, a)).toBe(true);
    // The later "adult unlock" hook: valid only until it runs out.
    const now = new Date("2026-11-25T12:00:00Z");
    expect(isAdult({ kind: "kiosk", adultUntil: new Date("2026-11-25T12:05:00Z") }, now)).toBe(true);
    expect(isAdult({ kind: "kiosk", adultUntil: new Date("2026-11-25T11:59:00Z") }, now)).toBe(false);
  });

  it("finds the server action files", () => {
    expect(actionFiles).toContain("app/kiosk/actions.ts");
    expect(actionFiles).toContain("app/(app)/finance/actions.ts");
    expect(actionFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("refuses every other server action to a kiosk device", { timeout: 60_000 }, async () => {
    const leaks: string[] = [];
    const seenSafe = new Set<string>();
    for (const file of actionFiles) {
      const mod = (await import(`@/${file.replace(/\.tsx?$/, "")}`)) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        if (PUBLIC.has(`${file}:${name}`)) continue;
        if (file.startsWith("app/kiosk/") && CHILD_SAFE_ACTIONS[name]) {
          seenSafe.add(name);
          continue;
        }
        // Filled in, so form wrappers that skip empty input still reach their check.
        const form = new FormData();
        for (const [k, v] of Object.entries({ id: device.id, limit: "1", category: "Food", productId: "x", name: "x" })) form.set(k, v);
        const args = fn.length >= 2 ? [null, form] : [form];
        try {
          const out = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
          // Some form actions turn the refusal into a message for the form.
          if (!/Unauthorized/.test(JSON.stringify(out ?? null))) leaks.push(`${file}:${name} ran`);
        } catch (err) {
          if (!refusal(err)) leaks.push(`${file}:${name} failed with ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect([...seenSafe].sort()).toEqual(Object.keys(CHILD_SAFE_ACTIONS).sort());
  });

  it("names an ability on every kiosk action, and only the listed ones need an adult", () => {
    const src = ["actions.ts", "shopping-actions.ts", "calendar-actions.ts", "adult-actions.ts", "reading-actions.ts"].map((f) => readFileSync(join(SRC, "app/kiosk", f), "utf8")).join("\n");
    const declared = Object.fromEntries([...src.matchAll(/export const (\w+) = kioskAction\(\s*"([\w.]+)"/g)].map((m) => [m[1], m[2]]));
    expect(declared).toEqual({ ...CHILD_SAFE_ACTIONS, ...ADULT_ACTIONS });
    for (const a of Object.values(CHILD_SAFE_ACTIONS)) expect(CHILD_SAFE_ABILITIES).toContain(a);
    for (const a of Object.values(ADULT_ACTIONS)) expect(ADULT_ABILITIES).toContain(a);
  });

  it("clearing an unpaired screen does nothing while its pairing works", async () => {
    const { clearUnpairedScreenAction } = await import("@/app/kiosk/pair/actions");
    await expect(clearUnpairedScreenAction()).resolves.toBeUndefined();
  });

  it("adult mode lets the screen past the adult check, and only until it runs out", async () => {
    const mod = { ...(await import("@/app/kiosk/actions")), ...(await import("@/app/kiosk/adult-actions")) } as Record<string, (i: unknown) => Promise<unknown>>;
    device.adultUntil = new Date(Date.now() + 60_000);
    for (const name of Object.keys(ADULT_ACTIONS).filter((n) => n !== "exitKitchenModeAction")) {
      // Bad input: refused by the input check, which runs only after the permission check passed.
      await expect(mod[name]({ id: "not-a-uuid", taskId: "x", status: "nope" }), name).rejects.toThrow(/invalid|expected/i);
    }
    // Leaving kitchen mode gets as far as the cookies (no request in a test).
    await expect(mod.exitKitchenModeAction({})).rejects.toThrow(/cookies/);
    device.adultUntil = new Date(Date.now() - 1000);
    for (const name of Object.keys(ADULT_ACTIONS)) await expect(mod[name]({}), name).rejects.toThrow(/adult needs to do that/);
    device.adultUntil = null;
  });
});
