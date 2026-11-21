import { beforeEach, describe, expect, it, vi } from "vitest";

const saveCatalogTermsByUser = vi.fn();
let signedIn = false;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/core/auth/guard", () => ({
  requireUser: vi.fn(async () => {
    if (!signedIn) throw new Error("Unauthorized");
    return { email: "a@example.com", owner: "User 1" };
  }),
}));
vi.mock("@/modules/finance/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  saveCatalogTermsByUser,
}));

const { saveCatalogTermsAction } = await import("@/app/(app)/finance/actions");

function form(terms: string) {
  const f = new FormData();
  f.set("productId", "chase-sapphire-preferred");
  f.set("terms", terms);
  return f;
}

describe("saveCatalogTermsAction", () => {
  beforeEach(() => {
    signedIn = false;
    saveCatalogTermsByUser.mockReset();
  });

  it("checks the session before it parses or validates input", async () => {
    await expect(saveCatalogTermsAction(null, form("not json"))).rejects.toThrow("Unauthorized");
    await expect(saveCatalogTermsAction(null, form("{}"))).rejects.toThrow("Unauthorized");
    expect(saveCatalogTermsByUser).not.toHaveBeenCalled();
  });

  it("still reports bad JSON to a signed-in member", async () => {
    signedIn = true;
    await expect(saveCatalogTermsAction(null, form("not json"))).resolves.toEqual({ ok: false, error: "Not valid JSON" });
    expect(saveCatalogTermsByUser).not.toHaveBeenCalled();
  });
});
