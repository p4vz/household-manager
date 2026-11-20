import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { bus } from "@/core/bus";
import { db } from "@/core/db/client";
import { isIncome } from "../analytics/load";
import { financeAccounts, financeCardProfiles, financeCardRules, financeTransactions as t } from "../schema";
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

export async function loadAuditCards(): Promise<(Card & { owner: string })[]> {
  const cards = await listCardsWithProfiles();
  return cards
    .filter((c) => c.profile)
    .map((c) => ({
      accountId: c.accountId,
      name: c.name,
      owner: c.owner,
      baseRate: c.profile!.baseRate,
      centsPerUnit: c.profile!.centsPerUnit,
      annualFee: c.profile!.annualFee,
      rules: c.rules.map(
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
        }),
      ),
    }));
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

export async function addCardRule(accountId: string, rule: Omit<CardRule, "id">) {
  await db().insert(financeCardRules).values({ accountId, ...rule });
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

export async function runRewardsAudit(fromDate: string) {
  const cards = await loadAuditCards();
  if (cards.length === 0) return { cards, audit: null };
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
        inArray(t.accountId, cards.map((c) => c.accountId)),
        gte(t.postedDate, fromDate),
        eq(t.isTransfer, false),
        sql`${t.amount} < 0`,
        sql`not ${isIncome}`,
      ),
    )
    .orderBy(desc(t.postedDate));
  return { cards, audit: auditRewards(cards, txns.map((x) => ({ ...x, amount: Number(x.amount) }))) };
}
