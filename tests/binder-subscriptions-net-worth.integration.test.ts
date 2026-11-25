import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccounts, financeBalanceSnapshots, financeTransactions, maintenanceDocuments, maintenanceTasks } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const finance = await import("@/modules/finance/api");
const maintenance = await import("@/modules/maintenance/api");
const { registerModules } = await import("@/modules/registry");
const { applyAccountSet } = await import("@/modules/finance/ingest/sync");

let db: Db;
let n = 0;

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("DOC_VAULT_KEY", Buffer.alloc(32, 7).toString("base64"));
});

describe("home binder", () => {
  it("encrypts the file, keeps a reminder in step with the date, and cleans up", async () => {
    const furnace = await maintenance.addAsset({ name: "Furnace", kind: "hvac" });
    const pdf = Buffer.from("%PDF-1.4 warranty terms");
    const { id, href } = await maintenance.addBinderDocument({
      title: "Furnace warranty",
      category: "warranty",
      bytes: pdf,
      mediaType: "application/pdf",
      fileName: "C:\\scans\\furnace.pdf",
      expiresOn: "2027-03-01",
      assetId: furnace,
      addedBy: "user1",
    });
    expect(href).toBe(`/maintenance/binder#doc-${id}`);

    const [raw] = await db.select().from(maintenanceDocuments).where(eq(maintenanceDocuments.id, id));
    expect(raw.cipherText!.includes(pdf)).toBe(false);
    expect(raw.fileName).toBe("furnace.pdf");
    const opened = await maintenance.openBinderFile(id);
    expect(Buffer.from(opened.base64, "base64").equals(pdf)).toBe(true);

    const [task] = await db.select().from(maintenanceTasks).where(eq(maintenanceTasks.id, raw.reminderTaskId!));
    expect(task).toMatchObject({ title: "Warranty ends soon: Furnace warranty", dueDate: "2027-01-30", area: "Home binder", assetId: furnace });

    // Moving the date replaces the reminder; clearing it removes it.
    await maintenance.updateBinderEntry(id, { expiresOn: "2027-06-01" }, null, "2026-11-25");
    const moved = await maintenance.getBinderEntry(id);
    expect((await maintenance.getTask(moved!.reminderTaskId!))?.dueDate).toBe("2027-05-02");
    expect(await maintenance.getTask(raw.reminderTaskId!)).toBeNull();
    await maintenance.updateBinderEntry(id, { expiresOn: null }, null, "2026-11-25");
    expect((await maintenance.getBinderEntry(id))?.reminderTaskId).toBeNull();
    expect((await maintenance.listOpenTasks()).filter((t) => t.area === "Home binder")).toHaveLength(0);

    // Removing the furnace keeps the document, unlinked.
    await maintenance.deleteAsset(furnace);
    expect((await maintenance.getBinderEntry(id))?.assetId).toBeNull();
    await maintenance.deleteBinderEntry(id);
    expect(await maintenance.listBinder()).toHaveLength(0);
  });

  it("puts a tax reminder 14 days out, today if closer, and none for manuals or past dates", async () => {
    expect(maintenance.reminderDueDate("property_tax", "2026-12-31", "2026-11-25")).toBe("2026-12-17");
    expect(maintenance.reminderDueDate("insurance", "2026-12-01", "2026-11-25")).toBe("2026-11-25");
    expect(maintenance.reminderDueDate("manual", "2027-12-01", "2026-11-25")).toBeNull();
    expect(maintenance.reminderDueDate("warranty", "2026-11-01", "2026-11-25")).toBeNull();
    const id = await maintenance.addBinderEntry({ category: "manual", title: "Dishwasher manual", url: "https://example.com/manual" }, null, "user2", "2026-11-25");
    expect((await maintenance.getBinderEntry(id))).toMatchObject({ hasFile: false, reminderTaskId: null });
  });

  it("refuses files without a vault key and over 8 MB", async () => {
    await expect(
      maintenance.addBinderDocument({ title: "Big", category: "other", bytes: Buffer.alloc(9 * 1024 * 1024), mediaType: "application/pdf", fileName: "big.pdf", addedBy: "user1" }),
    ).rejects.toThrow(/8 MB/);
    vi.stubEnv("DOC_VAULT_KEY", "");
    await expect(
      maintenance.addBinderDocument({ title: "x", category: "other", bytes: Buffer.from("x"), mediaType: "text/plain", fileName: "x.txt", addedBy: "user1" }),
    ).rejects.toThrow(/DOC_VAULT_KEY/);
  });
});

async function account(owner: "joint" | "user1" | "user2", kind: "checking" | "credit", balance: number | null, name: string) {
  const [a] = await db
    .insert(financeAccounts)
    .values({ bankName: name, owner, kind, balance, balanceDate: balance == null ? null : new Date("2026-11-25T15:00:00Z") })
    .returning();
  return a.id;
}

async function charge(accountId: string, postedDate: string, amount: number, merchant: string) {
  await db.insert(financeTransactions).values({ accountId, source: "csv", externalId: `t${n++}`, postedDate, amount, description: merchant, merchant });
}

describe("subscriptions", () => {
  it("detects charges per owner and never shows the other member's", async () => {
    const joint = await account("joint", "credit", -100, "Joint card");
    const hers = await account("user2", "credit", -50, "Her card");
    for (const d of ["2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"]) {
      await charge(joint, d, -22.99, "Netflix");
      await charge(hers, d, -10.99, "Audible");
    }
    const pavel = await finance.listSubscriptions("user1", "2026-11-25");
    expect(pavel.rows.map((r) => r.name)).toEqual(["Netflix"]);
    expect(pavel.totals.user2.count).toBe(0);
    const raisa = await finance.listSubscriptions("user2", "2026-11-25");
    expect(raisa.rows.map((r) => r.name).sort()).toEqual(["Audible", "Netflix"]);

    // Pavel can't touch Raisa's rows, even by guessing the merchant.
    await expect(finance.saveDetectedSubscription("user1", { owner: "user2", merchantKey: "audible" }, { name: "x", status: "ignored" })).rejects.toThrow();

    // Confirm, then hide, then cancel.
    await finance.saveDetectedSubscription("user1", { owner: "joint", merchantKey: "netflix" }, { name: "Netflix (family)", status: "active" });
    let rows = (await finance.listSubscriptions("user1", "2026-11-25")).rows;
    expect(rows[0]).toMatchObject({ name: "Netflix (family)", source: "confirmed", nextCharge: "2026-12-03", monthly: 22.99 });
    await finance.updateSubscription("user1", rows[0].id!, { status: "cancelled" });
    rows = (await finance.listSubscriptions("user1", "2026-11-25")).rows;
    expect(rows[0]).toMatchObject({ status: "cancelled", nextCharge: null });

    const manual = await finance.addManualSubscription("user1", { name: "Gym", owner: "user1", amount: 30, cadence: "monthly", nextCharge: "2026-12-01", notes: null });
    expect((await finance.listSubscriptions("user1", "2026-11-25")).totals.user1).toMatchObject({ monthly: 30, yearly: 360, count: 1 });
    expect((await finance.listSubscriptions("user2", "2026-11-25")).rows.some((r) => r.id === manual)).toBe(false);
    await expect(finance.deleteSubscription("user2", manual)).rejects.toThrow();
  });
});

describe("net worth", () => {
  it("shows joint, mine or both, never the other member's, with hand-entered items", async () => {
    const joint = await account("joint", "checking", 5000, "Joint checking");
    await account("user1", "checking", 1000, "Pavel checking");
    await account("user2", "checking", 9000, "Raisa checking");
    await account("joint", "credit", null, "CSV-only card");
    await charge(joint, "2026-11-10", 2000, "Payroll");
    await charge(joint, "2026-09-01", -100, "Something");

    const house = await finance.addNetWorthItem("user1", { owner: "joint", kind: "home", name: "House", acquiredOn: "2019-05-01", closedOn: null, notes: null }, 400000, "2026-11-01");
    await finance.addNetWorthItem("user1", { owner: "joint", kind: "mortgage", name: "Mortgage", acquiredOn: "2019-05-01", closedOn: null, notes: null }, 250000, "2026-11-01");
    await expect(finance.addNetWorthItem("user1", { owner: "user2", kind: "vehicle", name: "x", acquiredOn: null, closedOn: null, notes: null }, 1, "2026-11-01")).rejects.toThrow();
    await expect(finance.setNetWorthValue("user2", house, 1, "2026-11-02")).resolves.toBeUndefined();

    const jointNw = await finance.netWorth("user1", "joint", "2026-11-25");
    expect(jointNw.total).toBe(5000 + 1 - 250000);
    expect(jointNw.missingBalances).toEqual(["CSV-only card"]);
    expect(jointNw.history.find((h) => h.date === "2026-10-31")?.total).toBe(3000 + 400000 - 250000);

    expect((await finance.netWorth("user1", "mine", "2026-11-25")).total).toBe(1000);
    expect((await finance.netWorth("user2", "mine", "2026-11-25")).total).toBe(9000);
    const both = await finance.netWorth("user1", "both", "2026-11-25");
    expect(both.lines.map((l) => l.name)).not.toContain("Raisa checking");
  });

  it("bank sync keeps a daily balance snapshot", async () => {
    await applyAccountSet({
      errors: [],
      accounts: [{ id: "S1", name: "Checking 1234", currency: "USD", balance: 1234.5, "balance-date": Date.parse("2026-11-25T03:00:00Z") / 1000, org: { name: "Bank" }, transactions: [] }],
    } as never);
    const snaps = await db.select().from(financeBalanceSnapshots);
    expect(snaps).toEqual([expect.objectContaining({ date: "2026-11-24", balance: 1234.5 })]);
  });
});
