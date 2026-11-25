import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/core/db/client";
import { coreSettings } from "@/core/db/core-schema";

/** Small key/value store for app settings. Keys are namespaced: "ai", "finance.simplefin". */
export async function getSetting(key: string): Promise<unknown> {
  const [row] = await db().select().from(coreSettings).where(eq(coreSettings.key, key));
  return row?.value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db()
    .insert(coreSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: coreSettings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteSetting(key: string): Promise<void> {
  await db().delete(coreSettings).where(eq(coreSettings.key, key));
}
