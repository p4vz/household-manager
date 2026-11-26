import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { calendarGoogleEvents, financeAccounts, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

vi.mock("@/core/net/outbound", () => ({ outboundFetch: vi.fn() }));

const { nextVisit, recordVisit, SITTING_MS } = await import("@/core/visits");
const { noteCronCall } = await import("@/core/net/cron-seen");
const { onboarding, tickStep, needsWelcome, markWelcomed, legalNamesLookRight, setOnboardingHidden } = await import("@/assistant/onboarding");
const { whatsNew, listWords } = await import("@/assistant/whats-new");
const family = await import("@/modules/family/api");
const maintenance = await import("@/modules/maintenance/api");

const NOW = new Date("2026-11-26T17:00:00Z");
const TODAY = "2026-11-26";
let db: Db;

beforeEach(async () => {
  db = await freshDb();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOME_WEATHER", "");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "");
});

describe("visits", () => {
  it("first visit has nothing to compare; a new sitting compares with the last one; a refresh keeps it", () => {
    const first = nextVisit(null, NOW);
    expect(first.since).toBeNull();
    const later = new Date(NOW.getTime() + 2 * SITTING_MS);
    const second = nextVisit(first.rec, later);
    expect(second.since?.toISOString()).toBe(NOW.toISOString());
    const refresh = nextVisit(second.rec, new Date(later.getTime() + 60_000));
    expect(refresh.since?.toISOString()).toBe(NOW.toISOString());
  });

  it("stores visits per member", async () => {
    expect((await recordVisit("User 1", NOW)).firstVisit).toBe(true);
    expect((await recordVisit("User 2", NOW)).firstVisit).toBe(true);
    const again = await recordVisit("User 1", new Date(NOW.getTime() + 3_600_000));
    expect(again.since?.toISOString()).toBe(NOW.toISOString());
  });
});

describe("onboarding", () => {
  it("legal names need the Legal Name=Nickname form", () => {
    expect(legalNamesLookRight("")).toBe(false);
    expect(legalNamesLookRight("Pat Example")).toBe(false);
    expect(legalNamesLookRight("Pat Example=Pat, Sam Example")).toBe(true);
  });

  it("Pavel's list checks setup by itself and keeps his own ticks", async () => {
    let o = await onboarding("User 1", NOW, "Raisa");
    const step = (id: string) => o.steps.find((s) => s.id === id)!;
    expect(step("weather").done).toBe(false);
    expect(step("cron").done).toBe(false);
    expect(step("raisa").title).toBe("Get Raisa signed in");

    vi.stubEnv("HOME_WEATHER", "Town, PA|40.1|-75.1");
    await noteCronCall("card-catalog", NOW);
    await maintenance.addVehicle({ name: "Car A" }, { today: TODAY });
    await maintenance.addVehicle({ name: "Car B" }, { today: TODAY });
    await recordVisit("User 2", NOW);
    await tickStep("User 1", "accounts", true);
    o = await onboarding("User 1", NOW, "Raisa");
    expect(step("weather")).toMatchObject({ done: true, doneBy: "checked" });
    expect(step("cron").done).toBe(true);
    expect(step("cars").done).toBe(true);
    expect(step("raisa").done).toBe(true);
    expect(step("accounts")).toMatchObject({ done: true, doneBy: "ticked" });
    expect(o.done).toBe(o.steps.filter((s) => s.done).length);

    // A cron call older than three days no longer counts.
    o = await onboarding("User 1", new Date(NOW.getTime() + 4 * 86_400_000), "Raisa");
    expect(step("cron").done).toBe(false);

    await tickStep("User 1", "accounts", false);
    o = await onboarding("User 1", NOW, "Raisa");
    expect(step("accounts").done).toBe(false);
    await expect(tickStep("User 1", "<script>", true)).rejects.toThrow();
    await expect(tickStep("User 2", "cron", true)).rejects.toThrow();
  });

  it("Raisa gets a first-login welcome once; ticks and hiding are per member", async () => {
    expect(await needsWelcome("User 1")).toBe(false);
    expect(await needsWelcome("User 2")).toBe(true);
    expect(await markWelcomed("User 2", NOW)).toBe(true);
    expect(await markWelcomed("User 2", NOW)).toBe(false);
    expect(await needsWelcome("User 2")).toBe(false);

    await tickStep("User 2", "subscriptions", true);
    await setOnboardingHidden("User 2", true);
    const raisa = await onboarding("User 2", NOW);
    const pavel = await onboarding("User 1", NOW);
    expect(raisa.hidden).toBe(true);
    expect(pavel.hidden).toBe(false);
    expect(raisa.steps.find((s) => s.id === "subscriptions")?.done).toBe(true);
    expect(raisa.steps.map((s) => s.id)).toEqual(["accounts", "subscriptions", "install", "push", "calendar", "email", "kids", "ask"]);
  });
});

describe("since your last visit", () => {
  it("lists what changed, with money limited to the viewer's accounts", async () => {
    const since = new Date("2026-11-25T12:00:00Z");
    const [mine, hers] = await db
      .insert(financeAccounts)
      .values([
        { bankName: "His Card", owner: "user1", kind: "credit" },
        { bankName: "Her Card", owner: "user2", kind: "credit" },
      ])
      .returning();
    const txn = (accountId: string, amount: number, externalId: string, createdAt: Date, source: "simplefin" | "csv" = "simplefin") => ({
      accountId,
      source,
      externalId,
      postedDate: "2026-11-25",
      amount,
      merchant: "Shop",
      description: "Shop",
      category: "Shopping",
      createdAt,
    });
    await db.insert(financeTransactions).values([
      txn(mine.id, -40, "a", NOW),
      txn(mine.id, -10, "b", NOW),
      txn(mine.id, -999, "old", new Date("2026-11-24T00:00:00Z")),
      txn(mine.id, -500, "csv", NOW, "csv"),
      txn(hers.id, -300, "c", NOW),
    ]);
    await db.insert(calendarGoogleEvents).values([
      { calendarKey: "family", googleEventId: "e1", title: "Dentist", startsAt: new Date("2026-11-28T15:00:00Z"), endsAt: new Date("2026-11-28T16:00:00Z"), googleUpdatedAt: NOW },
      { calendarKey: "family", googleEventId: "e2", title: "Old plan", startsAt: new Date("2026-11-29T15:00:00Z"), googleUpdatedAt: new Date("2026-11-01T00:00:00Z") },
      { calendarKey: "us-holidays", googleEventId: "h", title: "Holiday", allDay: true, startDate: "2026-11-27", googleUpdatedAt: NOW },
    ]);
    const kid = await family.addKid({ name: "Kid", emoji: "🦊" });
    const chore = await family.addChore({ kidId: kid, title: "Bed", recurrence: "daily", stars: 2 }, NOW);
    await family.completeChore(chore, NOW);
    const r = await family.addReturn({ itemName: "Shoes", store: "Store" });
    await family.setReturnStatus(r, "returned", NOW);
    await maintenance.addHouseTodo({ title: "Caulk the counter", assignee: "Pavel", today: TODAY });

    const items = await whatsNew("user1", since, { now: NOW, today: TODAY, sinceDay: "2026-11-25" });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.money).toMatchObject({ title: "2 new transactions synced", detail: "$50 spent" });
    expect(by.calendar.title).toBe("1 event added or changed");
    expect(by.calendar.detail).toContain("Dentist");
    expect(by[`kid:${kid}`]).toMatchObject({ title: "Kid", detail: "1 chore done · 2 ⭐" });
    expect(by.returns.detail).toBe("1 added · 1 returned");
    expect(by.todos.detail).toContain("Caulk the counter (Pavel)");
    expect(JSON.stringify(items)).not.toMatch(/Her Card|His Card|300/);

    const hersItems = await whatsNew("user2", since, { now: NOW, today: TODAY, sinceDay: "2026-11-25" });
    expect(hersItems.find((i) => i.key === "money")).toMatchObject({ title: "1 new transaction synced", detail: "$300 spent" });
  });

  it("joins titles in plain words", () => {
    expect(listWords(["A"])).toBe("A");
    expect(listWords(["A", "B"])).toBe("A and B");
    expect(listWords(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });
});
