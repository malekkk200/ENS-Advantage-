/* ═══════════════════════════════════════════════════════════════
   ENS ADVANTAGE — SERVICE WORKER
   Caches the static app shell (HTML/CSS/JS/icons) so the site can
   install as a PWA and open instantly on repeat visits.

   Deliberately does NOT cache most Supabase traffic (auth, DB
   queries, storage/signed PDF URLs) or third-party CDNs — this app
   is auth-gated and RLS-protected, and lesson access is granted per
   student via signed URLs that expire. Caching that data would risk
   serving stale/expired URLs or content to a student whose access
   was later revoked. Those requests are simply left alone and go
   straight to the network, same as without a service worker.

   EXCEPTION — the Comprehensive Guide's images: files in the public
   guide-images storage bucket are free/public to every signed-in
   student, and each upload gets a brand-new path (uploads never
   overwrite in place — see admin-upsert-guide), so a cached image is
   never stale. Cached forever here; the guide TEXT itself (content_html)
   is cached separately in js/content.js, not here, because the admin
   panel re-queries that same table right after an edit to confirm it
   saved — caching it at the service-worker level would show the admin
   stale content immediately after their own upload.
═══════════════════════════════════════════════════════════════ */

// Bump this on every deploy that changes shell files so old caches
// get evicted in activate() below. Doesn't need to be meaningful —
// just needs to change.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `ens-advantage-shell-${CACHE_VERSION}`;

// Separate, independently-versioned cache for guide images. Kept apart
// from CACHE_NAME so a normal shell deploy (bumping CACHE_VERSION)
// never wipes images a student already downloaded.
const GUIDE_CACHE_VERSION = 'v1';
const GUIDE_CACHE_NAME = `ens-advantage-guides-${GUIDE_CACHE_VERSION}`;
const SUPABASE_HOST = 'sjzgjtpkyvrwgdeakoah.supabase.co';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/base.css',
  '/css/auth-header-hero.css',
  '/css/sections-content.css',
  '/css/subscription-badges.css',
  '/css/protection-admin.css',
  '/css/pdf-viewer.css',
  '/css/calculator.css',
  '/css/meme-player.css',
  '/js/main.js',
  '/js/auth.js',
  '/js/calc.js',
  '/js/community.js',
  '/js/config.js',
  '/js/content.js',
  '/js/courseMaterials.js',
  '/js/curriculum.js',
  '/js/dom.js',
  '/js/listeners.js',
  '/js/modules.js',
  '/js/pdfViewer.js',
  '/js/protection.js',
  '/js/realtime.js',
  '/js/router.js',
  '/js/state.js',
  '/js/subscription.js',
  '/js/supabaseClient.js',
  '/js/ui.js',
  '/assets/logo.jpg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll fails the whole install if any single file 404s —
      // use allSettled-style behavior so one missing/renamed file
      // (e.g. admin-only modules that change often) never blocks
      // the rest of the shell from being cached.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] skip cache:', url, err))
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== GUIDE_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/** True only for the guide-images public storage bucket — the only
 *  Supabase traffic that's safe to cache forever, since each upload
 *  gets a unique path (never overwritten), so a cached copy can never
 *  go stale. Deliberately does NOT include the guides table query —
 *  see the file-header note on why that's cached in content.js instead. */
function isCacheableGuideImage(url) {
  return url.hostname === SUPABASE_HOST &&
    url.pathname.startsWith('/storage/v1/object/public/guide-images/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Comprehensive Guide images: cache-first, forever. First open
  // downloads them like normal; every open after that (by any student)
  // is served straight from the cache with zero network/data usage.
  if (isCacheableGuideImage(url)) {
    event.respondWith(
      caches.open(GUIDE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Only handle GET requests on our own origin — everything else
  // (Supabase auth/DB/storage, CDN scripts, cross-origin) passes
  // straight through untouched.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations (loading the page itself): network-first so signed-in
  // students always get the latest shell when online, falling back to
  // the cached shell when offline instead of a browser error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets (css/js/icons): cache-first for instant loads,
  // refreshing the cache in the background on every hit.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
