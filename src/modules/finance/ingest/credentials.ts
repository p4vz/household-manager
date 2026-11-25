import "server-only";
import { open, seal } from "@/core/secrets/secret-box";
import type { Viewer } from "../access";
import { deleteSetting, getSetting, setSetting } from "@/core/settings/store";

const KEY = "finance.simplefin";

/** `connectedBy`: who linked the banks; accounts found by the sync start as theirs. */
type Stored = { sealedAccessUrl: string; linkedAt: string; connectedBy?: Viewer };

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

export async function storeAccessUrl(accessUrl: string, connectedBy?: Viewer): Promise<void> {
  await setSetting(KEY, { sealedAccessUrl: seal(accessUrl), linkedAt: new Date().toISOString(), connectedBy } satisfies Stored);
}

/**
 * Owner for an account the bank sync sees for the first time. Accounts start
 * private to whoever linked the banks, so nothing shows up for the other
 * member until someone marks it Joint on the Accounts page. An access URL set
 * in the environment (or linked before this was recorded) counts as User 1's,
 * who manages the deployment.
 */
export async function newAccountOwner(): Promise<Viewer> {
  if (process.env.SIMPLEFIN_ACCESS_URL) return "user1";
  const stored = (await getSetting(KEY)) as Stored | undefined;
  return stored?.connectedBy ?? "user1";
}

/** Forget the stored access URL. Synced accounts and transactions stay. */
export async function clearAccessUrl(): Promise<void> {
  await deleteSetting(KEY);
}

export async function connectionInfo(): Promise<{ connected: boolean; via: "env" | "setup" | null; linkedAt: string | null }> {
  if (process.env.SIMPLEFIN_ACCESS_URL) return { connected: true, via: "env", linkedAt: null };
  const stored = (await getSetting(KEY)) as Stored | undefined;
  return stored?.sealedAccessUrl
    ? { connected: true, via: "setup", linkedAt: stored.linkedAt }
    : { connected: false, via: null, linkedAt: null };
}
