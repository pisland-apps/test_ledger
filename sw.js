// Bump this version string any time you re-deploy new content, so old caches get replaced.
//
// This is a separate concern from APP_VERSION in ledger.js: CACHE_NAME controls which cached
// files the Service Worker serves; APP_VERSION is just the display label in the corner of the
// screen. They don't sync automatically (different files, different load times) — when you bump
// one, bump the other too. See the matching reminder comment on APP_VERSION in ledger.js.
const CACHE_NAME = "ledger-cache-v340";
// NOTE: deliberately does NOT include "./index.html" here. On hosts that
// redirect /index.html -> / (e.g. Cloudflare Pages -- GitHub Pages doesn't do
// this), caching that URL bakes in a redirected Response, and Chrome refuses
// to answer a navigation with a redirected Response (fails with
// net::ERR_FAILED). "./" is the only entry navigations should ever resolve
// through -- see the fetch handler below.
const ASSETS_TO_CACHE = [
    "./",
    "./ledger.js",
    // v326: was an inline <script> in index.html's <head> until the CSP-self-block security
    // fix moved it out to this external file (see its own header comment) — needs precaching
    // same as ledger.js since it also runs on every load, before first paint.
    "./theme-init.js",
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png",
    "./lib/pdf.min.mjs",
    "./lib/pdf.worker.min.mjs",
    "./fonts/kalam-400.woff2",
    "./fonts/kalam-700.woff2"
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

// Fetch: network-first (falling back to cache) for the two files that actually change on every
// deploy — the app shell ("./") and ledger.js — so a normal reload while online always picks up
// whatever was just deployed, with zero manual cache-clearing. Cache-first for everything else
// (icons, manifest, the vendored pdf.js files), since those essentially never change and
// cache-first avoids a pointless network round-trip for them on every load. Either way, this is
// what makes the app open even with no internet connection at all — network-first still falls
// back to whatever's cached the instant the fetch fails.
const NETWORK_FIRST_ASSETS = new Set(["./ledger.js"]);

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    // v326 security/correctness fix: previously nothing here filtered by origin, so the one
    // cross-origin request this app ever makes — the "Fetch Live Rates" GET to
    // open.er-api.com — fell into the generic cache-first branch below just like any other
    // same-origin asset. That meant the very first fetch got cached permanently, and every
    // later tap of "Fetch Live Rates" (for the same base currency) silently returned that
    // same stale response from the Cache Storage instead of ever hitting the network again —
    // defeating the button's entire purpose. Cross-origin requests are left alone here and
    // handled by the browser's normal network stack (which already has its own HTTP caching
    // rules); this also means any future third-party request added to the app is never
    // accidentally captured by this Service Worker without a deliberate opt-in.
    if (new URL(event.request.url).origin !== self.location.origin) return;

    // Navigation requests (address bar, installed-shortcut launch, link click):
    // this is a single-page app, so ALWAYS resolve through the canonical "./"
    // entry regardless of the exact URL requested -- "/", "/index.html", or any
    // other in-scope path an old bookmark/shortcut might still point at. Never
    // hand Chrome a redirected Response for a navigation (it fails the whole
    // load with net::ERR_FAILED) -- see README for the full story.
    if (event.request.mode === "navigate") {
        // v326 fix: caches.match("./") can itself resolve to undefined (nothing cached yet —
        // e.g. the very first install on a host that redirects "./"). Handing respondWith() an
        // undefined resolution fails the whole navigation with a generic error instead of
        // showing anything useful, so every fallback below is routed through this helper,
        // which guarantees a real Response either way.
        const navigationFallback = () =>
            caches.match("./").then((cached) =>
                cached || new Response(
                    "Offline and this page hasn't been cached yet — connect once so it can be, then it'll work offline too.",
                    { status: 503, headers: { "Content-Type": "text/plain" } }
                )
            );
        event.respondWith(
            fetch("./", { redirect: "follow" })
                .then((response) => {
                    if (response.redirected) {
                        // The host itself is redirecting "./" -- don't hand a
                        // redirected Response to a navigation. Fall back to
                        // whatever's cached (may be nothing on first-ever load).
                        return navigationFallback();
                    }
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put("./", responseClone));
                    return response;
                })
                .catch(navigationFallback)
        );
        return;
    }

    const isNetworkFirst = [...NETWORK_FIRST_ASSETS].some((path) => event.request.url.endsWith(path.slice(1)));

    if (isNetworkFirst) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
                    return response;
                })
                .catch(() => caches.match(event.request))
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
