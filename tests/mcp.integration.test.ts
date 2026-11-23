import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccounts } from "@/core/db/schema";
import { freshDb } from "./helpers/db";

vi.mock("@/core/net/outbound", () => ({ outboundFetch: async () => new Response("{}", { status: 404 }) }));

const finance = await import("@/modules/finance/api");
const trips = await import("@/modules/trips/api");
const { registerModules } = await import("@/modules/registry");
const register = await import("@/app/api/oauth/register/route");
const token = await import("@/app/api/oauth/token/route");
const revoke = await import("@/app/api/oauth/revoke/route");
const mcp = await import("@/app/api/mcp/route");
const prm = await import("@/app/.well-known/oauth-protected-resource/[[...path]]/route");
const oauth = await import("@/core/oauth/server");
const { resetRateLimits } = await import("@/core/net/rate-limit");
const { resetSeedFlagForTests } = await import("@/modules/finance/rewards/catalog/store");

const ORIGIN = "https://home.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(50);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeEach(async () => {
  await freshDb();
  resetSeedFlagForTests();
  registerModules();
  resetRateLimits();
  vi.stubEnv("MCP_ENABLED", "true");
  vi.stubEnv("AUTH_URL", ORIGIN);
  vi.stubEnv("ALLOWED_EMAILS", "one@example.com,two@example.com");
  vi.stubEnv("HOUSEHOLD_LEGAL_NAMES", "Pat Example");
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", body, headers });

async function connect(email = "one@example.com") {
  const reg = await register.POST(post("/api/oauth/register", JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] })));
  expect(reg.status).toBe(201);
  const { client_id } = await reg.json();
  const code = await oauth.createAuthorizationCode(
    { clientId: client_id, redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "household:read", resource: `${ORIGIN}/api/mcp` },
    email,
  );
  const form = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT, resource: `${ORIGIN}/api/mcp` });
  const res = await token.POST(post("/api/oauth/token", form.toString(), { "content-type": "application/x-www-form-urlencoded" }));
  expect(res.status).toBe(200);
  return { clientId: client_id as string, code, tokens: (await res.json()) as { access_token: string; refresh_token: string } };
}

let rpcId = 0;
async function rpc(accessToken: string | null, method: string, params: unknown = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return mcp.POST(post("/api/mcp", JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), headers));
}

async function callTool(accessToken: string, name: string, args: unknown = {}) {
  const res = await rpc(accessToken, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.isError, JSON.stringify(body)).toBeFalsy();
  return JSON.parse(body.result.content[0].text);
}

describe("assistant access", () => {
  it("answers 404 everywhere when not enabled", async () => {
    vi.stubEnv("MCP_ENABLED", "");
    expect((await rpc("x", "tools/list")).status).toBe(404);
    expect((await prm.GET()).status).toBe(404);
  });

  it("challenges an unauthenticated call with the resource metadata", async () => {
    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(await (await prm.GET()).json()).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] });
  });

  it("registers Gemini with all six callbacks and returns its long state unchanged", async () => {
    const uris = ["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"].flatMap((h) =>
      ["r", "a"].map((p) => `https://${h}.googleusercontent.com/${p}/user_bound_custom-mcp-1`),
    );
    const reg = await register.POST(post("/api/oauth/register", JSON.stringify({ client_name: "Gemini", redirect_uris: uris })));
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const state = `${"AbC-_.~+/=%20&?#".repeat(90)}`; // ~1,440 chars with characters that need encoding
    const { checkAuthorizeRequest, clientRedirect } = await import("@/core/oauth/authorize");
    const config = { issuer: ORIGIN, resource: `${ORIGIN}/api/mcp` };
    const check = await checkAuthorizeRequest(
      { response_type: "code", client_id, redirect_uri: uris[0], code_challenge: CHALLENGE, code_challenge_method: "S256", state },
      config,
    );
    expect(check.kind).toBe("ok");
    if (check.kind !== "ok") return;
    expect(check.request.state).toBe(state);
    const back = new URL(clientRedirect(check.request.redirectUri, { code: "c", state: check.request.state }, config));
    expect(back.origin + back.pathname).toBe(uris[0]);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("refuses registration for redirect hosts that are not allowed", async () => {
    const res = await register.POST(post("/api/oauth/register", JSON.stringify({ redirect_uris: ["https://evil.example/cb"] })));
    expect(res.status).toBe(400);
  });

  it("runs the full flow and lists read-only tools", async () => {
    const { tokens } = await connect();
    expect(tokens.access_token).toMatch(/^hm_at_/);
    const init = await rpc(tokens.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect((await init.json()).result.instructions).toContain("User 1");
    const list = await (await rpc(tokens.access_token, "tools/list")).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_my_cards", "best_card_for_purchases", "points_left_on_the_table", "trip_card_plan"]));
    for (const t of list.result.tools) expect(t.annotations.readOnlyHint, t.name).toBe(true);
  });

  it("rejects code replay, wrong PKCE and wrong client, and revokes on replay", async () => {
    const { clientId, code, tokens } = await connect();
    const again = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId });
    expect((await token.POST(post("/api/oauth/token", again.toString()))).status).toBe(400);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);

    const code2 = await oauth.createAuthorizationCode(
      { clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "household:read", resource: `${ORIGIN}/api/mcp` },
      "one@example.com",
    );
    const badPkce = new URLSearchParams({ grant_type: "authorization_code", code: code2, code_verifier: "w".repeat(50), client_id: clientId, redirect_uri: REDIRECT });
    expect((await token.POST(post("/api/oauth/token", badPkce.toString()))).status).toBe(400);
  });

  it("requires the redirect_uri on code exchange", async () => {
    const { clientId } = await connect();
    const code = await oauth.createAuthorizationCode(
      { clientId, redirectUri: REDIRECT, codeChallenge: CHALLENGE, scope: "household:read", resource: `${ORIGIN}/api/mcp` },
      "one@example.com",
    );
    const noRedirect = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, resource: `${ORIGIN}/api/mcp` });
    const res = await token.POST(post("/api/oauth/token", noRedirect.toString()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("refreshes, keeps the refresh token, and revokes", async () => {
    const { clientId, tokens } = await connect();
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
    const res = await token.POST(post("/api/oauth/token", form.toString()));
    const next = await res.json();
    expect(next.refresh_token).toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(next.access_token, "tools/list")).status).toBe(200);

    await revoke.POST(post("/api/oauth/revoke", new URLSearchParams({ token: tokens.refresh_token }).toString()));
    expect((await rpc(next.access_token, "tools/list")).status).toBe(401);
    expect((await token.POST(post("/api/oauth/token", form.toString()))).status).toBe(400);
  });

  it("requires the right client_id on refresh and ends a grant 90 days after approval", async () => {
    const { clientId, tokens } = await connect();
    const noClient = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect((await token.POST(post("/api/oauth/token", noClient.toString()))).status).toBe(400);
    await expect(oauth.refreshAccess({ refreshToken: tokens.refresh_token, clientId: "someone-else" })).rejects.toThrow(/another client/);

    const day = 24 * 60 * 60 * 1000;
    let now = Date.now();
    // Refreshing every 20 days would slide the 30-day expiry forever; the grant still ends at 90 days.
    for (let i = 0; i < 4; i++) {
      now += 20 * day;
      await oauth.refreshAccess({ refreshToken: tokens.refresh_token, clientId }, new Date(now));
    }
    await expect(oauth.refreshAccess({ refreshToken: tokens.refresh_token, clientId }, new Date(Date.now() + 91 * day))).rejects.toThrow(/not valid/);
  });

  it("cuts off a member removed from the allowlist", async () => {
    const { tokens } = await connect("two@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "one@example.com");
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("refuses a browser origin other than the app", async () => {
    const { tokens } = await connect();
    const res = await mcp.POST(
      post("/api/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("assistant tools", () => {
  beforeEach(async () => {
    const db = (await import("@/core/db/client")).db();
    const [gold, venture] = await db
      .insert(financeAccounts)
      .values([
        { bankName: "AMEX GOLD 41007", displayName: "Gold ****1007", owner: "user1", kind: "credit" },
        { bankName: "Venture", displayName: "Pat Example Venture", owner: "user2", kind: "credit" },
      ])
      .returning();
    await finance.saveCardProfile(gold.id, { rewardType: "points", baseRate: 1, centsPerUnit: 1.5, annualFee: 325, annualFeeMonth: 3 });
    await finance.addCardRule(gold.id, { matchType: "subcategory", match: "Restaurants", rate: 4, capAmount: null, capPeriod: null, validFrom: null, validTo: null, label: "Dining" });
    await finance.saveCardProfile(venture.id, {
      rewardType: "points", baseRate: 2, centsPerUnit: 1, annualFee: 95, annualFeeMonth: null,
      signupBonus: 75_000, signupMinSpend: 4000, signupStart: "2026-10-20", signupDeadline: "2027-01-15",
    });
  });

  it("lists cards with owner labels and no numbers or names", async () => {
    const { tokens } = await connect();
    const cards = await callTool(tokens.access_token, "list_my_cards");
    const text = JSON.stringify(cards);
    expect(text).not.toMatch(/1007|Pat|Example/);
    expect(cards.map((c: { owner: string }) => c.owner).sort()).toEqual(["User 1", "User 2"]);
    expect(cards.find((c: { owner: string }) => c.owner === "User 2").signupBonus).toMatchObject({ minSpend: 4000, remaining: 4000 });
  });

  it("routes a big booking to the open sign-up bonus and dinner to the dining card", async () => {
    const { tokens } = await connect();
    const out = await callTool(tokens.access_token, "best_card_for_purchases", {
      purchases: [
        { description: "Hotel Rome", amount: 4200, kind: "hotels", merchant: "Marriott" },
        { description: "Dinner", amount: 120, kind: "dining" },
      ],
    });
    expect(out.purchases[0].reason).toBe("completes an open sign-up bonus");
    expect(out.purchases[1].useCard).toMatch(/^Gold/);
    expect(out.purchases[1].rewardValue).toBeCloseTo(7.2);
    expect(JSON.stringify(out)).not.toMatch(/1007|Pat/);
  });

  it("looks up trips by slug", async () => {
    const { slug } = await trips.createTrip({ name: "Thanksgiving 2027", startDate: "2027-11-20", endDate: "2027-11-30", places: ["Zurich"], budget: null });
    const { tokens } = await connect();
    const list = await callTool(tokens.access_token, "list_trips");
    expect(list[0]).toMatchObject({ trip: slug, name: "Thanksgiving 2027" });
    const trip = await callTool(tokens.access_token, "get_trip", { trip: slug });
    expect(trip.startDate).toBe("2027-11-20");
  });

  it("runs the audit and catalog tools", async () => {
    const { tokens } = await connect();
    expect(await callTool(tokens.access_token, "points_left_on_the_table", { range: "3M" })).toMatchObject({ totalMissed: 0 });
    const terms = await callTool(tokens.access_token, "lookup_card_terms", { query: "sapphire" });
    expect(Array.isArray(terms) ? terms.length : 0).toBeGreaterThan(0);
    expect(Array.isArray(await callTool(tokens.access_token, "cards_worth_getting"))).toBe(true);
  });
});
