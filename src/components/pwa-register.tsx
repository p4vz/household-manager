"use client";

import { useEffect } from "react";
// Loaded on every page so Chrome's one-time install offer is never missed.
import "./pwa/install-prompt";

/** Registers /sw.js so phones can install the app (see public/sw.js: it caches no household data). */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
