import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { isIncome } from "../analytics/load";
import { financeAccounts, financeCardProfiles, financeCardRules, financeTransactions as t } from "../schema";
import { rotatingRules } from "./catalog/categories";
import { compareCatalog, type CatalogCard } from "./catalog/compare";
import { heldProductIds, listCatalog } from "./catalog/store";
import { auditRewards, nextFeeDate, type Card, type CardRule } from "./engine";

const nameSql = sql<string>`coalesce(${financeAccounts.displayName}, ${financeAccounts.bankName})`;

/** Active credit cards with their reward profile (or null if not set up yet). */
export async function listCardsWithProfiles() {
  const cards = await db()
    .select({ accountId: financeAccounts.id, name: nameSql, owner: financeAccounts.owner, profile: financeCardProfiles })
    .from(financeAccounts)
    .leftJoin(financeCardProfiles, eq(financeCardProfiles.accountId, financeAccounts.id))
    .where(and(eq(financeAccounts.active, true), eq(financeAccounts.kind, "credit")))
    .orderBy(asc(financeAccounts.owner), asc(nameSql));
  const rules = cards.length
    ? await db().select().from(financeCardRules).where(inArray(financeCardRules.accountId, cards.map((c) => c.accountId)))
    : [];
  return cards.map((c) => ({ ...c, rules: rules.filter((r) => r.accountId === c.accountId) }));
}

/**
 * Cards as the audit sees them: the card's own rules, plus the catalog's
 * rotating quarterly categories for cards linked to the catalog. A quarter
 * the household entered by hand (a rule with a date window overlapping it)
 * wins over the catalog.
 */
export async function loadAuditCards(): Promise<(Card & { owner: string; catalogProductId: string | null })[]> {
  const [cards, catalog] = await Promise.all([listCardsWithProfiles(), listCatalog()]);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return cards
    .filter((c) => c.profile)
    .map((c) => {
      const own = c.rules.map(
        (r): CardRule => ({
          id: r.id,
          matchType: r.matchType,
          match: r.match,
          rate: r.rate,
          capAmount: r.capAmount,
          capPeriod: r.capPeriod,
          validFrom: r.validFrom,
          validTo: r.validTo,
          label: r.label,
          capGroup: r.capGroup ?? undefined,
        }),
      );
      const product = c.profile!.catalogProductId ? byId.get(c.profile!.catalogProductId) : undefined;
      const rotating = product?.terms
        ? rotatingRules(product.id, product.terms).filter(
            (v) => !own.some((o) => o.validFrom && o.validTo && o.validFrom <= v.validTo! && o.validTo >= v.validFrom!),
          )
        : [];
      return {
        accountId: c.accountId,
        name: c.name,
        owner: c.owner,
        catalogProductId: c.profile!.catalogProductId,
        baseRate: c.profile!.baseRate,
        centsPerUnit: c.profile!.centsPerUnit,
        annualFee: c.profile!.annualFee,
        rules: [...own, ...rotating],
      };
    });
}

export type ProfileInput = {
  rewardType: "points" | "cashback";
  baseRate: number;
  centsPerUnit: number;
  annualFee: number;
  annualFeeMonth: number | null;
};

export async function saveCardProfile(accountId: string, p: ProfileInput, today = new Date()) {
  await db()
    .insert(financeCardProfiles)
    .values({ accountId, ...p })
    .onConflictDoUpdate({ target: financeCardProfiles.accountId, set: { ...p, updatedAt: new Date() } });
  await publishAnnualFeeReminders(today, [accountId]);
}

export async function addCardRule(accountId: string, rule: Omit<CardRule, "id" | "capGroup">) {
  await db().insert(financeCardRules).values({ accountId, ...rule, source: "user" });
}

export async function deleteCardRule(ruleId: string) {
  await db().delete(financeCardRules).where(eq(financeCardRules.id, ruleId));
}

/** Tell the calendar about upcoming annual fees (idempotent on card + date). */
export async function publishAnnualFeeReminders(today = new Date(), accountIds?: string[]) {
  const rows = await db()
    .select({ accountId: financeCardProfiles.accountId, name: nameSql, fee: financeCardProfiles.annualFee, month: financeCardProfiles.annualFeeMonth })
    .from(financeCardProfiles)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeCardProfiles.accountId))
    .where(
      and(
        isNotNull(financeCardProfiles.annualFeeMonth),
        eq(financeAccounts.active, true),
        accountIds ? inArray(financeCardProfiles.accountId, accountIds) : undefined,
      ),
    );
  for (const r of rows) {
    if (!r.month || r.fee <= 0) continue;
    await bus.publish("finance", "finance.annualFeeUpcoming", {
      accountId: r.accountId,
      cardName: r.name,
      dueDate: nextFeeDate(r.month, today),
      amount: r.fee,
    });
  }
}

async function loadSpend(accountIds: string[], fromDate: string) {
  if (accountIds.length === 0) return [];
  const txns = await db()
    .select({
      id: t.id,
      accountId: t.accountId,
      date: t.postedDate,
      amount: sql<number>`(-${t.amount})::float8`,
      merchant: t.merchant,
      category: t.category,
      subcategory: t.subcategory,
    })
    .from(t)
    .where(
      and(
        inArray(t.accountId, accountIds),
        gte(t.postedDate, fromDate),
        eq(t.isTransfer, false),
        sql`${t.amount} < 0`,
        sql`not ${isIncome}`,
      ),
    )
    .orderBy(desc(t.postedDate));
  return txns.map((x) => ({ ...x, amount: Number(x.amount) }));
}

export async function runRewardsAudit(fromDate: string) {
  const cards = await loadAuditCards();
  if (cards.length === 0) return { cards, audit: null };
  const txns = await loadSpend(cards.map((c) => c.accountId), fromDate);
  return { cards, audit: auditRewards(cards, txns) };
}

/**
 * Every verified-or-seeded catalog card the household does not hold, priced
 * against its spending since `fromDate`. Credit cards without a reward
 * profile count as plain 1% cards, so their spend is not treated as free.
 */
export async function runCatalogComparison(fromDate: string) {
  const [all, cards, catalog, held] = await Promise.all([listCardsWithProfiles(), loadAuditCards(), listCatalog(), heldProductIds()]);
  const baseline: Card[] = [
    ...cards,
    ...all
      .filter((c) => !c.profile)
      .map((c) => ({ accountId: c.accountId, name: c.name, baseRate: 1, centsPerUnit: 1, annualFee: 0, rules: [] })),
  ];
  const txns = await loadSpend(all.map((c) => c.accountId), fromDate);
  const candidates: CatalogCard[] = catalog
    .filter((p) => p.terms && !held.has(p.id))
    .map((p) => ({ id: p.id, issuer: p.issuer, name: p.name, terms: p.terms!, verifiedAt: p.verifiedAt }));
  return compareCatalog(baseline, txns, candidates);
}
