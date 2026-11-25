"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page from the server every `ms` while it is on screen, and
 * straight away when the app comes back to the foreground, so a change made
 * on the kitchen screen shows up on a phone without pulling to refresh.
 */
export function LiveRefresh({ ms = 45_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, ms]);
  return null;
}
