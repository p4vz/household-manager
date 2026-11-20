"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import {
  ACCOUNT_KINDS,
  OWNERS,
  acceptAllSuggestions,
  categorizeUncategorized,
  commitCsvImport,
  connectSimplefin,
  drillDownTransactions,
  previewCsvImport,
  removeBudget,
  saveBudgetOptions,
  setBudget,
  setMerchantCategory,
  updateAccount,
} from "@/modules/finance/api";

const MAX_CSV_CHARS = 14 * 1024 * 1024;

const connect = authedAction(z.object({ token: z.string().min(20).max(2000) }), ({ token }) =>
  connectSimplefin(token),
);

export async function connectSimplefinAction(_prev: unknown, form: FormData) {
  try {
    const result = await connect({ token: form.get("token") });
    revalidatePath("/finance");
    return { ok: true as const, result };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not connect" };
  }
}

const AccountInput = z.object({
  id: z.uuid(),
  displayName: z.string().max(80).nullable(),
  owner: z.enum(OWNERS),
  kind: z.enum(ACCOUNT_KINDS),
  active: z.boolean(),
});

const saveAccount = authedAction(AccountInput, ({ id, ...patch }) => updateAccount(id, patch));

export async function updateAccountAction(form: FormData) {
  await saveAccount({
    id: form.get("id"),
    displayName: (form.get("displayName") as string | null) || null,
    owner: form.get("owner"),
    kind: form.get("kind"),
    active: form.get("active") === "on",
  });
  revalidatePath("/finance/accounts");
}

export const previewCsvAction = authedAction(z.object({ text: z.string().max(MAX_CSV_CHARS) }), async ({ text }) => {
  try {
    return { ok: true as const, preview: await previewCsvImport(text) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not read the file" };
  }
});

export const commitCsvAction = authedAction(
  z.object({
    text: z.string().max(MAX_CSV_CHARS),
    mapping: z.record(z.string(), z.union([z.uuid(), z.literal("new"), z.literal("skip")])),
  }),
  async ({ text, mapping }) => {
    const result = await commitCsvImport(text, mapping);
    revalidatePath("/finance");
    return result;
  },
);

// ---------- insights ----------

export const drillDownAction = authedAction(
  z.object({
    range: z.enum(["3M", "6M", "12M", "YTD"]),
    owner: z.enum(["all", "user1", "user2", "joint"]),
    accountIds: z.array(z.uuid()).max(50).nullable(),
    category: z.string().max(100).optional(),
    subcategory: z.string().max(100).nullable().optional(),
    merchant: z.string().max(200).optional(),
  }),
  (q) => drillDownTransactions(q),
);

// ---------- budgets ----------

const CategoryLimit = z.object({ category: z.string().min(1).max(100), limit: z.coerce.number().min(0).max(1_000_000) });

const accept = authedAction(CategoryLimit, ({ category, limit }) => setBudget(category, limit, "auto"));
const override = authedAction(CategoryLimit, ({ category, limit }) => setBudget(category, limit, "manual"));
const remove = authedAction(z.object({ category: z.string().min(1).max(100) }), ({ category }) => removeBudget(category));
const acceptAll = authedAction(z.object({}), () => acceptAllSuggestions());
const options = authedAction(
  z.object({ basis: z.union([z.literal(3), z.literal(6)]), excludeOutliers: z.boolean() }),
  (o) => saveBudgetOptions(o),
);

export async function acceptBudgetAction(form: FormData) {
  await accept({ category: form.get("category"), limit: form.get("limit") });
  revalidatePath("/finance/budget");
}
export async function overrideBudgetAction(form: FormData) {
  if (!form.get("limit")) return;
  await override({ category: form.get("category"), limit: form.get("limit") });
  revalidatePath("/finance/budget");
}
export async function removeBudgetAction(form: FormData) {
  await remove({ category: form.get("category") });
  revalidatePath("/finance/budget");
}
export async function acceptAllBudgetsAction() {
  await acceptAll({});
  revalidatePath("/finance/budget");
}
export async function budgetOptionsAction(form: FormData) {
  await options({ basis: Number(form.get("basis")), excludeOutliers: form.get("excludeOutliers") === "on" });
  revalidatePath("/finance/budget");
}

// ---------- categories ----------

const categorize = authedAction(z.object({}), () => categorizeUncategorized());
export async function categorizeWithAiAction() {
  await categorize({});
  revalidatePath("/finance/transactions");
}

const merchantCategory = authedAction(
  z.object({ merchant: z.string().min(1).max(200), category: z.string().min(1).max(100), subcategory: z.string().max(100).nullable() }),
  ({ merchant, category, subcategory }) => setMerchantCategory(merchant, category, subcategory),
);
export async function setMerchantCategoryAction(form: FormData) {
  await merchantCategory({
    merchant: form.get("merchant"),
    category: form.get("category"),
    subcategory: (form.get("subcategory") as string | null) || null,
  });
  revalidatePath("/finance/transactions");
}
