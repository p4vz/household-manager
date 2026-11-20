import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runWebResearch, type WebSource } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import { db } from "@/core/db/client";
import { financeCardCatalog, financeCardCatalogChanges } from "../../schema";
import { householdTimeZone, localHour } from "../../ingest/schedule";
import { ensureCatalogSeeded, getCatalogProduct, heldProductIds, listCatalog, writeTerms, type CatalogProduct } from "./store";
import { CardTerms, diffTerms, mergeRotating, nextQuarter, quarterOf, quarterBounds, type TermsChange } from "./terms";

/** The refresh runs once a day in this household-time hour. */
export const REFRESH_HOUR = 6;
/** At most this many cards per daily run (each is two AI calls with web search). */
export const MAX_PER_RUN = 6;

const DAY = 86_400_000;

/**
 * When a card is due for a check:
 * - never checked against a source (seed or added by name): now
 * - held by the household: weekly
 * - not held: monthly
 * - rotating-category cards: every 2 days while the current quarter's
 *   categories are unknown, or the next quarter's within 3 weeks of it
 * - after a failed check: not again for a day
 */
export function isDue(p: Pick<CatalogProduct, "status" | "checkedAt" | "lastError" | "terms">, held: boolean, now: Date): boolean {
  const age = p.checkedAt ? now.getTime() - p.checkedAt.getTime() : Infinity;
  if (p.lastError && age < DAY) return false;
  if (p.status !== "verified") return true;
  if (age >= (held ? 7 : 30) * DAY) return true;
  if (p.terms?.rotating && rotatingGap(p.terms, now) && age >= 2 * DAY) return true;
  return false;
}

/** The quarter whose rotating categories we still need, if any. */
export function rotatingGap(terms: CardTerms, now: Date): string | null {
  if (!terms.rotating) return null;
  const today = now.toISOString().slice(0, 10);
  const known = new Set(terms.rotating.quarters.map((q) => q.quarter));
  const current = quarterOf(today);
  if (!known.has(current)) return current;
  const next = nextQuarter(current);
  const daysLeft = (Date.parse(quarterBounds(current).to) - Date.parse(today)) / DAY;
  return daysLeft <= 21 && !known.has(next) ? next : null;
}

export const RefreshAnswer = z.object({
  /** False when the issuer no longer offers the card or nothing reliable was found. */
  found: z.boolean(),
  terms: CardTerms,
  /** Pages the facts came from (issuer pages preferred). */
  sourceUrls: z.array(z.string()).max(10),
  /** Short note on anything uncertain. */
  caveats: z.string().max(400).nullable(),
});

/** Host (or Gemini's grounding title, which is the domain) under one of `domains`. */
export function issuerSources(sources: (WebSource | string)[], domains: string[]): string[] {
  const ok = (host: string) => domains.some((d) => host === d || host.endsWith(`.${d}`));
  const out = new Set<string>();
  for (const s of sources) {
    const url = typeof s === "string" ? s : s.url;
    const title = typeof s === "string" ? null : s.title;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (ok(host) || (title && ok(title.trim().toLowerCase()))) out.add(url);
  }
  return [...out];
}

/**
 * Changes big enough that a person should confirm them before they replace
 * stored terms: a fee moving by more than $100, a different base rate, or
 * most multipliers disappearing at once. Those are real but rare, and are
 * also what a bad search result looks like.
 */
export function suspiciousReason(before: CardTerms | null, after: CardTerms): string | null {
  if (!before) return null;
  if (Math.abs(after.annualFee - before.annualFee) > 100) return `Annual fee ${before.annualFee} → ${after.annualFee}`;
  if (after.baseRate !== before.baseRate) return `Base rate ${before.baseRate} → ${after.baseRate}`;
  if (before.multipliers.length >= 2 && after.multipliers.length < before.multipliers.length / 2) return "Most bonus categories missing";
  return null;
}

const SYSTEM =
  "You keep a household's reference copy of US credit card terms current. Use the card issuer's own pages as the source of truth. Report only what the sources say, as of today. Never guess numbers; if something cannot be confirmed, keep the value from CURRENT and say so in caveats.";

function taskFor(p: CatalogProduct, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const quarters = [quarterOf(today), nextQuarter(quarterOf(today))];
  return [
    `Look up the current public terms of the ${p.issuer} ${p.name} credit card (US, personal).`,
    "Return terms with:",
    "- annualFee, baseRate (points per dollar, or percent for cash back), rewardType, rewardCurrency, foreignTransactionFee.",
    "- multipliers: each bonus category as { on, rate, capAmount, capPeriod, note }. `on` must be one of: dining, groceries, gas, ev_charging, travel, flights, hotels, car_rental, transit, streaming, entertainment, drugstores, home_improvement, utilities, online_shopping, or merchant:<Name> for one merchant. Put portal-only bonuses (e.g. 'booked through Chase Travel') in perks, not multipliers.",
    `- rotating: for quarterly 5% programs, the categories for ${quarters.join(" and ")} where announced (quarter as YYYY-Qn). null if the card has none.`,
    "- signupOffer: the current public welcome offer (bonus in points/miles, or dollars for cash back; minSpend; windowMonths; extras; endDate if stated). null if none.",
    "- credits: statement credits with dollar amount and period. perks: other notable benefits, short.",
    "- pointValueCents: keep CURRENT's value unless it is plain cash back (1).",
    "- sourceUrls: the pages you used.",
    "Set found=false if the card is no longer offered or you found no reliable source.",
  ].join("\n");
}

export type RefreshResult =
  | { productId: string; status: "unchanged" | "applied" | "pending"; changes: TermsChange[] }
  | { productId: string; status: "error"; error: string };

export async function refreshCatalogProduct(productId: string, now = new Date()): Promise<RefreshResult> {
  const product = await getCatalogProduct(productId);
  if (!product) return { productId, status: "error", error: "Unknown card" };
  const fail = async (error: string): Promise<RefreshResult> => {
    await db().update(financeCardCatalog).set({ checkedAt: now, lastError: error }).where(eq(financeCardCatalog.id, productId));
    return { productId, status: "error", error };
  };

  let answer: z.infer<typeof RefreshAnswer>;
  let sources: WebSource[];
  try {
    const res = await runWebResearch({
      tier: "flagship",
      system: SYSTEM,
      task: taskFor(product, now),
      // Public product names and public terms only; nothing about the household.
      payload: sanitizePayload({ card: `${product.issuer} ${product.name}`, asOfDate: now.toISOString().slice(0, 10), current: product.terms }),
      schema: RefreshAnswer,
      allowedDomains: product.sourceDomains.length ? product.sourceDomains : undefined,
      maxSearches: 5,
    });
    answer = res.output;
    sources = res.sources;
  } catch (err) {
    return fail(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  }

  const domains = product.sourceDomains;
  const trusted = domains.length ? issuerSources([...sources, ...answer.sourceUrls], domains) : answer.sourceUrls;
  if (!answer.found) return fail(answer.caveats ?? "Card not found");
  if (trusted.length === 0) return fail(`No source from ${domains.join(", ") || "the issuer"} was found`);

  const next: CardTerms = { ...answer.terms, rotating: mergeRotating(product.terms?.rotating ?? null, answer.terms.rotating) };
  const changes = diffTerms(product.terms, next);

  if (changes.length === 0) {
    await db()
      .update(financeCardCatalog)
      .set({ status: "verified", verifiedAt: now, checkedAt: now, lastError: null, sourceUrls: trusted })
      .where(eq(financeCardCatalog.id, productId));
    return { productId, status: "unchanged", changes };
  }

  const hold = product.editedBy === "user" ? "You edited this card's terms; confirm before replacing them" : suspiciousReason(product.terms, next);
  if (hold) {
    // One open proposal per card: a newer finding replaces an older one.
    await db()
      .delete(financeCardCatalogChanges)
      .where(and(eq(financeCardCatalogChanges.productId, productId), eq(financeCardCatalogChanges.status, "pending")));
    await db().insert(financeCardCatalogChanges).values({
      productId,
      detectedAt: now,
      version: product.version + 1,
      changes,
      proposed: next,
      sourceUrls: trusted,
      status: "pending",
      reason: hold,
    });
    await db().update(financeCardCatalog).set({ checkedAt: now, lastError: null }).where(eq(financeCardCatalog.id, productId));
    return { productId, status: "pending", changes };
  }

  await writeTerms(product, next, { editedBy: "refresh", sourceUrls: trusted, verified: true, now });
  await db().update(financeCardCatalog).set({ checkedAt: now }).where(eq(financeCardCatalog.id, productId));
  await db().insert(financeCardCatalogChanges).values({
    productId,
    detectedAt: now,
    version: product.version + 1,
    changes,
    proposed: next,
    sourceUrls: trusted,
    status: "applied",
    // A seed card's first check is a verification, not news.
    seen: product.status === "seed",
  });
  return { productId, status: "applied", changes };
}

/** Cards due for a check, held cards first, then the longest unchecked. */
export async function dueCatalogProducts(now = new Date()) {
  const [products, held] = await Promise.all([listCatalog(), heldProductIds()]);
  return products
    .filter((p) => isDue(p, held.has(p.id), now))
    .sort((a, b) => Number(held.has(b.id)) - Number(held.has(a.id)) || (a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0));
}

/** Daily cron slot. Checks up to MAX_PER_RUN due cards, one at a time. */
export async function runCatalogRefreshIfDue(now = new Date()) {
  if (localHour(now, householdTimeZone()) !== REFRESH_HOUR) return { status: "skipped" as const, reason: "Not the refresh slot" };
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return { status: "skipped" as const, reason: "No AI provider key configured" };
  await ensureCatalogSeeded();
  const due = (await dueCatalogProducts(now)).slice(0, MAX_PER_RUN);
  const results: RefreshResult[] = [];
  for (const p of due) results.push(await refreshCatalogProduct(p.id, now));
  return { status: "ok" as const, checked: results.length, results };
}
