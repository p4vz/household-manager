"use client";

/**
 * Update check for the installed app. Each build is stamped with a version
 * (scripts/write-version.mjs). The phone keeps the app open in memory, so it
 * can run an old build after a deploy; comparing the version baked into this
 * page with /version.json on the server tells it a newer one is live.
 */

const VERSION_URL = "/version.json";

/** Baked in at build by next.config.ts (`env`); not a secret. */
export const CURRENT_VERSION = process.env.HM_APP_VERSION ?? "dev";

/** The live version, or null when it can't be read (offline, dev build). */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, { cache: "no-store", credentials: "omit" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** True when the server runs a different build than this page. */
export function isNewer(latest: string | null): latest is string {
  return CURRENT_VERSION !== "dev" && latest !== null && latest !== CURRENT_VERSION;
}

/**
 * Loads the new version: refreshes the service worker (public/sw.js) so the
 * newest one is in charge, then reloads the page. Pages are never cached, so
 * the reload always fetches the new build.
 */
export async function applyUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
  } catch {
    // Reloading still picks up the new pages.
  }
  window.location.reload();
}
