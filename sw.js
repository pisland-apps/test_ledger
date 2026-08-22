// Bump this version string any time you re-deploy new content, so old caches get replaced.
//
// This is a separate concern from APP_VERSION in ledger.js: CACHE_NAME controls which cached
// files the Service Worker serves; APP_VERSION is just the display label in the corner of the
// screen. They don't sync automatically (different files, different load times) — when you bump
// one, bump the other too. See the matching reminder comment on APP_VERSION in ledger.js.
const CACHE_NAME = "ledger-cache-v104";
// NOTE: deliberately does NOT include "./index.html" here. On hosts that
// redirect /index.html -> / (e.g. Cloudflare Pages -- GitHub Pages doesn't do
// this), caching that URL bakes in a redirected Response, and Chrome refuses
// to answer a navigation with a redirected Response (fails with
// net::ERR_FAILED). "./" is the only entry navigations should ever resolve
// through -- see the fetch handler below.
const ASSETS_TO_CACHE = [
    "./",
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

    // Navigation requests (address bar, installed-shortcut launch, link click):
    // this is a single-page app, so ALWAYS resolve through the canonical "./"
    // entry regardless of the exact URL requested -- "/", "/index.html", or any
    // other in-scope path an old bookmark/shortcut might still point at. Never
    // hand Chrome a redirected Response for a navigation (it fails the whole
    // load with net::ERR_FAILED) -- see README for the full story.
    if (event.request.mode === "navigate") {
        event.respondWith(
            caches.match("./").then((cached) => {
                if (cached) return cached;
                return fetch("./", { redirect: "follow" })
                    .then((response) => {
                        if (response.redirected) {
                            // The host itself is redirecting "./" -- don't hand a
                            // redirected Response to a navigation. Fall back to
                            // whatever's cached (may be nothing on first-ever load).
                            return caches.match("./");
                        }
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put("./", responseClone));
                        return response;
                    })
                    .catch(() => caches.match("./"));
            })
        );
        return;
    }

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
