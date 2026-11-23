import { describe, expect, it, vi } from "vitest";

vi.mock("@/core/auth/guard", () => ({
  requireUser: vi.fn(async () => {
    throw new Error("NOT_SIGNED_IN");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("saveCatalogTermsAction", () => {
  it("refuses a caller without a session before parsing input", async () => {
    const { saveCatalogTermsAction } = await import("@/app/(app)/finance/actions");
    const form = new FormData();
    form.set("terms", "not json");
    form.set("productId", "x");
    await expect(saveCatalogTermsAction({ ok: true, message: "" } as never, form)).rejects.toThrow("NOT_SIGNED_IN");
  });
});
