import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";

const family = await import("@/modules/family/api");

const at = (day: string) => new Date(`${day}T17:00:00Z`);
let kidId = "";

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  await freshDb();
  kidId = await family.addKid({ name: "Mia" });
});

describe("reading log", () => {
  it("logs reading, counts days by language and adds milestone stars to the star bank", async () => {
    for (let d = 1; d <= 4; d++) await family.addReading({ kidId, book: "Matilda", language: "en", minutes: 20 }, at(`2026-11-0${d}`));
    // Day 5: Russian, two short sessions that add up to 15 minutes.
    await family.addReading({ kidId, book: "Чук и Гек", language: "ru", minutes: 7 }, at("2026-11-05"));
    let bank = (await family.starBanks(at("2026-11-05"))).get(kidId)!;
    expect(bank.saved).toBe(0);
    const second = await family.addReading({ kidId, book: "Чук и Гек", language: "ru", minutes: 8, pages: 6 }, at("2026-11-05"));
    bank = (await family.starBanks(at("2026-11-05"))).get(kidId)!;
    expect(bank).toMatchObject({ saved: 10, lifetime: 10 });

    const r = (await family.readingSummaries(at("2026-11-05"))).get(kidId)!;
    expect(r.stats).toMatchObject({ streak: 5, totalDays: 5, todayShare: 1 });
    expect(r.today).toHaveLength(2);
    expect(r.books.map((b) => b.book)).toEqual(["Чук и Гек", "Matilda"]);

    // Taking the entry back takes the milestone back.
    await family.deleteReading(second);
    expect((await family.starBanks(at("2026-11-05"))).get(kidId)!.saved).toBe(0);
  });

  it("refuses future dates, old dates, missing books and silly minutes", async () => {
    const now = at("2026-11-10");
    await expect(family.addReading({ kidId, day: "2026-11-11", book: "x", language: "en", minutes: 20 }, now)).rejects.toThrow(/hasn't happened/);
    await expect(family.addReading({ kidId, day: "2026-10-01", book: "x", language: "en", minutes: 20 }, now)).rejects.toThrow(/last 14 days/);
    await expect(family.addReading({ kidId, book: " ", language: "en", minutes: 20 }, now)).rejects.toThrow(/Which book/);
    await expect(family.addReading({ kidId, book: "x", language: "en", minutes: 0 }, now)).rejects.toThrow(/minutes/);
  });

  it("lets the kitchen screen remove only today's entries", async () => {
    const old = await family.addReading({ kidId, day: "2026-11-08", book: "Matilda", language: "en", minutes: 20 }, at("2026-11-10"));
    await expect(family.deleteReading(old, { onlyToday: true, now: at("2026-11-10") })).rejects.toThrow(/Only today's/);
    const today = await family.addReading({ kidId, book: "Matilda", language: "en", minutes: 20 }, at("2026-11-10"));
    await family.deleteReading(today, { onlyToday: true, now: at("2026-11-10") });
    expect(await family.getReading(today)).toBeNull();
  });
});
