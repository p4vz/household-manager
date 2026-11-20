"use server";

import { revalidatePath } from "next/cache";
import { authedAction } from "@/core/actions/authed-action";
import { AiSettingsSchema } from "@/core/ai/settings";
import { saveAiSettings } from "@/core/ai/store";

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
