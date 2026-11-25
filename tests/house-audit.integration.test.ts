import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/core/db/client";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

const runStructured = vi.fn();
vi.mock("@/core/ai/run", () => ({ runStructured: (...a: unknown[]) => runStructured(...a), runWebResearch: vi.fn() }));
const outbound = vi.fn();
vi.mock("@/core/net/outbound", () => ({ outboundFetch: (...a: unknown[]) => outbound(...a) }));

const finance = await import("@/modules/finance/api");
const maintenance = await import("@/modules/maintenance/api");
const { toHits, recallQuery } = await import("@/modules/maintenance/recalls");
const { registerModules } = await import("@/modules/registry");
const audit = await import("@/assistant/house-audit");
const { answerTransaction } = await import("@/assistant/review");
const { TOOLS, runTool } = await import("@/assistant/tools");
const { DraftBook } = await import("@/assistant/changesets");
const { RefBook } = await import("@/assistant/conversations");

const NOW = new Date("2026-11-25T17:00:00Z");
const PAVEL = { email: "one@example.com", owner: "User 1" as const };

let db: Db;
let joint: string, hers: string;
const ids: Record<string, string> = {};
let n = 0;

beforeEach(async () => {
  db = await freshDb();
  registerModules();
  runStructured.mockReset();
  outbound.mockReset();
  vi.stubEnv("HOUSEHOLD_TIMEZONE", "America/New_York");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
  const [a, b] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Joint Checking", owner: "joint", kind: "checking", simplefinId: "A1" },
      { bankName: "Her Card", owner: "user2", kind: "credit" },
    ])
    .returning();
  [joint, hers] = [a.id, b.id];
  const rows = [
    ["peco", joint, "2025-02-03", -3966.74, "PECO Energy", "Bills & Utilities", "Natural Gas"],
    ["tree", joint, "2026-10-14", -8500, "Green Tree Service", null, null],
    ["atm", joint, "2026-11-10", -200, "ATM Withdrawal", null, null],
    ["depot", joint, "2026-11-12", -143.2, "The Home Depot", "Shopping", "General Merchandise"],
    ["mystery", joint, "2026-11-15", -64, "SQ *JMK SERVICES", null, null],
    ["food", joint, "2026-11-16", -88, "Whole Foods", "Food & Dining", "Groceries"],
    ["hers", hers, "2026-11-17", -300, "Lowe's", null, null],
  ] as const;
  const inserted = await db
    .insert(financeTransactions)
    .values(
      rows.map(([, accountId, postedDate, amount, merchant, category, subcategory]) => ({
        accountId,
        source: "csv" as const,
        externalId: `x${n++}`,
        postedDate,
        amount,
        merchant,
        description: merchant,
        category,
        subcategory,
      })),
    )
    .returning({ id: financeTransactions.id });
  rows.forEach(([k], i) => (ids[k] = inserted[i].id));
});

describe("house audit", () => {
  it("matches the house history to payments and has Claude flag new house spending", async () => {
    runStructured.mockImplementation(async (opts: { payload: { transactions: { id: number; merchant: string }[] } }) => {
      const sent = JSON.stringify(opts.payload);
      // Only date, merchant, amount and category; never Raisa's account, cash or account names.
      expect(sent).not.toMatch(/Lowe|ATM|Joint Checking|Her Card/);
      return {
        items: opts.payload.transactions.map((t) => ({
          id: t.id,
          houseRelated: /depot|jmk/i.test(t.merchant),
          title: /depot/i.test(t.merchant) ? "Hardware" : "Handyman",
          area: null,
          confidence: "medium",
        })),
      };
    });
    const r = await audit.runHouseAudit("user1", NOW);
    expect(r.matched).toBe(2); // PECO by amount and vendor; tree removal by amount in October
    const projects = await maintenance.listProjects();
    expect(projects.find((p) => p.title === "PECO gas line relocation")?.transactionId).toBe(ids.peco);
    expect(projects.find((p) => p.title === "Front yard tree removal")?.transactionId).toBe(ids.tree);
    expect(r.cashOpen).toBe(1);
    expect(r.houseLike).toBe(2);
    expect(r.note).toMatch(/Matched 2 house projects/);

    const linked = projects.map((p) => p.transactionId).filter((x): x is string => Boolean(x));
    const q = await finance.houseQuestions("user1", { linkedIds: linked });
    // Groceries aren't questionable; Raisa's purchase isn't Pavel's to audit; matched payments are done.
    expect(q.rows.map((x) => x.merchant).sort()).toEqual(["ATM Withdrawal", "SQ *JMK SERVICES", "The Home Depot"]);
    expect(q.rows.find((x) => x.merchant === "The Home Depot")?.suggestion).toMatchObject({ houseRelated: true, title: "Hardware" });
    expect(q.rows.find((x) => x.kind === "cash")?.merchant).toBe("ATM Withdrawal");

    // Weekly: not due again right away, due a week later.
    expect(await audit.runHouseAuditIfDue(new Date(NOW.getTime() + 86_400_000))).not.toContain("user1");
    expect(await audit.runHouseAuditIfDue(new Date(NOW.getTime() + 8 * 86_400_000))).toContain("user1");
  });

  it("still matches projects when Claude is unavailable", async () => {
    runStructured.mockRejectedValue(new Error("No AI provider configured"));
    const r = await audit.runHouseAudit("user1", NOW);
    expect(r.matched).toBe(2);
    expect(r.note).toMatch(/couldn't review/);
  });

  it("resolves questions one by one from the tracker", async () => {
    expect(await audit.addTransactionToHouse(PAVEL, ids.depot, "Garage shelving", NOW)).toMatch(/Garage shelving/);
    const added = (await maintenance.listProjects()).find((p) => p.title === "Garage shelving");
    expect(added).toMatchObject({ date: "2026-11-12", vendor: "The Home Depot", amount: 143.2, transactionId: ids.depot });

    const unpaid = (await maintenance.listProjects()).find((p) => p.title === "HVAC & boiler annual service")!;
    await audit.linkTransactionToProject(PAVEL, ids.mystery, unpaid.id);
    expect((await maintenance.getProject(unpaid.id))?.transactionId).toBe(ids.mystery);

    await audit.categorizeQuestion(PAVEL, ids.tree, "Home › Lawn & Garden");
    const [tree] = await db.select().from(financeTransactions).where(eq(financeTransactions.id, ids.tree));
    expect(tree).toMatchObject({ category: "Home", subcategory: "Lawn & Garden" });
    await expect(audit.categorizeQuestion(PAVEL, ids.atm, "Made up")).rejects.toThrow(/Pick a category/);

    // A cash withdrawal explained in words becomes a house project with Claude's help.
    runStructured.mockResolvedValue({
      summary: "Recorded the cash payment for gutter cleaning.",
      note: "Cash for gutter cleaning",
      houseRelated: true,
      project: { title: "Gutter cleaning", description: null },
      equipment: null,
      tasks: [],
    });
    await answerTransaction(PAVEL, ids.atm, "paid the gutter guy in cash", NOW);
    expect((await maintenance.listProjects()).find((p) => p.title === "Gutter cleaning")).toMatchObject({ amount: 200, transactionId: ids.atm });

    const left = await finance.houseQuestions("user1", { linkedIds: (await maintenance.listProjects()).map((p) => p.transactionId!).filter(Boolean) });
    expect(left.rows.map((r) => r.merchant)).toEqual([]);
    await expect(audit.addTransactionToHouse(PAVEL, ids.hers, "Not mine", NOW)).rejects.toThrow(/not available/);
  });
});

describe("maintenance items", () => {
  it("carries parts and area forward and records the last-done date on completion", async () => {
    const item = (await maintenance.listOpenTasks()).find((t) => t.title === "Replace refrigerator water filter")!;
    const { nextTaskId } = await maintenance.completeTask(item.id, { date: "2026-11-25" });
    const next = await maintenance.getTask(nextTaskId!);
    expect(next).toMatchObject({ lastDoneOn: "2026-11-25", dueDate: "2027-05-26", parts: "GE MWF filter (or compatible)", area: "Water filtration" });
    expect(maintenance.everyLabel(182)).toBe("every 6 months");
    expect(maintenance.everyLabel(913)).toBe("every 2½ years");
    expect(maintenance.everyLabel(null)).toBe("one-off");
  });
});

describe("recalls", () => {
  it("sends only a product phrase and keeps the newest hits", async () => {
    expect(recallQuery("GE Garage Ready upright freezer (14.2 cu. ft.) #WH32758219")).toBe("GE Garage Ready upright freezer");
    outbound.mockResolvedValue(
      new Response(
        JSON.stringify([
          { RecallDate: "2019-03-01T00:00:00", Title: "Old recall", URL: "https://www.cpsc.gov/Recalls/2019/x", Hazards: [{ Name: "Fire" }], Remedies: [{ Name: "Repair" }] },
          { RecallDate: "2024-06-01T00:00:00", Title: "New recall", URL: "https://evil.example/x", Hazards: [], Remedies: [] },
        ]),
      ),
    );
    const freezer = (await maintenance.listAssets()).find((a) => a.name.startsWith("GE Garage Ready"))!;
    const hits = await maintenance.checkAssetRecalls(freezer.id, NOW);
    const url = new URL(String(outbound.mock.calls[0][0]));
    expect(url.hostname).toBe("www.saferproducts.gov");
    expect(url.searchParams.get("ProductName")).toBe("GE Garage Ready upright freezer");
    expect(hits.map((h) => h.title)).toEqual(["New recall", "Old recall"]);
    expect(hits[0].url).toBeNull(); // only cpsc.gov links are kept
    expect((await maintenance.getAsset(freezer.id))?.recalls).toHaveLength(2);
    expect(toHits("nope")).toEqual([]);
  });

  it("is available to Ask Claude, with house history and the questionable queue", async () => {
    outbound.mockImplementation(async () => new Response("[]"));
    const env = { ctx: { email: PAVEL.email, owner: PAVEL.owner, viewer: "user1" as const, now: NOW }, refs: new RefBook({}, 1), drafts: new DraftBook() };
    const call = async (name: string, args: unknown) => JSON.parse(await runTool(TOOLS.find((t) => t.name === name)!, args, env));
    const rc = await call("check_recalls", { product: "Sharp microwave" });
    expect(rc).toMatchObject({ recalls: [] });
    const history = await call("house_projects", {});
    expect(history.length).toBe(13);
    expect(JSON.stringify(history)).not.toMatch(/transactionId|[0-9a-f]{8}-[0-9a-f]{4}/);
    const queue = await call("questionable_transactions", {});
    expect(queue.open).toBeGreaterThan(0);
    await call("edit_house_project", { action: "create", title: "Water heater replacement", date: "2021-06-01", amount: 1800 });
    expect(env.drafts.size).toBe(1);
  });
});
