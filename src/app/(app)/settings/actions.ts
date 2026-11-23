"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { AiSettingsSchema } from "@/core/ai/settings";
import { saveAiSettings } from "@/core/ai/store";
import { z } from "zod";
import { createPairingCode, revokeKioskDevice } from "@/core/kiosk/devices";
import { formatPairingCode } from "@/core/kiosk/pairing";
import { revokeAllConnections, revokeConnection, setConnectionPermissions } from "@/core/oauth/server";

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
