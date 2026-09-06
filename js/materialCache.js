/* ═══════════════════════════════════════════════════════════════
   MATERIAL CACHE — encrypted, on-device cache for lesson PDF bytes
   ───────────────────────────────────────────────────────────────
   Previously scoped to free ('summary') content only, with paid
   full lessons deliberately never persisted offline. This has since
   been asked for explicitly (both free AND paid lessons, viewable
   offline once opened once online), so the trade-off this file makes
   is now: encrypt everything at rest instead of refusing to cache
   paid content at all. This mirrors mobile-app's materialCache.js
   design exactly — see that file's header for the native-Keystore
   version of the same idea — swapping in the browser's own
   non-extractable-CryptoKey primitive (secureKeyStore.js) in place
   of the Android Keystore / iOS Keychain a packaged app can call
   into but a website cannot.

   Every cached file is AES-256-GCM encrypted before it ever touches
   disk — the ciphertext lives in Cache Storage (the same app-private,
   origin-scoped storage sw.js and content.js already use for the app
   shell / guide-image caching; invisible outside this origin, same as
   before). The AES key is a non-extractable CryptoKey generated once
   per browser profile + account and persisted via SecureKeyStore
   (IndexedDB) — never in this Cache Storage bucket, never in
   localStorage, never transmitted anywhere, and never readable back
   out as raw bytes by any script (see secureKeyStore.js). Losing that
   IndexedDB entry (explicit logout, or the user clearing site data)
   makes every existing encrypted file permanently unreadable garbage,
   even if the ciphertext itself were somehow copied off the device.

   Decrypted bytes only ever exist as a function-local ArrayBuffer,
   handed straight to pdf.js's getDocument({data}) and never assigned
   to any variable that outlives the call to PDFViewer.open() — so
   there's nothing for this module (or any other) to explicitly
   "purge" when the viewer closes; the reference is already
   unreachable and GC-eligible the moment open() returns. See
   pdfViewer.js.

   HONEST LIMIT: this raises the bar significantly against casual
   extraction — copying a file out of devtools' Cache Storage panel,
   browsing to it as a "PDF" and finding only garbage, etc. It is not
   a claim that paid content can never be extracted by anyone under
   any circumstance. Nothing that decrypts client-side without a
   server round trip ever fully is; the same fundamental trade-off
   every client-side "offline download" scheme makes (Netflix
   downloads, Kindle, etc.) applies here too: it deters casual
   copying, which is what was actually asked for.

   Revocation: a subscription that lapses AFTER a lesson was cached
   doesn't retroactively delete the local copy on its own — there is
   no push mechanism to a fully offline device. What DOES happen: any
   time this material is opened while online, the existing
   get-material-url call (see pdfViewer.js) still runs in the
   background even on a cache hit, purely to keep the audit trail
   current; if the server now says access is denied (403), the local
   copy is evicted right there, so it can't keep being opened offline
   indefinitely after the student is next online. On top of that,
   see licenseManager.js: every cached file also carries a 36h TTL
   that's checked BEFORE this module ever decrypts anything, and is
   proactively renewed in the background while online — so an
   already-lapsed subscription stops granting offline access even on
   a device that never happens to reopen that exact material, once
   its license's TTL runs out. A student who never reconnects at all
   keeps offline access to whatever they already cached until that
   TTL lapses — an inherent, accepted limitation of any offline-
   capable scheme, not something unique to this implementation.

   Device integrity: see deviceIntegrity.js. Both read() and write()
   below refuse to run at all on a device flagged as rooted/
   jailbroken/tampered — the RASP-style check requested alongside
   this file, sitting at the one choke point every offline decryption
   (and every new offline copy being created) has to pass through.
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';
import { SecureKeyStore } from './secureKeyStore.js';
import { DeviceIntegrity } from './deviceIntegrity.js';

const CACHE_NAME  = 'ens-materials-v2'; // v2: now encrypted — a v1 (plaintext) entry must never be read back and treated as valid ciphertext
const ORDER_KEY    = 'ensMaterialCacheOrder';
const MAX_ENTRIES  = 30; // slightly higher than the old free-only cap, now that this also covers paid lessons students want to keep offline
const IV_BYTES     = 12; // 96-bit IV — the size AES-GCM is designed around

function keyFor(materialId) {
  return new Request(`${location.origin}/__material_cache__/${encodeURIComponent(String(materialId))}`);
}

function secureKeyName() {
  // Scoped per signed-in account, not just per browser — if a second
  // student ever signs into the same shared device/browser, their
  // session gets its own key and can't decrypt whatever the first
  // student's key encrypted (on top of clear() below already wiping
  // everything on logout).
  return `lessonCacheKey_${State.currentUser?.id || 'anon'}`;
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

let _cryptoKeyPromise = null; // memoized per this page-load; reset on logout (see clear())

// Guards against a hung/slow IndexedDB call so write() (now directly
// awaited in PDFViewer's critical path, not fire-and-forget) can never
// block the whole PDF viewer indefinitely — it just skips the cache
// for this one call instead.
const KEY_TIMEOUT_MS = 5000;

function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Lazily creates (once per browser profile + account) or loads the
 * AES-256 key used to encrypt/decrypt everything in this cache.
 * Throws if secure key storage is genuinely unavailable — callers
 * must treat that as "don't cache this," never as "cache it
 * unencrypted instead" (fail closed, not open).
 */
function _getCryptoKey() {
  if (_cryptoKeyPromise) return _cryptoKeyPromise;
  _cryptoKeyPromise = SecureKeyStore.getOrCreateKey(secureKeyName());
  // Don't memoize a *failed* attempt — a transient hiccup shouldn't
  // permanently disable caching for the rest of the session; let the
  // next read()/write() call retry from scratch.
  _cryptoKeyPromise.catch(() => { _cryptoKeyPromise = null; });
  return _cryptoKeyPromise;
}

export const MaterialCache = {
  /** Returns a decrypted ArrayBuffer if this material's bytes are cached, otherwise null. Never throws. */
  async read(materialId) {
    if (!materialId || !('caches' in window)) return null;
    try {
      // RASP-style gate: on a device flagged as rooted/jailbroken/
      // tampered (see deviceIntegrity.js), offline decryption simply
      // never happens — a cache "miss" here just means the normal
      // network path runs instead (or, if genuinely offline too, the
      // document doesn't open at all on that device). The encrypted
      // bytes and the key both stay exactly where they were; nothing
      // is deleted, so a false positive costs the student one online
      // reopen, never their whole offline library.
      const integrity = await DeviceIntegrity.check();
      if (integrity.compromised) {
        console.warn('[MaterialCache] offline decryption blocked — device integrity check failed:', integrity.signals);
        return null;
      }

      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(keyFor(materialId));
      if (!hit) return null;

      const packed = new Uint8Array(await hit.arrayBuffer());
      const iv         = packed.slice(0, IV_BYTES);
      const ciphertext = packed.slice(IV_BYTES);
      const key = await _withTimeout(_getCryptoKey(), KEY_TIMEOUT_MS, 'MaterialCache read: key acquisition');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

      touchOrder(materialId);
      return plaintext;
    } catch (err) {
      // Covers: corrupted/truncated entry, wrong key (e.g. IndexedDB
      // key was cleared out-of-band), or key storage being
      // unavailable this call. Either way, the safe response is "no
      // usable cache" — never fall back to serving raw ciphertext.
      console.warn('[MaterialCache] read/decrypt failed:', err);
      return null;
    }
  },

  /** Encrypts and persists this material's bytes for instant/offline reopening. Best-effort — failures are non-fatal since the document is already showing by the time this runs. */
  async write(materialId, arrayBuffer) {
    if (!materialId || !arrayBuffer || !('caches' in window)) return;
    try {
      // Same integrity gate as read() — don't hand a fresh copy of the
      // (still-encrypted, but locally-keyed) content to a device that's
      // already flagged as tampered. The document the student is
      // viewing right now is completely unaffected; it just won't be
      // available offline on this particular device next time.
      const integrity = await DeviceIntegrity.check();
      if (integrity.compromised) {
        console.warn('[MaterialCache] caching skipped — device integrity check failed:', integrity.signals);
        return;
      }

      const key = await _withTimeout(_getCryptoKey(), KEY_TIMEOUT_MS, 'MaterialCache write: key acquisition');
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);

      const packed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
      packed.set(iv, 0);
      packed.set(new Uint8Array(ciphertext), IV_BYTES);

      const cache = await caches.open(CACHE_NAME);
      await cache.put(keyFor(materialId), new Response(packed, {
        // Deliberately NOT application/pdf — this is ciphertext, and
        // should never be servable/openable as a PDF even by accident.
        headers: { 'Content-Type': 'application/octet-stream' }
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
      // Fails closed: if encryption/storage genuinely fails, the
      // material simply isn't cached this time (falls back to a
      // normal network open next time) — it is never written
      // unencrypted as a fallback.
      console.warn('[MaterialCache] write/encrypt failed — material was NOT cached:', err);
    }
  },

  /** Drops a single (presumably corrupted/unreadable, or access-revoked) entry so the next open falls back to a fresh network fetch instead of repeatedly failing or serving stale access. */
  async evict(materialId) {
    if (!materialId || !('caches' in window)) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(keyFor(materialId));
    } catch (_) {}
  },

  /**
   * Call on logout. Deletes every cached lesson file AND the
   * on-device encryption key. Without that key, any leftover
   * encrypted file (this should remove them regardless) is
   * permanent, undecryptable garbage — this is what actually
   * enforces "no offline access to paid content after sign-out" on a
   * shared/public device, on top of it just being good hygiene.
   */
  async clear() {
    try { await caches.delete(CACHE_NAME); } catch (_) {}
    try { localStorage.removeItem(ORDER_KEY); } catch (_) {}
    try { await SecureKeyStore.removeKey(secureKeyName()); } catch (_) {}
    _cryptoKeyPromise = null;
  }
};
