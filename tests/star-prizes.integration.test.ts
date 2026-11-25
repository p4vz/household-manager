import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";

const family = await import("@/modules/family/api");

const at = (day: string) => new Date(`${day}T17:00:00Z`);
let kidId = "";
let choreId = "";

beforeAll(async () => {
  process.env.HOUSEHOLD_TIMEZONE = "America/New_York";
  await freshDb();
  kidId = await family.addKid({ name: "Mia" });
  choreId = await family.addChore({ kidId, title: "Big job", recurrence: "daily", stars: 5 }, at("2026-11-01"));
});

describe("star prizes", () => {
  it("starts with small, medium and large prizes at 25, 100 and 500", async () => {
    const prizes = await family.listStarPrizes();
    expect(prizes.map((p) => [p.name, p.stars])).toEqual([
      ["Small prize", 25],
      ["Medium prize", 100],
      ["Large prize", 500],
    ]);
  });

  it("spends saved stars when a prize is given, refuses when short, and undo gives them back", async () => {
    for (let d = 1; d <= 6; d++) await family.completeChore(choreId, at(`2026-11-0${d}`));
    const [small, medium] = await family.listStarPrizes();
    let bank = (await family.starBanks()).get(kidId)!;
    expect(bank).toMatchObject({ saved: 30, lifetime: 30 });
    expect(bank.best?.id).toBe(small.id);

    await expect(family.givePrize(kidId, medium.id, "User 1")).rejects.toThrow(/stars/);
    await family.givePrize(kidId, small.id, "User 1");
    bank = (await family.starBanks()).get(kidId)!;
    expect(bank).toMatchObject({ saved: 5, lifetime: 30 });
    await expect(family.givePrize(kidId, small.id, "User 1")).rejects.toThrow(/stars/);

    const [given] = await family.prizeHistory(10);
    expect(given).toMatchObject({ kidId, prizeName: "Small prize", stars: 25 });
    const [p] = await family.kidProgress(at("2026-11-06"));
    expect(p.stars.saved).toBe(5);

    await family.undoPrize(given.id);
    expect((await family.starBanks()).get(kidId)!.saved).toBe(30);
  });

  it("lets parents edit the prize list, within limits", async () => {
    const [small] = await family.listStarPrizes();
    await family.saveStarPrize({ id: small.id, name: "Ice cream", emoji: "🍦", stars: 20 });
    const id = await family.saveStarPrize({ name: "Movie night", stars: 60 });
    expect((await family.listStarPrizes()).map((p) => [p.name, p.stars])).toEqual([
      ["Ice cream", 20],
      ["Movie night", 60],
      ["Medium prize", 100],
      ["Large prize", 500],
    ]);
    await expect(family.saveStarPrize({ name: "x", stars: 0 })).rejects.toThrow();
    await expect(family.saveStarPrize({ name: "x", stars: 1_000_000 })).rejects.toThrow();
    await family.removeStarPrize(id);
    expect(await family.listStarPrizes()).toHaveLength(3);
  });

  it("changes a chore's stars for later ticks only", async () => {
    const read = await family.addChore({ kidId, title: "Read 30 min", recurrence: "daily", stars: 1 }, at("2026-11-07"));
    await family.completeChore(read, at("2026-11-07"));
    await family.setChoreStars(read, 5);
    await family.completeChore(read, at("2026-11-08"));
    const before = (await family.starBanks()).get(kidId)!.lifetime;
    expect(before).toBe(30 + 1 + 5);
    await expect(family.setChoreStars(read, 9)).rejects.toThrow(/1 to 5/);
  });

  it("adds starter chores once", async () => {
    const leo = await family.addKid({ name: "Leo" });
    await family.addStarterChores(leo);
    await family.addStarterChores(leo);
    const board = await family.choreBoard(at("2026-11-06"));
    expect(board.find((k) => k.id === leo)!.chores.map((c) => c.title).sort()).toEqual(["Brush teeth", "Make bed", "Read 20 min", "Tidy room"]);
  });
});
