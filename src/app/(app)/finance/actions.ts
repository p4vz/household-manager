"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { requireUser, type HouseholdUser } from "@/core/auth/guard";
import {
  ACCOUNT_KINDS,
  OWNERS,
  acceptAllSuggestions,
  addCardRule,
  categorizeUncategorized,
  deleteCardRule,
  runAdvisorNow,
  saveCardProfile,
  commitCsvImport,
  drillDownTransactions,
  previewCsvImport,
  removeBudget,
  saveBudgetOptions,
  setBudget,
  setMerchantCategory,
  updateAccount,
  acceptCatalogChange,
  addCatalogProduct,
  applyCatalogTermsToCard,
  keepCardRules,
  linkCardToCatalog,
  markCatalogChangesSeen,
  refreshCatalogCardNow,
  rejectCatalogChange,
  saveCatalogTermsByUser,
  CardTerms,
  viewerFromLabel,
  setAccountImage,
  deleteAccountImage,
  MAX_CARD_IMAGE_BYTES,
  addCardFromPhoto,
  CardPhotoError,
} from "@/modules/finance/api";

/** Finance data is read and changed as the signed-in member (private accounts). */
const as = (user: HouseholdUser) => viewerFromLabel(user.owner);

const MAX_CSV_CHARS = 14 * 1024 * 1024;

const AccountInput = z.object({
  id: z.uuid(),
  displayName: z.string().max(80).nullable(),
  officialName: z.string().max(120).nullable(),
  last4: z.string().regex(/^\d{4}$/, "Last 4 must be four digits").nullable(),
  owner: z.enum(OWNERS),
  kind: z.enum(ACCOUNT_KINDS),
  active: z.boolean(),
});

const saveAccount = authedAction(AccountInput, ({ id, ...patch }, user) => updateAccount(as(user), id, patch));

export async function updateAccountAction(form: FormData) {
  await saveAccount({
    id: form.get("id"),
    displayName: (form.get("displayName") as string | null) || null,
    officialName: (form.get("officialName") as string | null) || null,
    last4: String(form.get("last4") ?? "").trim() || null,
    owner: form.get("owner"),
    kind: form.get("kind"),
    active: form.get("active") === "on",
  });
  revalidatePath("/finance/accounts");
}

// ---------- card pictures ----------

type PictureState = null | { ok: true } | { ok: false; error: string };

const picture = authedAction(
  z.object({
    accountId: z.uuid(),
    file: z.instanceof(File).refine((f) => f.size > 0 && f.size <= MAX_CARD_IMAGE_BYTES, "The picture is too large (600 KB at most)"),
  }),
  async ({ accountId, file }, user) => setAccountImage(as(user), accountId, Buffer.from(await file.arrayBuffer())),
);
export async function uploadCardPictureAction(_prev: PictureState, form: FormData): Promise<PictureState> {
  // Check the session outside the try so a refusal is not turned into a message.
  await requireUser();
  try {
    await picture({ accountId: form.get("accountId"), file: form.get("file") });
    revalidatePath("/finance/accounts");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : err instanceof Error ? err.message : null;
    return { ok: false, error: msg ?? "Could not save the picture" };
  }
}

export type NewCardState =
  | null
  | { ok: true; product: string; confidence: "high" | "medium" | "low"; hasTerms: boolean }
  | { ok: false; error: string };

const newCard = authedAction(
  z.object({
    owner: z.enum(OWNERS),
    nickname: z.string().max(80).nullable(),
    last4: z.string().regex(/^\d{4}$/, "Last 4 must be four digits").nullable(),
    file: z.instanceof(File).refine((f) => f.size > 0 && f.size <= MAX_CARD_IMAGE_BYTES, "The picture is too large (600 KB at most)"),
  }),
  async ({ file, ...rest }, user) => addCardFromPhoto(as(user), { ...rest, image: Buffer.from(await file.arrayBuffer()) }),
);
export async function addCardFromPhotoAction(_prev: NewCardState, form: FormData): Promise<NewCardState> {
  // Check the session outside the try so a refusal is not turned into a message.
  await requireUser();
  try {
    const r = await newCard({
      owner: form.get("owner"),
      nickname: (form.get("nickname") as string | null)?.trim() || null,
      last4: String(form.get("last4") ?? "").trim() || null,
      file: form.get("file"),
    });
    revalidatePath("/finance/accounts");
    revalidatePath("/finance/rewards");
    return { ok: true, product: r.product, confidence: r.confidence, hasTerms: r.hasTerms };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the form" };
    if (err instanceof CardPhotoError) return { ok: false, error: err.message };
    return { ok: false, error: "Couldn't read the card from this photo. Try again, or add it by name in the card catalog." };
  }
}

const removePicture = authedAction(z.object({ accountId: z.uuid() }), ({ accountId }, user) => deleteAccountImage(as(user), accountId));
export async function removeCardPictureAction(form: FormData) {
  await removePicture({ accountId: form.get("accountId") });
  revalidatePath("/finance/accounts");
}

export const previewCsvAction = authedAction(z.object({ text: z.string().max(MAX_CSV_CHARS) }), async ({ text }, user) => {
  try {
    return { ok: true as const, preview: await previewCsvImport(as(user), text) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not read the file" };
  }
});

export const commitCsvAction = authedAction(
  z.object({
    text: z.string().max(MAX_CSV_CHARS),
    mapping: z.record(z.string(), z.union([z.uuid(), z.literal("new"), z.literal("skip")])),
  }),
  async ({ text, mapping }, user) => {
    const result = await commitCsvImport(as(user), text, mapping);
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
  (q, user) => drillDownTransactions(as(user), q),
);

// ---------- budgets ----------

const CategoryLimit = z.object({ category: z.string().min(1).max(100), limit: z.coerce.number().min(0).max(1_000_000) });

const accept = authedAction(CategoryLimit, ({ category, limit }, user) => setBudget(as(user), category, limit, "auto"));
const override = authedAction(CategoryLimit, ({ category, limit }, user) => setBudget(as(user), category, limit, "manual"));
const remove = authedAction(z.object({ category: z.string().min(1).max(100) }), ({ category }, user) => removeBudget(as(user), category));
const acceptAll = authedAction(z.object({}), (_, user) => acceptAllSuggestions(as(user)));
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

// ---------- rewards ----------

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);

const profile = authedAction(
  z.object({
    accountId: z.uuid(),
    rewardType: z.enum(["points", "cashback"]),
    baseRate: num(0, 100),
    centsPerUnit: num(0, 100),
    annualFee: num(0, 10_000),
    annualFeeMonth: z.coerce.number().int().min(1).max(12).nullable(),
    signupBonus: num(0, 10_000_000).nullable(),
    signupMinSpend: num(0, 1_000_000).nullable(),
    signupStart: z.iso.date().nullable(),
    signupDeadline: z.iso.date().nullable(),
  }).refine(
    (p) => !p.signupStart || !p.signupDeadline || p.signupStart <= p.signupDeadline,
    "The sign-up offer ends before it starts",
  ),
  ({ accountId, ...p }, user) => saveCardProfile(as(user), accountId, p),
);
export async function saveCardProfileAction(form: FormData) {
  await profile({
    accountId: form.get("accountId"),
    rewardType: form.get("rewardType"),
    baseRate: form.get("baseRate"),
    centsPerUnit: form.get("centsPerUnit"),
    annualFee: form.get("annualFee") || 0,
    annualFeeMonth: form.get("annualFeeMonth") || null,
    signupBonus: form.get("signupBonus") || null,
    signupMinSpend: form.get("signupMinSpend") || null,
    signupStart: form.get("signupStart") || null,
    signupDeadline: form.get("signupDeadline") || null,
  });
  revalidatePath("/finance/rewards");
  revalidatePath("/trips", "layout");
}

const rule = authedAction(
  z.object({
    accountId: z.uuid(),
    matchType: z.enum(["category", "subcategory", "merchant"]),
    match: z.string().min(1).max(100),
    rate: num(0, 100),
    capAmount: num(0, 1_000_000).nullable(),
    capPeriod: z.enum(["month", "quarter", "year"]).nullable(),
    validFrom: z.iso.date().nullable(),
    validTo: z.iso.date().nullable(),
    label: z.string().max(60).nullable(),
  }),
  ({ accountId, ...r }, user) => addCardRule(as(user), accountId, r),
);
export async function addCardRuleAction(form: FormData) {
  const capAmount = form.get("capAmount") || null;
  await rule({
    accountId: form.get("accountId"),
    matchType: form.get("matchType"),
    match: form.get("match"),
    rate: form.get("rate"),
    capAmount,
    capPeriod: capAmount ? form.get("capPeriod") || "year" : null,
    validFrom: form.get("validFrom") || null,
    validTo: form.get("validTo") || null,
    label: form.get("label") || null,
  });
  revalidatePath("/finance/rewards");
}

const removeRule = authedAction(z.object({ id: z.uuid() }), ({ id }, user) => deleteCardRule(as(user), id));
export async function deleteCardRuleAction(form: FormData) {
  await removeRule({ id: form.get("id") });
  revalidatePath("/finance/rewards");
}

const advisor = authedAction(z.object({}), (_, user) => runAdvisorNow(as(user)));
export async function runAdvisorAction() {
  try {
    await advisor({});
    revalidatePath("/finance/rewards");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Advisor failed" };
  }
}

// ---------- card catalog ----------

const productId = z.string().regex(/^[a-z0-9-]{1,80}$/);

const link = authedAction(z.object({ accountId: z.uuid(), productId: productId.nullable() }), ({ accountId, productId }, user) =>
  linkCardToCatalog(as(user), accountId, productId),
);
export async function linkCardToCatalogAction(form: FormData) {
  await link({ accountId: form.get("accountId"), productId: form.get("productId") || null });
  revalidatePath("/finance/rewards");
}

const apply = authedAction(z.object({ accountId: z.uuid() }), ({ accountId }, user) => applyCatalogTermsToCard(as(user), accountId));
export async function applyCatalogTermsAction(form: FormData) {
  await apply({ accountId: form.get("accountId") });
  revalidatePath("/finance/rewards");
}

const keep = authedAction(z.object({ accountId: z.uuid() }), ({ accountId }, user) => keepCardRules(as(user), accountId));
export async function keepCardRulesAction(form: FormData) {
  await keep({ accountId: form.get("accountId") });
  revalidatePath("/finance/rewards");
}

const review = authedAction(z.object({ id: z.uuid(), decision: z.enum(["accept", "reject"]) }), ({ id, decision }) =>
  decision === "accept" ? acceptCatalogChange(id) : rejectCatalogChange(id),
);
export async function reviewCatalogChangeAction(form: FormData) {
  await review({ id: form.get("id"), decision: form.get("decision") });
  revalidatePath("/finance/rewards");
  revalidatePath("/finance/rewards/catalog");
}

const seen = authedAction(z.object({}), () => markCatalogChangesSeen());
export async function markCatalogChangesSeenAction() {
  await seen({});
  revalidatePath("/finance/rewards");
  revalidatePath("/finance/rewards/catalog");
}

const domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).max(100);
const addProduct = authedAction(
  z.object({ issuer: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(80), sourceDomains: z.array(domain).min(1).max(4) }),
  (p) => addCatalogProduct({ ...p, sourceDomains: p.sourceDomains.map((d) => d.toLowerCase()) }),
);
export async function addCatalogProductAction(form: FormData) {
  await addProduct({
    issuer: form.get("issuer"),
    name: form.get("name"),
    sourceDomains: String(form.get("sourceDomains") ?? "")
      .split(/[\s,]+/)
      .filter(Boolean),
  });
  revalidatePath("/finance/rewards/catalog");
}

type CatalogState = null | { ok: true; message: string } | { ok: false; error: string };

const refresh = authedAction(z.object({ productId }), ({ productId }) => refreshCatalogCardNow(productId));
export async function refreshCatalogCardAction(_prev: CatalogState, form: FormData): Promise<CatalogState> {
  try {
    const r = await refresh({ productId: form.get("productId") });
    revalidatePath("/finance/rewards/catalog");
    revalidatePath("/finance/rewards");
    if (r.status === "error") return { ok: false, error: r.error };
    return { ok: true, message: r.status === "unchanged" ? "Verified, no changes" : r.status === "applied" ? `${r.changes.length} change(s) saved` : "Changes need your review" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Check failed" };
  }
}

const MAX_TERMS_CHARS = 100_000;
const editTerms = authedAction(z.object({ productId, terms: CardTerms }), ({ productId, terms }) => saveCatalogTermsByUser(productId, terms));
export async function saveCatalogTermsAction(_prev: CatalogState, form: FormData): Promise<CatalogState> {
  // Check the session before touching the input; editTerms re-checks it too.
  await requireUser();
  const raw = String(form.get("terms") ?? "");
  if (raw.length > MAX_TERMS_CHARS) return { ok: false, error: "Terms are too long" };
  let terms: unknown;
  try {
    terms = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Not valid JSON" };
  }
  const parsed = CardTerms.safeParse(terms);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ") };
  await editTerms({ productId: form.get("productId"), terms: parsed.data });
  revalidatePath("/finance/rewards/catalog");
  revalidatePath("/finance/rewards");
  return { ok: true, message: "Saved" };
}
