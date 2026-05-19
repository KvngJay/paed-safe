// =============================================================================
// PaedSafe — sw.js
// Service worker — offline caching and deterministic auto-update.
//
// RULES (from 03_technical_architecture.md):
//   - Cache name from PAEDSAFE_CONFIG.cacheName (kept in sync manually)
//   - All 5 files cached on install — nothing external
//   - Cache First strategy for all assets
//   - skipWaiting() on activate — no user-mediated update
//   - Old caches deleted on activate
//   - Version mismatch detection handled by index.html on load
//
// Version must match PAEDSAFE_CONFIG.version in data.js.
// Update CACHE_NAME here whenever data.js version is bumped.
// =============================================================================

const CACHE_NAME = "paed-safe-v1.1.0";

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./data.js",
  "./calc.js",
  "./sw.js",
  "./manifest.json"
];

// =============================================================================
// INSTALL — cache all files atomically
// If any file fails to cache, the install fails entirely.
// A partial cache is worse than no cache for a clinical tool.
// =============================================================================
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(FILES_TO_CACHE))
      .then(() => {
        // Do not call skipWaiting() here — wait for activate event.
        // skipWaiting() on activate ensures the old SW fully finishes
        // before the new one takes over, preventing mid-session SW swap.
      })
      .catch(err => {
        // Install failure — SW will not activate.
        // Browser falls back to network on next load.
        console.error("PaedSafe SW: install failed —", err);
      })
  );
});

// =============================================================================
// ACTIVATE — take control immediately, delete all old caches
// skipWaiting() + clients.claim() ensures:
//   - New SW activates on next app open without waiting for tabs to close
//   - All open clients immediately use the new SW
//   - Old caches from previous versions are purged
// =============================================================================
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME)
            .map(name => {
              console.log("PaedSafe SW: deleting old cache —", name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
      .catch(err => {
        console.error("PaedSafe SW: activation error —", err);
      })
  );

  // Take over immediately — deterministic, no user action required.
  // Per 03_technical_architecture.md: "no update banner, no force-reload button."
  self.skipWaiting();
});

// =============================================================================
// FETCH — Cache First strategy
// 1. Try cache first
// 2. If not in cache, fetch from network and cache the response
// 3. If network also fails, return whatever is in cache (or fail gracefully)
//
// This means the app works fully offline after first load.
// External requests (none expected) fall through to network only.
// =============================================================================
self.addEventListener("fetch", event => {
  // Only handle same-origin GET requests
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Not in cache — fetch from network and cache for next time
        return fetch(event.request)
          .then(networkResponse => {
            // Only cache valid responses — not errors, not opaque responses
            if (
              !networkResponse ||
              networkResponse.status !== 200 ||
              networkResponse.type !== "basic"
            ) {
              return networkResponse;
            }

            // Clone response — it's a stream, can only be consumed once
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(event.request, responseToCache))
              .catch(err => console.warn("PaedSafe SW: failed to cache network response —", err));

            return networkResponse;
          })
          .catch(() => {
            // Network failed and not in cache.
            // For HTML navigation requests, return index.html from cache
            // so the app shell loads even on full offline first-open fail.
            if (event.request.destination === "document") {
              return caches.match("./index.html");
            }
            // For other assets, fail silently — SW cannot recover
          });
      })
  );
});