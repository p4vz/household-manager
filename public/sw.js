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

// Phone notifications (src/core/push). The payload arrives encrypted for this
// device and holds only a short title, text and an in-app path.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(typeof data.title === "string" ? data.title : "Household", {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin && !new URL(w.url).pathname.startsWith("/kiosk"));
      if (open) return open.navigate(target.href).then((w) => (w || open).focus());
      return self.clients.openWindow(target.href);
    }),
  );
});
