import "server-only";
import { open, seal } from "@/core/secrets/secret-box";
import { getSetting, setSetting } from "@/core/settings/store";

const KEY = "finance.simplefin";

type Stored = { sealedAccessUrl: string; linkedAt: string };

/**
 * SIMPLEFIN_ACCESS_URL in the environment wins. Otherwise the URL claimed
 * on the setup screen is kept encrypted in the database. It is never sent
 * to the browser.
 */
export async function getAccessUrl(): Promise<string | null> {
  if (process.env.SIMPLEFIN_ACCESS_URL) return process.env.SIMPLEFIN_ACCESS_URL;
  const stored = (await getSetting(KEY)) as Stored | undefined;
  return stored?.sealedAccessUrl ? open(stored.sealedAccessUrl) : null;
}

export async function storeAccessUrl(accessUrl: string): Promise<void> {
  await setSetting(KEY, { sealedAccessUrl: seal(accessUrl), linkedAt: new Date().toISOString() } satisfies Stored);
}

export async function connectionInfo(): Promise<{ connected: boolean; via: "env" | "setup" | null; linkedAt: string | null }> {
  if (process.env.SIMPLEFIN_ACCESS_URL) return { connected: true, via: "env", linkedAt: null };
  const stored = (await getSetting(KEY)) as Stored | undefined;
  return stored?.sealedAccessUrl
    ? { connected: true, via: "setup", linkedAt: stored.linkedAt }
    : { connected: false, via: null, linkedAt: null };
}
