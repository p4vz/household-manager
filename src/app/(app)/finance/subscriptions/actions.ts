"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { UnauthorizedError } from "@/core/auth/guard";
import {
  OWNERS,
  SUBSCRIPTION_CADENCES,
  SUBSCRIPTION_STATUSES,
  addManualSubscription,
  deleteSubscription,
  saveDetectedSubscription,
  updateSubscription,
  viewerFromLabel,
} from "@/modules/finance/api";

const PAGE = "/finance/subscriptions";

async function done(anchor: string, work: () => Promise<string>): Promise<never> {
  let message: string;
  try {
    message = await work();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    message = `Couldn't do that: ${e instanceof z.ZodError ? (e.issues[0]?.message ?? "check the form") : e instanceof Error ? e.message : "unknown error"}`;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?m=${encodeURIComponent(message.slice(0, 300))}#${anchor}`);
}

const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : null), z.string().max(max).nullable());
const optMoney = z.preprocess((v) => (blankToNull(v) == null ? null : Number(String(v).replace(/[$,]/g, ""))), z.number().nonnegative().max(1_000_000).nullable());
const optDay = z.preprocess(blankToNull, z.iso.date().nullable());
const fields = (form: FormData, names: string[]) => Object.fromEntries(names.map((n) => [n, form.get(n)]));

const Details = z.object({
  name: z.string().trim().min(1).max(80),
  owner: z.enum(OWNERS),
  amount: optMoney,
  cadence: z.enum(SUBSCRIPTION_CADENCES),
  nextCharge: optDay,
  notes: optText(500),
});
const DETAIL_FIELDS = ["name", "owner", "amount", "cadence", "nextCharge", "notes"];

const add = authedAction(Details, async (input, user) => {
  await addManualSubscription(viewerFromLabel(user.owner), input);
  return `Added ${input.name}.`;
});
export async function addSubscriptionFormAction(form: FormData) {
  return done("add", () => add(fields(form, DETAIL_FIELDS)));
}

/** Saves a row: a stored one by id, or a detected one (confirming it) by owner and merchant. */
const save = authedAction(
  Details.extend({ id: z.preprocess(blankToNull, z.uuid().nullable()), merchantKey: optText(200), status: z.enum(SUBSCRIPTION_STATUSES) }),
  async ({ id, merchantKey, status, ...input }, user) => {
    const viewer = viewerFromLabel(user.owner);
    if (id) await updateSubscription(viewer, id, { ...input, status });
    else if (merchantKey) await saveDetectedSubscription(viewer, { owner: input.owner, merchantKey }, { ...input, status });
    else throw new Error("Nothing to save");
    return status === "ignored" ? `Hid ${input.name}: not a subscription.` : status === "cancelled" ? `Marked ${input.name} cancelled.` : `Saved ${input.name}.`;
  },
);
export async function saveSubscriptionFormAction(form: FormData) {
  return done("list", () => save(fields(form, [...DETAIL_FIELDS, "id", "merchantKey", "status"])));
}

const remove = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await deleteSubscription(viewerFromLabel(user.owner), id);
  return "Removed. A charge that still repeats will show up again as detected.";
});
export async function deleteSubscriptionFormAction(form: FormData) {
  return done("list", () => remove(fields(form, ["id"])));
}
