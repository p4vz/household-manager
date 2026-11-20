import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { coreSettings } from "@/core/db/core-schema";
import { AI_SETTINGS_KEY, AiSettingsSchema, DEFAULT_AI_SETTINGS, type AiSettings } from "./settings";

export async function getAiSettings(): Promise<AiSettings> {
  const [row] = await db()
    .select()
    .from(coreSettings)
    .where(eq(coreSettings.key, AI_SETTINGS_KEY));
  const parsed = AiSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  const value = AiSettingsSchema.parse(settings);
  await db()
    .insert(coreSettings)
    .values({ key: AI_SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: coreSettings.key, set: { value, updatedAt: new Date() } });
}
