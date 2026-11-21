import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts, financeTransactions } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const finance = await import("@/modules/finance/api");
const trips = await import("@/modules/trips/api");
const { registerModules } = await import("@/modules/registry");
const register = await import("@/app/api/oauth/register/route");
const token = await import("@/app/api/oauth/token/route");
const mcp = await import("@/app/api/mcp/route");
const oauth = await import("@/core/oauth/server");
const { DEFAULT_PERMISSIONS, PERMISSION_KEYS, normalizePermissions, grantPermissions } = await import("@/core/oauth/permissions");
const { TOOLS } = await import("@/mcp/tools");
const { resetRateLimits } = await import("@/core/net/rate-limit");
const { resetSeedFlagForTests } = await import("@/modules/finance/rewards/catalog/store");

const ORIGIN = "https://home.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", body, headers });

beforeEach(async () => {
  const db = await freshDb();
  resetSeedFlagForTests();
  registerModules();
  resetRateLimits();
  vi.stubEnv("MCP_ENABLED", "true");
  vi.stubEnv("AUTH_URL", ORIGIN);
  vi.stubEnv("ALLOWED_EMAILS", "one@example.com,two@example.com");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
  const [card, checking] = await db
    .insert(financeAccounts)
    .values([
      { bankName: "Gold", displayName: "Gold", owner: "user1", kind: "credit", balance: -420 },
      { bankName: "CHK 123456789", displayName: null, owner: "joint", kind: "checking", balance: 5300 },
    ])
    .returning();
  await finance.saveCardProfile(card.id, { rewardType: "points", baseRate: 1, centsPerUnit: 1.5, annualFee: 325, annualFeeMonth: 3 });
  await db.insert(financeTransactions).values([
    { accountId: card.id, source: "csv", externalId: "a", postedDate: "2026-11-02", amount: -80, description: "x", merchant: "Trattoria", category: "Food & Dining", subcategory: "Restaurants" },
    { accountId: checking.id, source: "csv", externalId: "b", postedDate: "2026-11-01", amount: 4000, description: "x", merchant: "Payroll", category: "Income" },
    { accountId: checking.id, source: "csv", externalId: "c", postedDate: "2026-11-03", amount: -60, description: "x", merchant: "Shell ref K7Q2XZ9 for pat@example.com", category: "Auto & Transport", subcategory: "Gas & Fuel" },
  ]);
  await trips.addTraveler({ name: "Mila", kind: "child", birthdate: "2018-05-01", owner: null });
});

async function connect(permissions?: string[]) {
  const reg = await register.POST(post("/api/oauth/register", JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] })));
  const { client_id } = await reg.json();
  const code = await oauth.createAuthorizationCode(
    { clientId: client_id, redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "household:read", resource: `${ORIGIN}/api/mcp`, permissions },
    "one@example.com",
  );
  const form = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT });
  return (await (await token.POST(post("/api/oauth/token", form.toString()))).json()).access_token as string;
}

let id = 0;
async function rpc(access: string, method: string, params: unknown = {}) {
  const res = await mcp.POST(
    post("/api/mcp", JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {
      authorization: `Bearer ${access}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }),
  );
  return res.json();
}
const toolNames = async (access: string) => (await rpc(access, "tools/list")).result.tools.map((t: { name: string }) => t.name).sort();
async function call(access: string, name: string, args: unknown = {}) {
  const body = await rpc(access, "tools/call", { name, arguments: args });
  return { body, data: body.result && !body.result.isError ? JSON.parse(body.result.content[0].text) : null };
}

describe("permission catalog", () => {
  it("every tool requires known permissions, and defaults leave money details off", () => {
    for (const t of TOOLS) {
      expect(t.requires.length, t.name).toBeGreaterThan(0);
      for (const p of t.requires) expect(PERMISSION_KEYS, `${t.name}: ${p}`).toContain(p);
    }
    for (const sensitive of ["finance.transactions", "finance.income", "finance.assets", "finance.spending", "finance.crypto"]) {
      expect(DEFAULT_PERMISSIONS).not.toContain(sensitive);
    }
  });

  it("drops unknown and unavailable keys; old grants get the defaults", () => {
    expect(normalizePermissions(["finance.cards", "admin", "finance.crypto", 3, "finance.cards"])).toEqual(["finance.cards"]);
    expect(grantPermissions(null)).toEqual(DEFAULT_PERMISSIONS);
  });
});

describe("per-assistant permissions", () => {
  it("advertises only the tools that were granted and refuses the rest", async () => {
    const access = await connect(["travel.trips"]);
    expect(await toolNames(access)).toEqual(["list_trips"]);
    const { body } = await call(access, "list_my_cards");
    expect(JSON.stringify(body)).toMatch(/not found|error/i);
  });

  it("applies a Settings change on the next call", async () => {
    const access = await connect(["travel.trips"]);
    const [conn] = await oauth.listConnections();
    await oauth.setConnectionPermissions(conn.id, ["finance.assets", "home.tasks", "bogus"]);
    expect(await toolNames(access)).toEqual(["account_balances", "house_upkeep_tasks"]);
    expect((await oauth.listConnections())[0].permissions).toEqual(["finance.assets", "home.tasks"]);
  });

  it("hides sign-up progress and single purchases without their own permission", async () => {
    const access = await connect(["finance.cards", "finance.rewards_audit"]);
    const cards = await call(access, "list_my_cards");
    expect(cards.data[0].signupBonus).toBeNull();
    const audit = await call(access, "points_left_on_the_table", { range: "3M" });
    expect(audit.data.biggestMisses).toBeUndefined();
  });

  it("never returns account numbers, codes, emails or names, even with every permission", async () => {
    const access = await connect([...PERMISSION_KEYS]);
    const tx = await call(access, "list_transactions");
    const balances = await call(access, "account_balances");
    const all = JSON.stringify([tx.data, balances.data]);
    expect(all).not.toMatch(/123456789|K7Q2XZ9|pat@example\.com|Pat|Mila/);
    expect(balances.data.map((b: { account: string }) => b.account).sort()).toEqual(["Gold", "checking account"]);
    const income = await call(access, "income_and_savings", { range: "3M" });
    expect(income.data.totals.income).toBe(4000);
    const spend = await call(access, "spending_summary", { range: "3M" });
    expect(spend.data.byCategory.map((c: { category: string }) => c.category)).toContain("Food & Dining");
  });

  it("states the rule in the server instructions", async () => {
    const access = await connect(["travel.trips"]);
    const init = await rpc(access, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.instructions).toMatch(/Never share account numbers/);
    expect(init.result.instructions).toMatch(/never stored in memory/);
    expect(init.result.instructions).toMatch(/not shared it with you/);
  });
});
