"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { UnauthorizedError } from "@/core/auth/guard";
import { householdToday } from "@/modules/family/ui/dates";
import {
  NET_WORTH_ITEM_KINDS,
  OWNERS,
  addNetWorthItem,
  deleteNetWorthItem,
  setNetWorthValue,
  updateNetWorthItem,
  viewerFromLabel,
} from "@/modules/finance/api";

const PAGE = "/finance/net-worth";

async function done(work: () => Promise<string>): Promise<never> {
  let message: string;
  try {
    message = await work();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    message = `Couldn't do that: ${e instanceof z.ZodError ? (e.issues[0]?.message ?? "check the form") : e instanceof Error ? e.message : "unknown error"}`;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?m=${encodeURIComponent(message.slice(0, 300))}#items`);
}

const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : null), z.string().max(max).nullable());
const optDay = z.preprocess(blankToNull, z.iso.date().nullable());
const value = z.preprocess((v) => Number(String(v ?? "").replace(/[$,]/g, "")), z.number().nonnegative().max(1e10));
const fields = (form: FormData, names: string[]) => Object.fromEntries(names.map((n) => [n, form.get(n)]));

const Item = z.object({
  owner: z.enum(OWNERS),
  kind: z.enum(NET_WORTH_ITEM_KINDS),
  name: z.string().trim().min(1).max(80),
  acquiredOn: optDay,
  closedOn: optDay,
  notes: optText(500),
});
const ITEM_FIELDS = ["owner", "kind", "name", "acquiredOn", "closedOn", "notes"];

const add = authedAction(Item.extend({ value, asOf: optDay }), async ({ value, asOf, ...item }, user) => {
  await addNetWorthItem(viewerFromLabel(user.owner), item, value, asOf ?? householdToday());
  return `Added ${item.name}.`;
});
export async function addItemFormAction(form: FormData) {
  return done(() => add(fields(form, [...ITEM_FIELDS, "value", "asOf"])));
}

const edit = authedAction(Item.extend({ id: z.uuid() }), async ({ id, ...item }, user) => {
  await updateNetWorthItem(viewerFromLabel(user.owner), id, item);
  return `Saved ${item.name}.`;
});
export async function updateItemFormAction(form: FormData) {
  return done(() => edit(fields(form, [...ITEM_FIELDS, "id"])));
}

const revalue = authedAction(z.object({ id: z.uuid(), value, asOf: optDay }), async ({ id, value, asOf }, user) => {
  await setNetWorthValue(viewerFromLabel(user.owner), id, value, asOf ?? householdToday());
  return "Value updated. The old one stays in the history.";
});
export async function setValueFormAction(form: FormData) {
  return done(() => revalue(fields(form, ["id", "value", "asOf"])));
}

const remove = authedAction(z.object({ id: z.uuid() }), async ({ id }, user) => {
  await deleteNetWorthItem(viewerFromLabel(user.owner), id);
  return "Removed.";
});
export async function deleteItemFormAction(form: FormData) {
  return done(() => remove(fields(form, ["id"])));
}
