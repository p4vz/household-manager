/**
 * Fullscreen API with the webkit-prefixed fallback (older Samsung Internet
 * and Safari). Browser-only; every function is safe to call during SSR.
 */
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** Set by Kitchen mode; the kiosk then restores full screen on the next tap after a reload. */
export const KITCHEN_FULLSCREEN_KEY = "hm-kitchen-fullscreen";

export function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement as FsElement;
  return typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function";
}

export function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument;
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/** Must run inside a tap or click. Resolves false when the browser says no. */
export async function enterFullscreen(): Promise<boolean> {
  if (!fullscreenSupported() || isFullscreen()) return isFullscreen();
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else await el.webkitRequestFullscreen?.();
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen(): Promise<void> {
  if (!isFullscreen()) return;
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    // Already out (the user pressed Esc or Back).
  }
}

export function rememberKitchenFullscreen(on: boolean) {
  try {
    if (on) localStorage.setItem(KITCHEN_FULLSCREEN_KEY, "1");
    else localStorage.removeItem(KITCHEN_FULLSCREEN_KEY);
  } catch {
    // Storage blocked: full screen just won't come back by itself after a reload.
  }
}

export function wantsKitchenFullscreen(): boolean {
  try {
    return localStorage.getItem(KITCHEN_FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}
