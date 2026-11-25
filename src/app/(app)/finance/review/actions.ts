"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { answerLargePurchase } from "@/assistant/review";
import { authedAction } from "@/core/actions/authed-action";
import { UnauthorizedError, type HouseholdUser } from "@/core/auth/guard";
import {
  ACCOUNT_KINDS,
  applyCategoryMapping,
  categorizeUncategorized,
  deactivateAccountForReview,
  dismissLargePurchasesAt,
  largeThreshold,
  mergeImportedAccount,
  parsePair,
  proposeCategoriesWithAi,
  recordLargePurchaseAnswer,
  removeDuplicateCopies,
  renameAccountForReview,
  reopenLargePurchase,
  setLargeThreshold,
  undoReviewAction,
  viewerFromLabel,
} from "@/modules/finance/api";

/** The Finance review page's actions. Each one reports back through ?m= and jumps to its step. */

const as = (user: HouseholdUser) => viewerFromLabel(user.owner);
const PAGE = "/finance/review";

async function done(anchor: string, work: () => Promise<string>): Promise<never> {
  let message: string;
  try {
    message = await work();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    message = `Couldn't do that: ${e instanceof Error ? e.message : "unknown error"}`;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?m=${encodeURIComponent(message.slice(0, 300))}#${anchor}`);
}

// ---------------------------------------------------------------- step 1 ----

const merge = authedAction(z.object({ fromId: z.uuid(), intoId: z.uuid() }), async ({ fromId, intoId }, user) =>
  (await mergeImportedAccount(as(user), fromId, intoId)).summary,
);
export async function mergeAccountAction(form: FormData) {
  return done("reconcile", () => merge({ fromId: form.get("fromId"), intoId: form.get("intoId") }));
}

const dupes = authedAction(z.object({ ids: z.array(z.uuid()).max(5000) }), async ({ ids }, user) => (await removeDuplicateCopies(as(user), ids)).summary);
export async function removeDuplicatesAction(form: FormData) {
  return done("reconcile", () => dupes({ ids: form.getAll("csvId") }));
}

const rename = authedAction(
  z.object({ id: z.uuid(), displayName: z.string().max(80), kind: z.enum(ACCOUNT_KINDS) }),
  async ({ id, displayName, kind }, user) => (await renameAccountForReview(as(user), id, displayName, kind)).summary,
);
export async function renameAccountAction(form: FormData) {
  return done("reconcile", () => rename({ id: form.get("id"), displayName: form.get("displayName") ?? "", kind: form.get("kind") }));
}

const deactivate = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => (await deactivateAccountForReview(as(user), id)).summary);
export async function deactivateAccountAction(form: FormData) {
  return done("reconcile", () => deactivate({ id: form.get("id") }));
}

const undo = authedAction(z.object({ id: z.uuid() }), ({ id }, user) => undoReviewAction(as(user), id));
export async function undoReviewChangeAction(form: FormData) {
  return done("log", () => undo({ id: form.get("id") }));
}

// ---------------------------------------------------------------- step 2 ----

const propose = authedAction(z.object({}), async (_i, user) => {
  const r = await proposeCategoriesWithAi(as(user));
  return r.asked ? `Claude suggested categories for ${r.answered} of ${r.asked}. Check them below, then Apply.` : "Every category already has a suggestion.";
});
export async function proposeCategoriesAction() {
  return done("categories", () => propose({}));
}

const Pair = z.object({ category: z.string().max(60).nullable(), subcategory: z.string().max(60).nullable() });
const apply = authedAction(z.object({ rows: z.array(z.object({ from: Pair, to: Pair })).max(2000) }), async ({ rows }, user) =>
  (await applyCategoryMapping(as(user), rows)).summary,
);
export async function applyCategoriesAction(form: FormData) {
  const rows: { from: unknown; to: unknown }[] = [];
  for (const key of form.keys()) {
    const m = /^row-(\d+)$/.exec(key);
    if (!m || form.get(`use-${m[1]}`) !== "on") continue;
    const to = parsePair(String(form.get(`to-${m[1]}`) ?? ""));
    if (!to) continue;
    try {
      rows.push({ from: JSON.parse(String(form.get(key))), to });
    } catch {
      // A tampered row is skipped.
    }
  }
  return done("categories", () => apply({ rows }));
}

const categorize = authedAction(z.object({}), async () => {
  const r = await categorizeUncategorized();
  if (!r.categorized && !r.corrected) return "Nothing left to categorize.";
  const parts = [`Categorized ${r.categorized} transactions (${r.fromHistory} from your history, ${r.byAi} by Claude)`];
  if (r.corrected) parts.push(`corrected ${r.corrected} earlier guesses`);
  if (r.undecided) parts.push(`${r.undecided} left for you`);
  return `${parts.join(", ")}.`;
});
export async function categorizeUncategorizedAction() {
  return done("categories", () => categorize({}));
}

// ---------------------------------------------------------------- step 3 ----

const threshold = authedAction(z.object({ amount: z.coerce.number().min(50).max(100_000) }), async ({ amount }, user) => {
  const v = await setLargeThreshold(as(user), amount);
  return `Showing purchases of $${v.toLocaleString("en-US")} or more.`;
});
export async function setThresholdAction(form: FormData) {
  return done("large", () => threshold({ amount: form.get("amount") }));
}

const answer = authedAction(z.object({ id: z.uuid(), answer: z.string().trim().min(1).max(500) }), async ({ id, answer }, user) =>
  (await answerLargePurchase(user, id, answer)).summary,
);
export async function answerPurchaseAction(form: FormData) {
  return done("large", () => answer({ id: form.get("id"), answer: form.get("answer") ?? "" }));
}

const skip = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await recordLargePurchaseAnswer(as(user), id, "dismissed", null, null);
  return "Skipped.";
});
export async function skipPurchaseAction(form: FormData) {
  return done("large", () => skip({ id: form.get("id") }));
}

const skipMerchant = authedAction(z.object({ merchant: z.string().min(1).max(200) }), async ({ merchant }, user) => {
  const n = await dismissLargePurchasesAt(as(user), merchant, await largeThreshold(as(user)));
  return `Skipped ${n} ${n === 1 ? "purchase" : "purchases"} at ${merchant}.`;
});
export async function skipMerchantAction(form: FormData) {
  return done("large", () => skipMerchant({ merchant: form.get("merchant") }));
}

const reopen = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await reopenLargePurchase(as(user), id);
  return "It's back in the list. Edits already made stay in Ask Claude's change history, where they can be undone.";
});
export async function reopenPurchaseAction(form: FormData) {
  return done("large", () => reopen({ id: form.get("id") }));
}
