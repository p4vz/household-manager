import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizePayload, scrubText, legalNamesFromEnv, type LlmOwnerLabel } from "@/core/ai/sanitize";
import { getAiSettings } from "@/core/ai/store";
import { db } from "@/core/db/client";
import { isIncome } from "../analytics/load";
import { financeAccounts, financeAdvisorReports, financeTransactions as t } from "../schema";
import { listCatalog } from "./catalog/store";
import { quarterOf } from "./catalog/terms";
import { runCatalogComparison, runRewardsAudit } from "./store";

export const AdvisorReport = z.object({
  summary: z.string(),
  underperformingCards: z.array(z.object({ cardName: z.string(), finding: z.string(), suggestion: z.string() })),
  billIncreases: z.array(
    z.object({ merchant: z.string(), previousMonthly: z.number(), latestMonthly: z.number(), note: z.string() }),
  ),
  signupBonusIdeas: z.array(z.object({ idea: z.string(), rationale: z.string() })),
});
export type AdvisorReport = z.infer<typeof AdvisorReport>;

const OWNER: Record<string, LlmOwnerLabel> = { user1: "User 1", user2: "User 2", joint: "Joint" };

function monthsAgo(today: Date, n: number) {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
}

/**
 * Aggregated, sanitized 12-month summary: per-card earn vs fee, spend by
 * category, recurring merchants' monthly amounts. No individual
 * transactions, account numbers or names leave the server.
 */
export async function buildAdvisorPayload(today = new Date()) {
  const from = monthsAgo(today, 12);
  const names = legalNamesFromEnv();
  const [{ cards, audit }, candidates, catalog] = await Promise.all([runRewardsAudit(from), runCatalogComparison(from), listCatalog()]);
  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  const quarter = quarterOf(today.toISOString().slice(0, 10));

  const categories = await db()
    .select({ category: sql<string>`coalesce(${t.category}, 'Uncategorized')`, spend: sql<number>`sum(-${t.amount})::float8` })
    .from(t)
    .innerJoin(financeAccounts, eq(t.accountId, financeAccounts.id))
    .where(and(gte(t.postedDate, from), eq(t.isTransfer, false), eq(financeAccounts.active, true), sql`not ${isIncome}`))
    .groupBy(sql`coalesce(${t.category}, 'Uncategorized')`);

  const month = sql<string>`to_char(${t.postedDate}, 'YYYY-MM')`;
  const recurringRows = await db()
    .select({ merchant: t.merchant, month, spend: sql<number>`sum(-${t.amount})::float8` })
    .from(t)
    .where(and(gte(t.postedDate, monthsAgo(today, 7)), eq(t.isTransfer, false), sql`${t.amount} < 0`, sql`not ${isIncome}`))
    .groupBy(t.merchant, month);
  const byMerchant = new Map<string, { month: string; amount: number }[]>();
  for (const r of recurringRows) byMerchant.set(r.merchant, [...(byMerchant.get(r.merchant) ?? []), { month: r.month, amount: Math.round(Number(r.spend) * 100) / 100 }]);
  const recurring = [...byMerchant.entries()]
    .filter(([, ms]) => ms.length >= 4)
    .map(([merchant, ms]) => ({ merchant, monthly: ms.sort((a, b) => a.month.localeCompare(b.month)) }))
    .slice(0, 40);

  return sanitizePayload({
    period: `${from.slice(0, 7)} to ${today.toISOString().slice(0, 7)}`,
    cards: cards.map((c) => {
      const perf = audit?.perCard.find((p) => p.card === c.name);
      return {
        cardName: scrubText(c.name, names),
        owner: OWNER[c.owner] ?? "Joint",
        annualFee: c.annualFee,
        baseRate: c.baseRate,
        centsPerUnit: c.centsPerUnit,
        bonusRules: c.rules.map((r) => ({ on: `${r.matchType}: ${r.match}`, rate: r.rate, cap: r.capAmount, capPeriod: r.capPeriod })),
        spend12m: perf?.spend ?? 0,
        rewardsValue12m: perf?.earned ?? 0,
        netOfFee12m: perf?.net ?? 0,
        // Published terms on file for this card (catalog), so the advisor need not look them up.
        catalogTerms: (() => {
          const p = c.catalogProductId ? catalogById.get(c.catalogProductId) : undefined;
          if (!p?.terms) return null;
          return {
            product: `${p.issuer} ${p.name}`,
            verifiedDate: p.verifiedAt?.toISOString().slice(0, 10) ?? "not yet verified",
            credits: p.terms.credits.map((x) => ({ label: x.label, amount: x.amount, per: x.period })),
            perks: p.terms.perks,
            rotatingThisQuarter: p.terms.rotating?.quarters.find((q) => q.quarter === quarter)?.description ?? null,
          };
        })(),
      };
    }),
    // Cards the household does not hold, priced in code against its last 12 months of spend.
    candidateCards: candidates.slice(0, 8).map((x) => ({
      card: x.card,
      annualFee: x.annualFee,
      addedRewardsPerYear: x.addedRewards,
      netPerYear: x.netPerYear,
      signupOffer: x.signupOffer ? { ...x.signupOffer, valueUsd: x.signupValue } : null,
      creditsPerYearFaceValue: x.creditsPerYear,
      verifiedDate: x.verifiedAt ?? "not yet verified",
    })),
    pointsLeftOnTable12m: audit?.totalMissed ?? 0,
    missedByCategory: audit?.byCategory.slice(0, 10) ?? [],
    spendByCategory12m: categories
      .map((c) => ({ category: c.category, spend: Math.round(Number(c.spend)) }))
      .filter((c) => c.spend > 0)
      .sort((a, b) => b.spend - a.spend),
    recurringMerchants: recurring,
  });
}

export async function runAdvisor(trigger: "manual" | "monthly", today = new Date()) {
  const payload = await buildAdvisorPayload(today);
  const report = await runStructured({
    tier: "flagship",
    system:
      "You are a careful credit card rewards analyst for a two-person household. Use only the data provided. Be specific and quantitative. Card terms come from the household's stored catalog (catalogTerms, candidateCards) with the date each was last verified; rely on those and do not invent terms. Mention unused statement credits on held cards when relevant.",
    task: [
      "Review DATA and produce:",
      "1. underperformingCards: annual-fee cards whose rewards value does not clearly beat their fee, or that the household barely uses.",
      "2. billIncreases: recurring merchants whose monthly amount went up recently (compare earlier months to the latest).",
      "3. signupBonusIdeas: up to 3 card ideas, chosen from candidateCards (already priced against this household's spending). Quote the sign-up offer and its verifiedDate; say 'verify before applying' if it is older than 30 days or not yet verified.",
      "4. summary: two or three sentences.",
    ].join("\n"),
    payload,
    schema: AdvisorReport,
  });
  const settings = await getAiSettings();
  await db().insert(financeAdvisorReports).values({ trigger, provider: settings.provider, report });
  return report;
}

export async function latestAdvisorReport() {
  const [row] = await db().select().from(financeAdvisorReports).orderBy(desc(financeAdvisorReports.createdAt)).limit(1);
  return row ? { ...row, report: AdvisorReport.parse(row.report) } : null;
}

export async function hasReportForMonth(today: Date) {
  const [row] = await db()
    .select({ id: financeAdvisorReports.id })
    .from(financeAdvisorReports)
    .where(and(eq(financeAdvisorReports.trigger, "monthly"), gte(financeAdvisorReports.createdAt, new Date(monthsAgo(today, 0)))))
    .limit(1);
  return Boolean(row);
}
