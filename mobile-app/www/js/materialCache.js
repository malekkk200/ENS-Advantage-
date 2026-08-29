/* ═══════════════════════════════════════════════════════════════
   MATERIAL CACHE — persistent, on-device cache for PDF bytes
   ───────────────────────────────────────────────────────────────
   Deliberately scoped to FREE content only ('summary'). Full
   lessons are paid, revocable content and must always go through a
   fresh signed URL + a fresh security_logs entry on every single
   open — this cache is never read or written for that category.
   (See PDFViewer.open(), which only calls into this module when
   type === 'summary'.) That's what makes it safe to persist raw
   bytes to disk at all: nothing cached here was ever access-gated
   beyond "is this account signed in", so there's no revocation
   window being reintroduced by caching it.

   Backed by the Cache Storage API — the same primitive sw.js and
   content.js already use for the app shell / guide-image caching —
   keyed by a synthetic same-origin Request built from the
   material's database id, never from the short-lived signed URL
   itself. A given id's file content never changes once uploaded
   (see courseMaterials.js: uploads always insert a new row / new id
   rather than overwriting one in place), so a cached entry can
   never go stale — there's no invalidation problem to solve here,
   only storage growth, which MAX_ENTRIES bounds below.
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'ens-materials-v1';
const ORDER_KEY   = 'ensMaterialCacheOrder';
const MAX_ENTRIES = 20; // small LRU cap — data-consciousness matches memeSystem.js's stated design value

function keyFor(materialId) {
  return new Request(`${location.origin}/__material_cache__/${encodeURIComponent(String(materialId))}`);
}

/** Moves materialId to the most-recently-used end of the order list; returns the new list, or null if localStorage is unavailable. */
function touchOrder(materialId) {
  try {
    let order = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    if (!Array.isArray(order)) order = [];
    order = order.filter(id => id !== materialId);
    order.push(materialId);
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    return order;
  } catch {
    return null; // private browsing / quota / unavailable — non-fatal, just skip LRU bookkeeping
  }
}

export const MaterialCache = {
  /** Returns an ArrayBuffer if this material's bytes are cached, otherwise null. Never throws. */
  async read(materialId) {
    if (!materialId || !('caches' in window)) return null;
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(keyFor(materialId));
      if (!hit) return null;
      touchOrder(materialId);
      return await hit.arrayBuffer();
    } catch (err) {
      console.warn('[MaterialCache] read failed:', err);
      return null;
    }
  },

  /** Persists this material's bytes for instant reopening. Best-effort — failures are non-fatal since the document is already showing by the time this runs. */
  async write(materialId, arrayBuffer) {
    if (!materialId || !arrayBuffer || !('caches' in window)) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(keyFor(materialId), new Response(arrayBuffer, {
        headers: { 'Content-Type': 'application/pdf' }
      }));

      const order = touchOrder(materialId);
      if (order && order.length > MAX_ENTRIES) {
        const evictCount = order.length - MAX_ENTRIES;
        const toEvict = order.slice(0, evictCount);
        for (const id of toEvict) {
          await cache.delete(keyFor(id)).catch(() => {});
        }
        localStorage.setItem(ORDER_KEY, JSON.stringify(order.slice(evictCount)));
      }
    } catch (err) {
      console.warn('[MaterialCache] write failed:', err);
    }
  },

  /** Drops a single (presumably corrupted/unreadable) entry so the next open falls back to a fresh network fetch instead of repeatedly failing. */
  async evict(materialId) {
    if (!materialId || !('caches' in window)) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(keyFor(materialId));
    } catch (_) {}
  },

  /** Call on logout — matches this app's existing session-hygiene pattern (see CourseMaterials.invalidate()) so a shared/public device doesn't keep serving a previous student's cached summaries from disk after they've signed out. */
  async clear() {
    try {
      await caches.delete(CACHE_NAME);
      localStorage.removeItem(ORDER_KEY);
    } catch (_) {}
  }
};
