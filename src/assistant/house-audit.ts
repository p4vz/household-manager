import "server-only";
import { z } from "zod";
import { runStructured } from "@/core/ai/run";
import { sanitizePayload } from "@/core/ai/sanitize";
import type { HouseholdUser } from "@/core/auth/guard";
import * as finance from "@/modules/finance/api";
import * as maintenance from "@/modules/maintenance/api";
import { DraftBook, recordChangeset } from "./changesets";
import { contextFor } from "./service";

/**
 * The house audit: keeps expenses and the house history in step, on demand
 * ("Run audit" on Home maintenance) and every week from the bank-sync cron.
 *
 * 1. Each house project with a date and amount is matched to the payment
 *    that paid for it (same amount within $1, within 60 days; the vendor's
 *    name breaks ties). A unique match is linked and leaves the tracker.
 * 2. Open questionable transactions (likely house spending, uncategorized)
 *    go to Claude in one batch: date, merchant, amount and category only.
 *    Its guesses ("house expense: gutter repair") wait in the tracker for
 *    the member to confirm. Cash withdrawals are always asked, never guessed.
 *
 * Runs per member over the accounts that member can see.
 */

export const AUDIT_EVERY_DAYS = 7;
const AI_BATCH = 80;

const Guess = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      houseRelated: z.boolean(),
      title: z.string().nullable().describe("Short name for the house work or purchase, e.g. 'Gutter repair'"),
      area: z.string().nullable().describe("e.g. HVAC & heating, Plumbing, Exterior & stormwater, Appliances, Yard, or Vehicles for car upkeep"),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const GUESS_SYSTEM =
  "You help a household keep a history of work done on their house. For each transaction, decide whether it was spending on the house itself: repairs, maintenance, renovation, appliances, yard, utilities work, contractors, hardware stores. Car upkeep counts too (area Vehicles): oil changes, repairs, tires, parts, inspections, registration and DMV fees; fuel, parking, tolls, car washes, insurance and car payments do not. Groceries, dining, shopping for people, travel and subscriptions are not. Use only the merchant, amount, date and category given.";

export type AuditResult = { matched: number; unmatched: string[]; guessed: number; houseLike: number; cashOpen: number; note: string };

async function matchProjects(viewer: finance.Viewer) {
  const projects = await maintenance.listProjects();
  const linked = new Set(projects.map((p) => p.transactionId).filter((x): x is string => Boolean(x)));
  let matched = 0;
  const unmatched: string[] = [];
  for (const p of projects) {
    if (p.transactionId || p.amount == null || !p.date) continue;
    const near = (await finance.paymentsNear(viewer, p.amount, p.date, 60)).filter((x) => !linked.has(x.id));
    const word = (p.vendor ?? "").toLowerCase().match(/[a-z]{4,}/)?.[0];
    const byVendor = word ? near.filter((x) => x.merchant.toLowerCase().includes(word)) : [];
    const pick = byVendor.length === 1 ? byVendor[0] : near.length === 1 ? near[0] : null;
    if (!pick) {
      unmatched.push(p.title);
      continue;
    }
    await maintenance.updateProject(p.id, { transactionId: pick.id });
    linked.add(pick.id);
    await finance.recordLargePurchaseAnswer(viewer, pick.id, "answered", null, { summary: `Matched to house project "${p.title}"`, changesetId: null });
    matched++;
  }
  return { matched, unmatched, linked: [...linked] };
}

export async function runHouseAudit(viewer: finance.Viewer, now = new Date(), opts: { useAi?: boolean } = {}): Promise<AuditResult> {
  const { matched, unmatched, linked } = await matchProjects(viewer);
  const open = await finance.houseQuestions(viewer, { linkedIds: linked, limit: 200 });
  const cashOpen = open.rows.filter((r) => r.kind === "cash").length;
  const toGuess = open.rows.filter((r) => r.kind !== "cash" && !r.suggestion).slice(0, AI_BATCH);
  let guessed = 0;
  let houseLike = 0;
  let aiNote = "";
  if (toGuess.length && opts.useAi !== false) {
    try {
      const answer = await runStructured({
        tier: "fast",
        system: GUESS_SYSTEM,
        task: "For every transaction, return its id, whether it was spending on the house, a short title for the work, the area of the house, and your confidence.",
        payload: sanitizePayload({
          transactions: toGuess.map((r, id) => ({ id, date: r.date, merchant: r.merchant, amount: r.amount, category: finance.formatPair(r) })),
        }),
        schema: Guess,
      });
      const items = answer.items
        .filter((a) => toGuess[a.id])
        .map((a) => ({
          transactionId: toGuess[a.id].id,
          suggestion: {
            houseRelated: a.houseRelated,
            title: a.title?.trim().slice(0, 80) || null,
            area: a.area?.trim().slice(0, 60) || null,
            confidence: a.confidence,
          },
        }));
      await finance.saveHouseSuggestions(viewer, items);
      guessed = items.length;
      houseLike = items.filter((i) => i.suggestion.houseRelated).length;
    } catch (e) {
      aiNote = ` Claude couldn't review new transactions (${e instanceof Error ? e.message.slice(0, 120) : "error"}).`;
    }
  }
  const note =
    `Matched ${matched} house ${matched === 1 ? "project" : "projects"} to payments` +
    (unmatched.length ? `; ${unmatched.length} without a matching payment` : "") +
    `. Claude looked at ${guessed} new ${guessed === 1 ? "transaction" : "transactions"} and thinks ${houseLike} ${houseLike === 1 ? "is" : "are"} house spending.` +
    (cashOpen ? ` ${cashOpen} cash ${cashOpen === 1 ? "withdrawal needs" : "withdrawals need"} an answer.` : "") +
    aiNote;
  await finance.setHouseAuditState(viewer, now, note);
  return { matched, unmatched, guessed, houseLike, cashOpen, note };
}

/** Weekly, from the bank-sync cron: each member whose last audit is older than a week. */
export async function runHouseAuditIfDue(now = new Date()) {
  const ran: finance.Viewer[] = [];
  for (const viewer of finance.VIEWERS) {
    const { at } = await finance.houseAuditState(viewer);
    if (at && now.getTime() - at.getTime() < AUDIT_EVERY_DAYS * 86_400_000) continue;
    try {
      await runHouseAudit(viewer, now);
      ran.push(viewer);
    } catch (e) {
      console.warn(`[house-audit] ${viewer}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  return ran;
}

// ------------------------------------------------- tracker answers ----

/** Adds a transaction to the house history as a project (undoable in Ask Claude history). */
export async function addTransactionToHouse(user: HouseholdUser, transactionId: string, title: string, now = new Date(), vehicleId: string | null = null) {
  const ctx = contextFor(user, now);
  const txn = await finance.reviewTransaction(ctx.viewer, transactionId);
  const name = title.trim().slice(0, 120) || txn.merchant;
  const vehicle = vehicleId ? await maintenance.getAsset(vehicleId) : null;
  if (vehicleId && vehicle?.kind !== "vehicle") throw new Error("Car not found");
  const drafts = new DraftBook();
  drafts.add({
    entity: "house_project",
    op: "create",
    key: null,
    label: `${name} (${txn.date})`,
    before: null,
    after: {
      date: txn.date,
      period: null,
      title: name,
      vendor: txn.merchant,
      description: txn.notes,
      amount: Math.abs(txn.amount),
      amountNote: null,
      transactionId,
      ...(vehicle && { assetId: vehicle.id }),
    },
  });
  const changesetId = await recordChangeset(ctx, null, `${vehicle ? `${vehicle.name} history` : "House history"}: ${name}`, drafts.drafts);
  const summary = vehicle ? `Added "${name}" to ${vehicle.name}'s service history.` : `Added "${name}" to the house history.`;
  await finance.recordLargePurchaseAnswer(ctx.viewer, transactionId, "answered", null, { summary, changesetId });
  return summary;
}

/** Links a transaction to a house project that has no payment yet. */
export async function linkTransactionToProject(user: HouseholdUser, transactionId: string, projectId: string) {
  const ctx = contextFor(user);
  await finance.reviewTransaction(ctx.viewer, transactionId);
  const p = await maintenance.getProject(projectId);
  if (!p) throw new Error("Project not found");
  if (p.transactionId && p.transactionId !== transactionId) throw new Error(`"${p.title}" is already linked to a payment`);
  await maintenance.updateProject(projectId, { transactionId });
  const summary = `Linked to house project "${p.title}".`;
  await finance.recordLargePurchaseAnswer(ctx.viewer, transactionId, "answered", null, { summary, changesetId: null });
  return summary;
}

/** Gives a questionable transaction a category (from the review's category set). */
export async function categorizeQuestion(user: HouseholdUser, transactionId: string, pairText: string) {
  const ctx = contextFor(user);
  const pair = finance.parsePair(pairText);
  if (!pair?.category || !finance.PARENTS.includes(pair.category as (typeof finance.PARENTS)[number])) {
    throw new Error("Pick a category from the list");
  }
  await finance.updateTransactionFields(ctx.viewer, transactionId, { category: pair.category, subcategory: pair.subcategory });
  const summary = `Categorized as ${finance.formatPair(pair)}.`;
  await finance.recordLargePurchaseAnswer(ctx.viewer, transactionId, "answered", null, { summary, changesetId: null });
  return summary;
}
