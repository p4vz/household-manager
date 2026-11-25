"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { checkApiKeyShape, getApiKey, removeApiKey, saveApiKey, testApiKey, type KeyTestResult } from "@/core/ai/keys";
import { AI_PROVIDERS, AiSettingsSchema } from "@/core/ai/settings";
import { getAiSettings, saveAiSettings } from "@/core/ai/store";
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

// ---- AI provider API keys ----
// The key is accepted here and sealed server-side. Nothing returned from
// these actions contains it; errors are written by hand so they cannot echo it.

const ProviderInput = z.enum(AI_PROVIDERS);
const KeyInput = z.object({ provider: ProviderInput, key: z.string().max(400) });

export const saveApiKeyAction = authedAction(KeyInput, async ({ provider, key }): Promise<KeyTestResult> => {
  const k = key.trim();
  const shape = checkApiKeyShape(provider, k);
  if (shape) return { ok: false, message: shape };
  const test = await testApiKey(provider, k);
  // A key the provider rejects outright is not saved; a network blip or rate limit doesn't block saving.
  if (!test.ok && test.message.startsWith("The provider rejected")) return test;
  await saveApiKey(provider, k);
  // If the active provider has no key at all, switch to the one just added so it starts working.
  const settings = await getAiSettings();
  let switched = false;
  if (settings.provider !== provider && !(await getApiKey(settings.provider))) {
    await saveAiSettings({ ...settings, provider });
    switched = true;
  }
  revalidatePath("/settings");
  const note = switched ? " It is now the active provider." : "";
  return test.ok
    ? { ok: true, message: `Saved. Key works.${note}` }
    : { ok: true, message: `Saved, but not verified: ${test.message}${note}` };
});

export const testApiKeyAction = authedAction(KeyInput, async ({ provider, key }) => {
  const k = key.trim();
  if (k) {
    const shape = checkApiKeyShape(provider, k);
    if (shape) return { ok: false, message: shape } satisfies KeyTestResult;
  }
  return testApiKey(provider, k || undefined);
});

export const removeApiKeyAction = authedAction(z.object({ provider: ProviderInput }), async ({ provider }) => {
  await removeApiKey(provider);
  revalidatePath("/settings");
  return { ok: true, message: "Removed." } satisfies KeyTestResult;
});

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
