import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, min, sql, type SQL } from "drizzle-orm";
import type { ModuleName } from "@/core/bus/events";
import { aiConfigured } from "@/core/ai/keys";
import { db } from "@/core/db/client";
import { HiddenAccountError, VIEWERS, canSeeOwner, visibleTo, type Viewer } from "./access";
import { cardImagesConfigured, loadAccountImages, removeAccountImage, storeAccountImage } from "./accounts/images";
import { CardPhotoError, addCardFromPhoto as addFromPhoto, type NewCardInput } from "./accounts/from-photo";
import { categorizeUncategorized, setMerchantCategory } from "./ai/categorize";
import { applyFilters, cashFlow, categoryBreakdown, rangeMonths, topMerchants, type OwnerFilter, type RangeKey } from "./analytics/compute";
import { isIncome, loadCategoryFacts, loadMerchantFacts } from "./analytics/load";
import {
  acceptAllSuggestions,
  budgetOverview,
  removeBudget,
  saveBudgetOptions,
  setBudget,
} from "./budget/store";
import { clearAccessUrl, connectionInfo, storeAccessUrl } from "./ingest/credentials";
import { cleanTypedName } from "./ingest/redact";
import { householdTimeZone, localHour } from "./ingest/schedule";
import { hasReportForMonth, latestAdvisorReport, runAdvisor } from "./rewards/advisor";
import {
  addCardRule as addRule,
  deleteCardRule as deleteRule,
  listCardsWithProfiles,
  loadAuditCards,
  planCardsForPurchases,
  publishAnnualFeeReminders,
  runCatalogComparison,
  runRewardsAudit,
  saveCardProfile as saveProfile,
} from "./rewards/store";
import {
  acceptCatalogChange,
  addCatalogProduct,
  applyCatalogTermsToCard as applyTerms,
  catalogDriftForCards as catalogDrift,
  heldProductIds,
  keepCardRules as keepRules,
  linkCardToCatalog as linkCard,
  listCatalog,
  listCatalogChanges,
  markCatalogChangesSeen,
  rejectCatalogChange,
  saveCatalogTermsByUser,
} from "./rewards/catalog/store";
import { refreshCatalogProduct, runCatalogRefreshIfDue } from "./rewards/catalog/refresh";
import { commitCsvImport, previewCsvImport, type AccountMapping } from "./ingest/import";
import { claimAccessUrl } from "./ingest/simplefin";
import { syncSimplefin } from "./ingest/sync";
import {
  CARD_KINDS,
  financeAccounts,
  financeCardCatalog,
  financeCardProfiles,
  financeCardRules,
  financeExpectedExpenses,
  financeSyncRuns,
  financeTransactions,
  type AccountKind,
  type Owner,
} from "./schema";

/**
 * Finance module public API. Pages, server actions, cron routes and other
 * modules use only these functions.
 *
 * Private accounts: every read takes the `viewer` (the signed-in member, or
 * the member an assistant acts for) and returns only joint accounts and the
 * viewer's own. Writes that name an account check the same rule. See
 * ./access.ts.
 */

export { viewerFromLabel, VIEWERS, type Viewer } from "./access";

/** Accounts whose data this member may see: joint ones and their own. */
export async function visibleAccountIds(viewer: Viewer): Promise<Set<string>> {
  const rows = await db().select({ id: financeAccounts.id }).from(financeAccounts).where(visibleTo(viewer));
  return new Set(rows.map((r) => r.id));
}

/** Throws unless the account exists and is joint or the viewer's own. */
async function assertVisibleAccount(viewer: Viewer, accountId: string) {
  const [row] = await db().select({ owner: financeAccounts.owner }).from(financeAccounts).where(eq(financeAccounts.id, accountId));
  if (!row || !canSeeOwner(viewer, row.owner)) throw new HiddenAccountError();
}

// ---------- ingestion ----------

export { previewCsvImport, commitCsvImport, type AccountMapping };
export { MAX_CARD_IMAGE_BYTES, CARD_IMAGE_TYPES } from "./accounts/images";
export { isSyncSlot, householdTimeZone } from "./ingest/schedule";

/** `viewer` linked the banks: accounts the sync finds start as theirs. */
export async function connectSimplefin(setupToken: string, viewer: Viewer) {
  const accessUrl = await claimAccessUrl(setupToken);
  await storeAccessUrl(accessUrl, viewer);
  return syncSimplefin({ trigger: "setup" });
}

/** "Sync now" in Settings. Rate-limited in syncSimplefin. */
export function syncSimplefinNow() {
  return syncSimplefin({ trigger: "manual" });
}

/**
 * Forget the stored SimpleFIN key. Accounts and transactions already synced
 * stay. An access URL set in the environment cannot be removed from here.
 */
export async function disconnectSimplefin() {
  await clearAccessUrl();
  return connectionInfo();
}

export async function runScheduledSync(now = new Date()) {
  const result = await syncSimplefin({ trigger: "cron", now });
  if (result.status === "ok" && result.inserted > 0 && (await aiConfigured())) {
    // Best effort: a provider outage must not fail the bank sync.
    await categorizeUncategorized().catch((err) =>
      console.error(`[finance] AI categorization failed: ${err instanceof Error ? err.message : err}`),
    );
  }
  // Keep next year's annual-fee reminders on the calendar.
  await publishAnnualFeeReminders(now).catch(() => undefined);
  return result;
}


export { categorizeUncategorized, setMerchantCategory };

export async function syncStatus() {
  const connection = await connectionInfo();
  const runs = await db()
    .select({
      status: financeSyncRuns.status,
      startedAt: financeSyncRuns.startedAt,
      inserted: financeSyncRuns.inserted,
      messages: financeSyncRuns.messages,
    })
    .from(financeSyncRuns)
    .orderBy(desc(financeSyncRuns.startedAt))
    .limit(5);
  const [lastOk] = await db()
    .select({ startedAt: financeSyncRuns.startedAt, inserted: financeSyncRuns.inserted })
    .from(financeSyncRuns)
    .where(eq(financeSyncRuns.status, "ok"))
    .orderBy(desc(financeSyncRuns.startedAt))
    .limit(1);
  const [totals] = await db()
    .select({ n: count(), first: min(financeTransactions.postedDate), last: max(financeTransactions.postedDate) })
    .from(financeTransactions);
  const [accounts] = await db().select({ n: count() }).from(financeAccounts).where(isNotNull(financeAccounts.simplefinId));
  return { connection, runs, lastOk: lastOk ?? null, totals, simplefinAccounts: accounts?.n ?? 0 };
}

// ---------- accounts ----------

/**
 * Every household account, for the Accounts page: both members see that each
 * account exists (official name, nickname, owner, picture). Balance and
 * editing are only for accounts the viewer can see (joint or their own).
 */
export async function listAccounts(viewer: Viewer) {
  const rows = await db()
    .select({
      id: financeAccounts.id,
      bankName: financeAccounts.bankName,
      institution: financeAccounts.institution,
      displayName: financeAccounts.displayName,
      officialName: financeAccounts.officialName,
      last4: financeAccounts.last4,
      owner: financeAccounts.owner,
      kind: financeAccounts.kind,
      catalogProductId: financeCardProfiles.catalogProductId,
      active: financeAccounts.active,
      balance: financeAccounts.balance,
      currency: financeAccounts.currency,
      linked: financeAccounts.simplefinId,
      simplefinStartDate: financeAccounts.simplefinStartDate,
      catalogProduct: sql<string | null>`${financeCardCatalog.issuer} || ' ' || ${financeCardCatalog.name}`,
    })
    .from(financeAccounts)
    .leftJoin(financeCardProfiles, eq(financeCardProfiles.accountId, financeAccounts.id))
    .leftJoin(financeCardCatalog, eq(financeCardCatalog.id, financeCardProfiles.catalogProductId))
    .orderBy(asc(financeAccounts.owner), asc(financeAccounts.bankName));
  const images = await loadAccountImages(rows.map((a) => a.id));
  return rows.map(({ linked, balance, last4, ...a }) => {
    const visible = canSeeOwner(viewer, a.owner);
    return {
      ...a,
      /** Shown only to members who can see the account. */
      last4: visible ? last4 : null,
      /** Product name: what was entered, else the linked catalog card, else the bank's name. */
      officialNameShown: a.officialName ?? a.catalogProduct ?? a.bankName,
      /** False = CSV history only: the card still needs adding to the SimpleFIN connection. */
      linked: Boolean(linked),
      visible,
      canEdit: visible,
      balance: visible ? balance : null,
      image: images.get(a.id) ?? null,
    };
  });
}

export type AccountPatch = {
  displayName: string | null;
  officialName: string | null;
  /** Exactly four digits, or null to clear. */
  last4: string | null;
  owner: Owner;
  kind: AccountKind;
  active: boolean;
};

/** Only joint accounts and the viewer's own can be changed. Names never keep digit runs. */
export async function updateAccount(viewer: Viewer, id: string, patch: AccountPatch) {
  await assertVisibleAccount(viewer, id);
  if (patch.last4 != null && !/^\d{4}$/.test(patch.last4)) throw new Error("Last 4 must be four digits");
  await db()
    .update(financeAccounts)
    .set({ ...patch, displayName: cleanTypedName(patch.displayName), officialName: cleanTypedName(patch.officialName) })
    .where(eq(financeAccounts.id, id));
}

export { cardImagesConfigured };

export async function setAccountImage(viewer: Viewer, accountId: string, bytes: Buffer) {
  await assertVisibleAccount(viewer, accountId);
  await storeAccountImage(accountId, bytes, viewer);
}

/**
 * A card just opened, from a photo of its front with the number covered:
 * the AI reads issuer and product, the card is created (before the bank
 * sync knows it), linked to the catalog and keeps the photo. A catalog card
 * without terms yet is looked up in the background.
 */
export async function addCardFromPhoto(viewer: Viewer, input: Omit<NewCardInput, "viewer">) {
  if (!(await aiConfigured())) throw new CardPhotoError("Add an AI key in Settings first: it reads the card's name from the photo.");
  const result = await addFromPhoto({ ...input, viewer });
  if (!result.hasTerms) {
    void refreshCatalogProduct(result.productId).catch((err) =>
      console.error(`[finance] catalog lookup for a new card failed: ${err instanceof Error ? err.message : err}`),
    );
  }
  return result;
}

export { CardPhotoError };

/**
 * Last 4 digits of the accounts this member can see, by account id, for
 * Finance pages only. Kept out of the card and account lists that the AI
 * advisor, the in-app assistant and MCP read.
 */
export async function visibleAccountLast4(viewer: Viewer): Promise<Record<string, string>> {
  const rows = await db()
    .select({ id: financeAccounts.id, last4: financeAccounts.last4 })
    .from(financeAccounts)
    .where(and(visibleTo(viewer), isNotNull(financeAccounts.last4)));
  return Object.fromEntries(rows.map((r) => [r.id, r.last4!]));
}

/** Card pictures (data: URLs) of the accounts this member can see, for Finance pages. */
export async function visibleAccountImages(viewer: Viewer): Promise<Record<string, string>> {
  return Object.fromEntries(await loadAccountImages([...(await visibleAccountIds(viewer))]));
}

export async function deleteAccountImage(viewer: Viewer, accountId: string) {
  await assertVisibleAccount(viewer, accountId);
  await removeAccountImage(accountId);
}

// ---------- transactions ----------

export async function listRecentTransactions(viewer: Viewer, limit = 100) {
  return db()
    .select({
      id: financeTransactions.id,
      date: financeTransactions.postedDate,
      merchant: financeTransactions.merchant,
      category: financeTransactions.category,
      subcategory: financeTransactions.subcategory,
      amount: financeTransactions.amount,
      pending: financeTransactions.pending,
      isTransfer: financeTransactions.isTransfer,
      source: financeTransactions.source,
      accountId: financeTransactions.accountId,
      account: financeAccounts.displayName,
      bankName: financeAccounts.bankName,
      owner: financeAccounts.owner,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeTransactions.accountId, financeAccounts.id))
    .where(visibleTo(viewer))
    .orderBy(desc(financeTransactions.postedDate))
    .limit(limit);
}

// ---------- insights ----------

/** Everything the dashboard needs; filtering happens in the browser. */
export async function dashboardData(viewer: Viewer, today = new Date()) {
  const months = rangeMonths("12M", today);
  const from = `${months[0]}-01`;
  const [categoryFacts, merchantFacts, accounts] = await Promise.all([
    loadCategoryFacts(viewer, from),
    loadMerchantFacts(viewer, from),
    db()
      .select({
        id: financeAccounts.id,
        name: sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`,
        last4: financeAccounts.last4,
        owner: financeAccounts.owner,
      })
      .from(financeAccounts)
      .where(and(eq(financeAccounts.active, true), visibleTo(viewer)))
      .orderBy(asc(financeAccounts.owner)),
  ]);
  return { today: today.toISOString().slice(0, 10), categoryFacts, merchantFacts, accounts };
}

export type { OwnerFilter, RangeKey };

/** Spending by category (with subcategories) and top merchants over a range. Aggregates only. */
export async function spendingSummary(viewer: Viewer, range: RangeKey, owner: OwnerFilter = "all", today = new Date()) {
  const months = rangeMonths(range, today);
  const from = `${months[0]}-01`;
  const [cats, merchants] = await Promise.all([loadCategoryFacts(viewer, from), loadMerchantFacts(viewer, from)]);
  const f = { owner, accountIds: null, months };
  const catFacts = applyFilters(cats, f);
  return {
    months,
    byCategory: categoryBreakdown(catFacts),
    byMonth: cashFlow(catFacts, months).series.map((m) => ({ month: m.month, spend: m.spend })),
    topMerchants: topMerchants(applyFilters(merchants, f), 15),
  };
}

/** Income vs spending per month, with the savings rate. No forecasting. */
export async function cashFlowSummary(viewer: Viewer, range: RangeKey, owner: OwnerFilter = "all", today = new Date()) {
  const months = rangeMonths(range, today);
  const facts = applyFilters(await loadCategoryFacts(viewer, `${months[0]}-01`), { owner, accountIds: null, months });
  return cashFlow(facts, months);
}

export type DrillDown = {
  range: RangeKey;
  owner: OwnerFilter;
  accountIds: string[] | null;
  category?: string;
  subcategory?: string | null;
  merchant?: string;
};

export async function drillDownTransactions(viewer: Viewer, q: DrillDown, today = new Date()) {
  const months = rangeMonths(q.range, today);
  const [y, m] = months[months.length - 1].split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const where: SQL[] = [
    eq(financeTransactions.isTransfer, false),
    eq(financeAccounts.active, true),
    visibleTo(viewer),
    gte(financeTransactions.postedDate, `${months[0]}-01`),
    lt(financeTransactions.postedDate, end),
  ];
  if (q.owner !== "all") where.push(eq(financeAccounts.owner, q.owner));
  if (q.accountIds?.length) where.push(inArray(financeTransactions.accountId, q.accountIds));
  if (q.category === "Uncategorized") where.push(isNull(financeTransactions.category));
  else if (q.category) where.push(eq(financeTransactions.category, q.category));
  if (q.subcategory === "Other") where.push(isNull(financeTransactions.subcategory));
  else if (q.subcategory) where.push(eq(financeTransactions.subcategory, q.subcategory));
  if (q.merchant) where.push(eq(financeTransactions.merchant, q.merchant), sql`not ${isIncome}`);

  return db()
    .select({
      id: financeTransactions.id,
      date: financeTransactions.postedDate,
      merchant: financeTransactions.merchant,
      category: financeTransactions.category,
      subcategory: financeTransactions.subcategory,
      amount: financeTransactions.amount,
      account: sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`,
      owner: financeAccounts.owner,
    })
    .from(financeTransactions)
    .innerJoin(financeAccounts, eq(financeTransactions.accountId, financeAccounts.id))
    .where(and(...where))
    .orderBy(desc(financeTransactions.postedDate))
    .limit(500);
}

// ---------- budgets ----------

export { budgetOverview, setBudget, removeBudget, acceptAllSuggestions, saveBudgetOptions };

// ---------- rewards ----------

export { listCardsWithProfiles, latestAdvisorReport };

export async function saveCardProfile(viewer: Viewer, accountId: string, p: Parameters<typeof saveProfile>[1], today = new Date()) {
  await assertVisibleAccount(viewer, accountId);
  return saveProfile(accountId, p, today);
}

export async function addCardRule(viewer: Viewer, accountId: string, rule: Parameters<typeof addRule>[1]) {
  await assertVisibleAccount(viewer, accountId);
  return addRule(accountId, rule);
}

export async function deleteCardRule(viewer: Viewer, ruleId: string) {
  const [rule] = await db().select({ accountId: financeCardRules.accountId }).from(financeCardRules).where(eq(financeCardRules.id, ruleId));
  if (!rule) return;
  await assertVisibleAccount(viewer, rule.accountId);
  return deleteRule(ruleId);
}

export function rewardsAudit(viewer: Viewer, range: RangeKey = "12M", today = new Date()) {
  return runRewardsAudit(viewer, `${rangeMonths(range, today)[0]}-01`);
}

export function runAdvisorNow(viewer: Viewer) {
  return runAdvisor(viewer, "manual");
}

/** Monthly advisor: first day of the month, 8 AM household time, once. */
export async function runMonthlyAdvisorIfDue(now = new Date()) {
  const tz = householdTimeZone();
  const day = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now));
  if (day !== 1 || localHour(now, tz) !== 8) return { status: "skipped" as const, reason: "Not the monthly slot" };
  if (!(await aiConfigured())) return { status: "skipped" as const, reason: "No AI provider key configured" };
  // One report per member, each over only what that member can see.
  let ran = 0;
  for (const viewer of VIEWERS) {
    if (await hasReportForMonth(viewer, now)) continue;
    await runAdvisor(viewer, "monthly", now);
    ran++;
  }
  if (ran === 0) return { status: "skipped" as const, reason: "Already ran this month" };
  return { status: "ok" as const };
}

// ---------- card catalog ----------
// A stored, kept-current copy of each card's published terms (bonus
// categories, rotating quarters, sign-up offer, credits, perks), for the
// household's cards and well-known cards it does not hold.

export { CardTerms, CATALOG_CATEGORIES } from "./rewards/catalog/terms";
export { PURCHASE_KINDS, PURCHASE_CATEGORY, type PurchaseKind } from "./rewards/catalog/categories";
export {
  acceptCatalogChange,
  rejectCatalogChange,
  markCatalogChangesSeen,
  listCatalogChanges,
  addCatalogProduct,
  saveCatalogTermsByUser,
  runCatalogRefreshIfDue,
};

export async function linkCardToCatalog(viewer: Viewer, accountId: string, productId: string | null) {
  await assertVisibleAccount(viewer, accountId);
  return linkCard(accountId, productId);
}

export async function applyCatalogTermsToCard(viewer: Viewer, accountId: string) {
  await assertVisibleAccount(viewer, accountId);
  return applyTerms(accountId);
}

export async function keepCardRules(viewer: Viewer, accountId: string) {
  await assertVisibleAccount(viewer, accountId);
  return keepRules(accountId);
}

/** Catalog changes not yet applied to the viewer's visible cards. */
export async function catalogDriftForCards(viewer: Viewer) {
  return catalogDrift(await visibleAccountIds(viewer));
}

export async function cardCatalog() {
  const [products, held] = await Promise.all([listCatalog(), heldProductIds()]);
  return products.map((p) => ({ ...p, held: held.has(p.id) }));
}

/** Check one card against its issuer now (two AI calls with web search). */
export function refreshCatalogCardNow(productId: string) {
  return refreshCatalogProduct(productId);
}

/** Cards the household does not hold, priced against its spending. */
export function catalogComparison(viewer: Viewer, range: RangeKey = "12M", today = new Date()) {
  return runCatalogComparison(viewer, `${rangeMonths(range, today)[0]}-01`);
}

/**
 * Stored terms of each household card that is linked to the catalog
 * (credits, perks, current sign-up offer, rotating quarters), for other
 * modules such as trips. Read from the database, never fetched live.
 */
export async function heldCardTerms(viewer: Viewer) {
  const [cards, catalog] = await Promise.all([loadAuditCards(viewer), listCatalog()]);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return cards.flatMap((c) => {
    const p = c.catalogProductId ? byId.get(c.catalogProductId) : undefined;
    return p?.terms
      ? [{ accountId: c.accountId, card: c.name, product: `${p.issuer} ${p.name}`, terms: p.terms, verifiedAt: p.verifiedAt }]
      : [];
  });
}

/** Open sign-up bonuses and how far along each one is. */
export async function signupBonusOverview(viewer: Viewer, today = new Date()) {
  return (await planCardsForPurchases(viewer, [], today)).bonuses;
}

// ---------- cross-module ----------

export type { PlannedPurchase, PurchasePlan, BonusStatus } from "./rewards/bonus";

/**
 * Card advice for purchases another module is planning (trip bookings):
 * best card per purchase, with open sign-up bonuses routed first, and each
 * bonus's progress including the planned spend.
 */
export { planCardsForPurchases };

export {
  autoLinkTransactions,
  clearTransactionLinks,
  householdLinkCandidates,
  linkCandidates,
  linkedTransactions,
  setTransactionLinks,
  transactionsWithLinks,
  type LinkableTransaction,
  type TransactionLink,
} from "./links";
export { LINK_STATUSES, LINK_SOURCES, type LinkStatus, type LinkSource } from "./schema";

/**
 * Rewards on specific transactions (a trip's charges): what each earned on
 * the card used and what the best household card would have earned, from
 * the same deterministic audit as Finance → Rewards. Only cards and charges
 * this member can see.
 */
export async function rewardsForTransactions(viewer: Viewer, ids: string[], fromDate: string) {
  if (!ids.length) return { rows: [], earned: 0, missed: 0 };
  const { audit } = await runRewardsAudit(viewer, fromDate);
  const wanted = new Set(ids);
  const rows = (audit?.rows ?? []).filter((r) => wanted.has(r.txnId));
  const sum = (f: (r: (typeof rows)[number]) => number) => Math.round(rows.reduce((s, r) => s + f(r), 0)) / 100;
  return { rows, earned: sum((r) => r.actualCents), missed: sum((r) => r.missedCents) };
}

/**
 * Active household credit cards, for "paid with" pickers in other modules.
 * Lists every card by nickname and owner (both members know each card
 * exists); no balances or spending.
 */
export async function listCreditCards() {
  return db()
    .select({
      accountId: financeAccounts.id,
      name: sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`,
      owner: financeAccounts.owner,
    })
    .from(financeAccounts)
    .where(and(eq(financeAccounts.active, true), inArray(financeAccounts.kind, CARD_KINDS)))
    .orderBy(asc(financeAccounts.owner), asc(financeAccounts.bankName));
}

export type ExpectedExpense = {
  title: string;
  date: string;
  amount: number;
  category?: string | null;
};

/** Record a known upcoming cost owned by another module. Idempotent. */
export async function upsertExpectedExpense(
  source: { module: ModuleName; ref: string },
  expense: ExpectedExpense,
) {
  await db()
    .insert(financeExpectedExpenses)
    .values({
      ...expense,
      category: expense.category ?? null,
      sourceModule: source.module,
      sourceRef: source.ref,
    })
    .onConflictDoUpdate({
      target: [financeExpectedExpenses.sourceModule, financeExpectedExpenses.sourceRef],
      set: { title: expense.title, date: expense.date, amount: expense.amount },
    });
}

export async function removeExpectedExpense(source: { module: ModuleName; ref: string }) {
  await db()
    .delete(financeExpectedExpenses)
    .where(
      and(
        eq(financeExpectedExpenses.sourceModule, source.module),
        eq(financeExpectedExpenses.sourceRef, source.ref),
      ),
    );
}

export async function listExpectedExpenses(fromDate: string) {
  return db()
    .select({
      title: financeExpectedExpenses.title,
      date: financeExpectedExpenses.date,
      amount: financeExpectedExpenses.amount,
      category: financeExpectedExpenses.category,
      sourceModule: financeExpectedExpenses.sourceModule,
    })
    .from(financeExpectedExpenses)
    .where(gte(financeExpectedExpenses.date, fromDate))
    .orderBy(asc(financeExpectedExpenses.date));
}

/** On-screen owner labels (names only on screen; AI and MCP keep User 1 / User 2). */
export const OWNER_LABELS: Record<Owner, string> = { user1: "Pavel", user2: "Raisa", joint: "Joint" };
export { OWNERS, ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, CARD_KINDS, type Owner, type AccountKind } from "./schema";

// ---------- in-app assistant (src/assistant) ----------

export {
  assistantAccounts,
  searchTransactions,
  categoryCounts,
  monthlySpendByCategory,
  transactionsForEdit,
  updateTransactionFields,
  getMerchantRule,
  setMerchantRule,
  deleteMerchantRule,
  MAX_SEARCH_ROWS,
  type TransactionSearch,
  type TransactionEditable,
  type MerchantRule,
} from "./assistant";

// ---------- one-time Finance review (/finance/review) ----------

export {
  reconcileReport,
  mergeImportedAccount,
  removeDuplicateCopies,
  renameAccountForReview,
  deactivateAccountForReview,
  type ReconcileReport,
  type ImportedMatch,
  type DuplicatePair,
  type NameFix,
  type CoverageNote,
} from "./review/reconcile";
export { categoryReview, proposeCategoriesWithAi, applyCategoryMapping, type CategoryReviewRow, type CategoryMapping } from "./review/categories";
export { TAXONOMY, PARENTS, allChoices, formatPair, parsePair, type CategoryPair } from "./review/taxonomy";
export {
  DEFAULT_LARGE_THRESHOLD,
  largeThreshold,
  setLargeThreshold,
  largePurchases,
  reviewTransaction,
  recordLargePurchaseAnswer,
  dismissLargePurchasesAt,
  reopenLargePurchase,
  type LargePurchase,
} from "./review/large";
export { listReviewActions, undoReviewAction } from "./review/log";
export {
  houseQuestions,
  paymentsNear,
  paymentsMatching,
  saveHouseSuggestions,
  houseAuditState,
  setHouseAuditState,
  CAR_VENDOR_PATTERN,
  HOME_VENDOR_PATTERN,
  type HouseQuestion,
  type HouseQuestionKind,
} from "./review/house";
export type { HouseSuggestion } from "./schema";

// ---------- subscriptions ----------

export {
  listSubscriptions,
  saveDetected as saveDetectedSubscription,
  addManualSubscription,
  updateSubscription,
  deleteSubscription,
  type SubscriptionRow,
  type SubscriptionInput,
} from "./subscriptions";
export { SUBSCRIPTION_CADENCES, SUBSCRIPTION_STATUSES, type SubscriptionCadence, type SubscriptionStatus } from "./schema";

// ---------- net worth ----------

export {
  netWorth,
  scopeOwners,
  listNetWorthItems,
  addNetWorthItem,
  updateNetWorthItem,
  setNetWorthValue,
  deleteNetWorthItem,
  type NetWorthScope,
  type NetWorthItemInput,
} from "./net-worth";
export { NET_WORTH_KIND_LABELS, GROUP_LABELS as NET_WORTH_GROUP_LABELS, LIABILITY_KINDS, type NetWorth } from "./net-worth-compute";
export { NET_WORTH_ITEM_KINDS, type NetWorthItemKind } from "./schema";
