"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { AiSettingsSchema } from "@/core/ai/settings";
import { saveAiSettings } from "@/core/ai/store";
import { z } from "zod";
import { revokeAllConnections, revokeConnection } from "@/core/oauth/server";

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
