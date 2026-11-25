"use client";

import { useEffect, useRef, useState } from "react";
import { decide, nextPingDelay, type WatchdogState } from "./watchdog";

const CHECK_MS = 15_000;
const STORE_KEY = "hm-kiosk-reloads";
/** A static file on the app server; not cached by the service worker. */
const PING_URL = "/kiosk.webmanifest";

function loadReloads(): number[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function saveReloads(list: number[]) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-10)));
  } catch {
    // Private mode or storage off: the cap then only lasts for this page.
  }
}

async function ping(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${PING_URL}?ping=${Date.now()}`, { cache: "no-store", signal: ctrl.signal, credentials: "omit" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function hourIn(tz: string, at: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(at));
}

/**
 * Keeps the kitchen screen alive without anyone touching it (see watchdog.ts
 * for the rules). `renderedAt` changes on every fresh server render. Returns
 * whether the screen is offline, for a small notice in the header.
 */
export function useKioskWatchdog(renderedAt: number, tz: string): { offline: boolean } {
  const [offline, setOffline] = useState(false);
  const state = useRef<WatchdogState | null>(null);
  const nextPingAt = useRef(0);

  // A new server render: the page is alive.
  useEffect(() => {
    if (state.current) state.current.lastRenderAt = Date.now();
  }, [renderedAt]);

  useEffect(() => {
    const now = Date.now();
    state.current = { lastRenderAt: now, online: true, offlineSince: null, failedPings: 0, reloads: loadReloads(), loadedAt: now };
    let stopped = false;
    let reloading = false;

    const markOffline = () => {
      const s = state.current!;
      if (s.online) {
        s.online = false;
        s.offlineSince ??= Date.now();
        setOffline(true);
      }
    };

    const markOnline = () => {
      const s = state.current!;
      s.online = true;
      s.failedPings = 0;
      setOffline(false);
    };

    const check = async () => {
      if (stopped || reloading) return;
      const s = state.current!;
      const t = Date.now();
      // The page only refreshes while on screen; a sleeping display is not a stall.
      if (document.visibilityState !== "visible") {
        s.lastRenderAt = t;
        return;
      }

      // Offline: only ping, on a backoff schedule.
      if (!s.online) {
        if (t < nextPingAt.current) return;
        if (await ping()) markOnline();
        else {
          s.failedPings += 1;
          nextPingAt.current = Date.now() + nextPingDelay(s.failedPings);
          return;
        }
      }

      let d = decide(s, Date.now(), hourIn(tz, new Date()));
      // Before reloading a stalled page, make sure the server is there.
      if (d.action === "reload" && d.reason === "stalled" && !(await ping())) {
        markOffline();
        nextPingAt.current = Date.now() + nextPingDelay(0);
        d = { action: "wait", reason: "offline" };
      }
      if (d.action !== "reload" || stopped) return;
      reloading = true;
      s.reloads = [...s.reloads, Date.now()];
      saveReloads(s.reloads);
      console.warn(`[kiosk] watchdog reload: ${d.reason}`);
      window.location.reload();
    };

    const interval = setInterval(() => void check(), CHECK_MS);
    const onOffline = () => markOffline();
    const onOnline = () => {
      nextPingAt.current = 0;
      void check();
    };
    // Code left behind by a new deploy fails to load: treat the page as stalled.
    const onError = (e: ErrorEvent | PromiseRejectionEvent) => {
      const reason = "reason" in e ? e.reason : e.error;
      const text = `${reason?.name ?? ""} ${reason?.message ?? (e as ErrorEvent).message ?? ""}`;
      if (/ChunkLoadError|Loading chunk|dynamically imported module|Failed to find Server Action/i.test(text) && state.current) {
        state.current.lastRenderAt = 0;
      }
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onError);
    };
  }, [tz]);

  return { offline };
}
