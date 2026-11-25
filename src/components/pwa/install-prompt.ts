"use client";

/**
 * Remembers Chrome's install offer (`beforeinstallprompt`) so the "Install
 * app" button can open the real install dialog. The listener is added when
 * this module loads, before React renders, because Chrome fires the event
 * once, early, and does not repeat it.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  /** Chrome offered to install, so one tap opens its install dialog. */
  canPrompt: boolean;
  /** Installed on this device (now, or found by Chrome). */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    set({ canPrompt: false, installed: true });
  });
  // Chrome on Android can tell an open browser tab that the app is already on the phone.
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
  nav
    .getInstalledRelatedApps?.()
    .then((apps) => {
      if (apps.length > 0) set({ installed: true });
    })
    .catch(() => undefined);
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installSnapshot(): InstallState {
  return state;
}

const SERVER_STATE: InstallState = { canPrompt: false, installed: false };
export function installServerSnapshot(): InstallState {
  return SERVER_STATE;
}

/** Opens Chrome's install dialog. False when there is no offer to use. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  set({ canPrompt: false });
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") set({ installed: true });
  return true;
}

/** True when the page is running as the installed app, not in a browser tab. */
export function runningAsApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
