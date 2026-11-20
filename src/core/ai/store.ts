import "server-only";
import { getSetting, setSetting } from "@/core/settings/store";
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, type AiSettings } from "./settings";

export async function getAiSettings(): Promise<AiSettings> {
  const parsed = AiSettingsSchema.safeParse(await getSetting(AI_SETTINGS_KEY));
  return parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await setSetting(AI_SETTINGS_KEY, AiSettingsSchema.parse(settings));
}
