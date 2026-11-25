/*
 * Household app service worker. It makes the app installable and shows a
 * friendly page when there is no connection.
 *
 * Privacy: it never caches pages or data (calendar, lists, finances). Only
 * the offline page, the icons and Next.js's static build files (which hold
 * no household data) are stored on the device. Everything else always goes
 * to the network, exactly as without a service worker.
 */
const CACHE = "household-static-v3";
const PRECACHE = ["/offline.html", "/kiosk-offline.html", "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: network only; the offline page when there is no connection.
  // The kitchen screen's offline page retries /kiosk every 30 s by itself.
  if (req.mode === "navigate") {
    const fallback = url.pathname === "/kiosk" ? "/kiosk-offline.html" : "/offline.html";
    event.respondWith(fetch(req).catch(() => caches.match(fallback)));
    return;
  }

  // Immutable build files and icons: cache first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// "Update app" (src/components/pwa/app-version.ts) asks a waiting worker to take over.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
