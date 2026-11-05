// v594: the ONE place that says which version the self-hosted Chinese font FILES are at.
//
// Loaded two ways, so the app and the service worker always agree: index.html loads it with a
// <script> tag before ledger.js (window.LEDGER_FONT_VERSION), and sw.js does importScripts() on it
// (self.LEDGER_FONT_VERSION). Both read the same two values below.
//
//  * LEDGER_FONT_CACHE   - name of the Cache Storage bucket that holds the Chinese font slices
//                          (fonts/long-cang/, fonts/ma-shan-zheng/, fonts/klee-one-zh-fallback-400.woff2).
//                          It is deliberately NOT tied to the app version: sw.js's activate step
//                          deletes every cache except CACHE_NAME and this one, so a normal app
//                          version bump (v595, v596, ...) no longer throws away the ~5 MB of saved
//                          fonts. Only change this name if the way the cache is laid out changes.
//  * LEDGER_FONT_VERSION - bump ONLY when the font FILES themselves change (a font replaced, slices
//                          re-cut, the Klee One fallback rebuilt). The app compares it with the
//                          version recorded when a font was saved: if they differ, that saved copy
//                          is marked "older font files" (still used offline, still better than
//                          nothing) and is refreshed quietly the next time the Chinese-font picker is
//                          opened, or the font is used, while online. Nothing re-downloads by itself
//                          just because the app version changed.
//
// Editing this file also makes the browser treat sw.js as changed (imported scripts are part of the
// service-worker update check), so the new value reaches every device without touching CACHE_NAME.
self.LEDGER_FONT_CACHE = "ledger-fonts-v1";
self.LEDGER_FONT_VERSION = "f1";
