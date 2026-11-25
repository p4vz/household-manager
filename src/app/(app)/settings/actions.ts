"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { requireUser } from "@/core/auth/guard";
import { AiSettingsSchema } from "@/core/ai/settings";
import { saveAiSettings } from "@/core/ai/store";
import { z } from "zod";
import { createPairingCode, revokeKioskDevice } from "@/core/kiosk/devices";
import { formatPairingCode } from "@/core/kiosk/pairing";
import { revokeAllConnections, revokeConnection, setConnectionPermissions } from "@/core/oauth/server";
import { connectSimplefin, disconnectSimplefin, syncSimplefinNow } from "@/modules/finance/api";

const save = authedAction(AiSettingsSchema, async (settings) => {
  await saveAiSettings(settings);
});

export async function saveAiSettingsAction(form: FormData) {
  await save({
    provider: form.get("provider"),
    models: {
      gemini: { fast: form.get("gemini.fast"), flagship: form.get("gemini.flagship") },
      anthropic: { fast: form.get("anthropic.fast"), flagship: form.get("anthropic.flagship") },
    },
  });
  revalidatePath("/settings");
}

const disconnect = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await revokeConnection(id);
});

export async function disconnectAssistantAction(form: FormData) {
  await disconnect({ id: form.get("id") });
  revalidatePath("/settings");
}

const disconnectAll = authedAction(z.object({}), async () => {
  await revokeAllConnections();
});

export async function disconnectAllAssistantsAction() {
  await disconnectAll({});
  revalidatePath("/settings");
}

const savePermissions = authedAction(
  z.object({ id: z.uuid(), perm: z.array(z.string().max(60)).max(50) }),
  async ({ id, perm }) => {
    await setConnectionPermissions(id, perm);
  },
);

export async function saveAssistantPermissionsAction(form: FormData) {
  await savePermissions({ id: form.get("id"), perm: form.getAll("perm").filter((v) => typeof v === "string") });
  revalidatePath("/settings");
}

// ---- Kitchen kiosk ----

export const makeKioskPairingCodeAction = authedAction(z.object({}), async (_input, user) => {
  const { code, expiresAt } = await createPairingCode(user.owner);
  return { code: formatPairingCode(code), expiresAt: expiresAt.toISOString() };
});

const unpair = authedAction(z.object({ id: z.uuid() }), async ({ id }) => {
  await revokeKioskDevice(id);
});

export async function unpairKioskAction(form: FormData) {
  await unpair({ id: form.get("id") });
  revalidatePath("/settings");
}

// ---- Bank sync (SimpleFIN) ----
// The setup token and the access URL it is swapped for never come back to
// the browser and are never logged. Only status and plain errors do.

type BankState = null | { ok: true; message: string } | { ok: false; error: string };

const connectBank = authedAction(z.object({ token: z.string().trim().min(20).max(2000) }), ({ token }) =>
  connectSimplefin(token),
);

export async function connectBankAction(_prev: BankState, form: FormData): Promise<BankState> {
  // Check the session outside the try so a refusal is not turned into a message.
  await requireUser();
  try {
    const r = await connectBank({ token: form.get("token") });
    revalidatePath("/settings");
    revalidatePath("/finance", "layout");
    if (r.status === "ok") return { ok: true, message: `Connected. Pulled ${r.accounts} accounts and ${r.inserted} new transactions.` };
    if (r.status === "error") return { ok: true, message: `Connected, but the first sync failed: ${r.error}` };
    return { ok: true, message: `Connected. ${r.reason}` };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: "That does not look like a SimpleFIN setup token." };
    return { ok: false, error: err instanceof Error ? err.message : "Could not connect" };
  }
}

const syncNow = authedAction(z.object({}), () => syncSimplefinNow());

export async function syncBankNowAction(): Promise<BankState> {
  const r = await syncNow({});
  revalidatePath("/settings");
  revalidatePath("/finance", "layout");
  if (r.status === "ok") return { ok: true, message: `Synced ${r.accounts} accounts, ${r.inserted} new transactions.` };
  if (r.status === "skipped") return { ok: true, message: r.reason };
  return { ok: false, error: r.error };
}

const disconnectBank = authedAction(z.object({}), () => disconnectSimplefin());

export async function disconnectBankAction() {
  await disconnectBank({});
  revalidatePath("/settings");
  revalidatePath("/finance", "layout");
}
