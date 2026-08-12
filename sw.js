// Bump this version string any time you re-deploy new content, so old caches get replaced.
//
// This is a separate concern from APP_VERSION in ledger.js: CACHE_NAME controls which cached
// files the Service Worker serves; APP_VERSION is just the display label in the corner of the
// screen. They don't sync automatically (different files, different load times) — when you bump
// one, bump the other too. See the matching reminder comment on APP_VERSION in ledger.js.
const CACHE_NAME = "ledger-cache-v19";
const ASSETS_TO_CACHE = [
    "./",
    "./index.html",
    "./ledger.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png"
];

// Install: pre-cache the app shell.
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
    );
    self.skipWaiting();
});

// Activate: clean up old cache versions.
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch: cache-first for app shell, falling back to network. This is what makes
// the app open even with no internet connection at all.
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request)
                .then((response) => {
                    // Cache a copy of newly-fetched assets for next time offline.
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
                    return response;
                })
                .catch(() => {
                    // Offline and not cached — nothing we can do for this particular request.
                    return cached;
                });
        })
    );
});
