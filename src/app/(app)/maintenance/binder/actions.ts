"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import { UnauthorizedError } from "@/core/auth/guard";
import { viewerFromLabel } from "@/modules/finance/api";
import {
  BINDER_CATEGORIES,
  BINDER_PAGE,
  MAX_BINDER_FILE_BYTES,
  addBinderEntry,
  deleteBinderEntry,
  openBinderFile,
  updateBinderEntry,
  type BinderFile,
} from "@/modules/maintenance/api";

/** Home binder actions. Each reports back through ?m= and jumps to the entry. */

function refresh() {
  revalidatePath(BINDER_PAGE);
  revalidatePath("/maintenance");
  revalidatePath("/kiosk");
  revalidatePath("/family");
}

async function done(anchor: string, work: () => Promise<string | { message: string; anchor: string }>): Promise<never> {
  let message: string;
  try {
    const out = await work();
    if (typeof out === "string") message = out;
    else ({ message, anchor } = out);
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    message = `Couldn't do that: ${e instanceof z.ZodError ? (e.issues[0]?.message ?? "check the form") : e instanceof Error ? e.message : "unknown error"}`;
  }
  refresh();
  redirect(`${BINDER_PAGE}?m=${encodeURIComponent(message.slice(0, 300))}#${anchor}`);
}

const blankToNull = (v: unknown) => (v === "" || v == null ? null : v);
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : null), z.string().max(max).nullable());
const optDay = z.preprocess(blankToNull, z.iso.date().nullable());
const optId = z.preprocess(blankToNull, z.uuid().nullable());
const optMoney = z.preprocess((v) => (blankToNull(v) == null ? null : Number(String(v).replace(/[$,]/g, ""))), z.number().nonnegative().nullable());
const optUrl = z.preprocess(blankToNull, z.url({ protocol: /^https?$/ }).max(500).nullable());

const EntryInput = z.object({
  category: z.enum(BINDER_CATEGORIES),
  title: z.string().trim().min(1).max(120),
  provider: optText(120),
  assetId: optId,
  projectId: optId,
  startsOn: optDay,
  expiresOn: optDay,
  amount: optMoney,
  url: optUrl,
  notes: optText(2000),
});
const FIELDS = ["category", "title", "provider", "assetId", "projectId", "startsOn", "expiresOn", "amount", "url", "notes"];
const fields = (form: FormData, names: string[]) => Object.fromEntries(names.map((n) => [n, form.get(n)]));

async function fileFrom(form: FormData): Promise<BinderFile | null> {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  if (f.size > MAX_BINDER_FILE_BYTES) throw new Error("That file is larger than 8 MB. Store a compressed scan instead.");
  return { fileName: f.name, mediaType: f.type, bytes: Buffer.from(await f.arrayBuffer()) };
}

const add = authedAction(EntryInput, async (input, user) => {
  return { input, addedBy: viewerFromLabel(user.owner) };
});
export async function addEntryFormAction(form: FormData) {
  return done("add", async () => {
    const { input, addedBy } = await add(fields(form, FIELDS));
    const id = await addBinderEntry(input, await fileFrom(form), addedBy);
    return { message: `Filed "${input.title}".`, anchor: `doc-${id}` };
  });
}

const edit = authedAction(EntryInput.extend({ id: z.uuid() }), async (input) => input);
export async function updateEntryFormAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  return done(`doc-${id}`, async () => {
    const { id: entryId, ...patch } = await edit(fields(form, [...FIELDS, "id"]));
    await updateBinderEntry(entryId, patch, await fileFrom(form));
    return `Saved "${patch.title}".`;
  });
}

const remove = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await deleteBinderEntry(id);
  return "Removed from the binder.";
});
export async function deleteEntryFormAction(form: FormData) {
  return done("list", () => remove(fields(form, ["id"])));
}

/** Decrypts one file for download (called from the Download button). */
export const openEntryFileAction = authedAction(z.object({ id: z.uuid() }), ({ id }) => openBinderFile(id));
