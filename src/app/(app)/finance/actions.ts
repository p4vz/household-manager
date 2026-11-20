"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authedAction } from "@/core/actions/authed-action";
import {
  ACCOUNT_KINDS,
  OWNERS,
  commitCsvImport,
  connectSimplefin,
  previewCsvImport,
  updateAccount,
} from "@/modules/finance/api";

const MAX_CSV_CHARS = 14 * 1024 * 1024;

const connect = authedAction(z.object({ token: z.string().min(20).max(2000) }), ({ token }) =>
  connectSimplefin(token),
);

export async function connectSimplefinAction(_prev: unknown, form: FormData) {
  try {
    const result = await connect({ token: form.get("token") });
    revalidatePath("/finance");
    return { ok: true as const, result };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not connect" };
  }
}

const AccountInput = z.object({
  id: z.uuid(),
  displayName: z.string().max(80).nullable(),
  owner: z.enum(OWNERS),
  kind: z.enum(ACCOUNT_KINDS),
  active: z.boolean(),
});

const saveAccount = authedAction(AccountInput, ({ id, ...patch }) => updateAccount(id, patch));

export async function updateAccountAction(form: FormData) {
  await saveAccount({
    id: form.get("id"),
    displayName: (form.get("displayName") as string | null) || null,
    owner: form.get("owner"),
    kind: form.get("kind"),
    active: form.get("active") === "on",
  });
  revalidatePath("/finance/accounts");
}

export const previewCsvAction = authedAction(z.object({ text: z.string().max(MAX_CSV_CHARS) }), async ({ text }) => {
  try {
    return { ok: true as const, preview: await previewCsvImport(text) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not read the file" };
  }
});

export const commitCsvAction = authedAction(
  z.object({
    text: z.string().max(MAX_CSV_CHARS),
    mapping: z.record(z.string(), z.union([z.uuid(), z.literal("new"), z.literal("skip")])),
  }),
  async ({ text, mapping }) => {
    const result = await commitCsvImport(text, mapping);
    revalidatePath("/finance");
    return result;
  },
);
