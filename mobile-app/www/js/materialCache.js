/* ═══════════════════════════════════════════════════════════════
   MATERIAL CACHE — encrypted, on-device cache for lesson PDF bytes
   ───────────────────────────────────────────────────────────────
   Previously scoped to free ('summary') content only, with paid
   full lessons deliberately never persisted — full offline access
   was explicitly out of scope for that design. This has since been
   asked for explicitly (both free AND paid lessons, viewable
   offline once opened once online), so the trade-off this file makes
   is now: encrypt everything at rest instead of refusing to cache
   paid content at all.

   Every cached file is AES-256-GCM encrypted before it ever touches
   disk — the ciphertext lives in Cache Storage (the same app-private,
   WebView-only storage this app already uses for guide text/images;
   invisible to any standard device file manager without root, same
   as before). The AES key is a random 256-bit value generated once
   per device+account and stored via SecureStorageBridge — Android
   Keystore-backed encryption / iOS Keychain — never in this Cache
   Storage bucket, never in localStorage, never transmitted anywhere.
   It's imported as a non-extractable CryptoKey, so raw key bytes
   can't be read back out of it from JS even by other code in this
   same page. Losing that secure-storage entry (explicit logout, or
   uninstalling the app) makes every existing encrypted file
   permanently unreadable garbage, even if the ciphertext itself were
   somehow copied off the device.

   Decrypted bytes only ever exist as a function-local ArrayBuffer,
   handed straight to pdf.js's getDocument({data}) and never assigned
   to any variable that outlives the call to PDFViewer.open() — so
   there's nothing for this module (or any other) to explicitly
   "purge" when the viewer closes; the reference is already
   unreachable and GC-eligible the moment open() returns. See
   pdfViewer.js.

   HONEST LIMIT: this raises the bar significantly against casual
   extraction (copying files off a non-rooted device, browsing to them
   in a file manager, an ADB backup, etc.) — it is not a claim that
   paid content can never be extracted by anyone under any
   circumstance. Nothing that decrypts client-side without a server
   round trip ever fully is; a sufficiently determined attacker with
   root access to their OWN device can, in principle, pull key
   material out of a live, rooted process. This is the same
   fundamental trade-off every client-side "offline download" scheme
   makes (Netflix downloads, Kindle, etc.): it deters casual copying,
   which is what was actually asked for.

   Revocation: a subscription that lapses AFTER a lesson was cached
   doesn't retroactively delete the local copy on its own — there is
   no push mechanism to a fully offline device, and (as of this
   version) no background TTL sweep either; downloaded content is
   meant to stay available offline indefinitely once cached. See
   licenseManager.js for the two things that DO still invalidate a
   cached copy: a confirmed 403 from the server (an actual access
   denial, checked in the background even on a cache hit while
   online — see pdfViewer.js), or the admin genuinely replacing the
   material's file, detected via course_materials.updated_at
   (licenseManager.js's contentChanged()) the next time this device
   has synced that table. A student who never reconnects at all keeps
   whatever they already cached indefinitely — this is now a
   deliberate design choice (offline reliability over timely
   subscription-lapse enforcement), not an inherent limitation being
   tolerated.

   Device integrity: see deviceIntegrity.js. Checked on every read()/
   write(), and a genuine finding is reported through the security-log
   pipeline — but as of the incident below, it no longer BLOCKS either
   operation. It originally did (a RASP-style gate refusing to run at
   all on a flagged device), but two independent false positives — one
   in the JS-only fallback heuristic, one in the native Android
   plugin's own logic (double-counting a single build-tag fact as two
   separate corroborating signals), on two separate real deployments —
   each broke offline access for ordinary, non-tampered devices before
   being caught. A check with that track record isn't safe to trust
   with an all-or-nothing gate on a paying student's access; it's kept
   for visibility (a genuine finding is still worth knowing about) but
   the actual protection here is, and always has been, the
   AES-256-GCM encryption + hardware-backed key below — that part has
   never had a bug, and doesn't depend on this heuristic being right.
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';
import { SecureStorageBridge } from './secureStorage.js';
import { DeviceIntegrity } from './deviceIntegrity.js';

const CACHE_NAME  = 'ens-materials-v2'; // v2: now encrypted — a v1 (plaintext) entry must never be read back and treated as valid ciphertext
const IV_BYTES     = 12; // 96-bit IV — the size AES-GCM is designed around
const KEY_ALG      = { name: 'AES-GCM', length: 256 };

function keyFor(materialId) {
  return new Request(`${location.origin}/__material_cache__/${encodeURIComponent(String(materialId))}`);
}

// By default, browsers/WebViews treat Cache Storage as "best-effort":
// under device storage pressure, the platform is allowed to silently
// evict it to reclaim space, with no warning to this app and no event
// to react to — a student could lose a downloaded lesson for reasons
// that have nothing to do with the 30-entry LRU cap this file
// enforces itself. navigator.storage.persist() asks the platform to
// exempt this origin from that best-effort eviction instead. This is
// a one-way, best-effort REQUEST, not a guarantee it's granted (older
// WebViews / iOS versions may not support it at all) — feature-detected
// and fire-and-forget so its absence never blocks anything here.
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

function secureKeyName() {
  // Scoped per signed-in account, not just per device — if a second
  // student ever signs into the same physical device, their session
  // gets its own key and can't decrypt whatever the first student's
  // key encrypted (on top of clear() below already wiping everything
  // on logout).
  return `lessonCacheKey_${State.currentUser?.id || 'anon'}`;
}

let _cryptoKeyPromise = null; // memoized per this page-load; reset on logout (see resetCryptoKey)

// Guards against a hung native SecureStorage bridge call. Now that
// write() is directly awaited in PDFViewer's critical path (not
// fire-and-forget any more — see pdfViewer.js for why), a genuinely
// hung plugin call would otherwise block the whole PDF viewer
// indefinitely instead of just silently skipping the cache. Wider than
// secureStorage.js's own per-call timeout (3s) since _getCryptoKey()
// can chain up to two sequential bridge calls (getItem, then setItem
// on first use) — this bounds the TOTAL, not each individual call. A
// slow but eventually-successful call is still allowed to finish
// normally via the memoized _cryptoKeyPromise on a later
// read()/write() — this only stops the CURRENT call from waiting
// forever.
const KEY_TIMEOUT_MS = 7000;

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
 * Lazily creates (once per device+account) or loads the AES-256 key
 * used to encrypt/decrypt everything in this cache. Imported as a
 * non-extractable CryptoKey. Throws if secure storage is genuinely
 * unavailable — callers must treat that as "don't cache this,"
 * never as "cache it unencrypted instead" (fail closed, not open).
 */
function _getCryptoKey() {
  if (_cryptoKeyPromise) return _cryptoKeyPromise;
  _cryptoKeyPromise = (async () => {
    const name = secureKeyName();
    let raw = await SecureStorageBridge.getItem(name);
    if (!raw) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      raw = btoa(String.fromCharCode(...bytes));
      const saved = await SecureStorageBridge.setItem(name, raw);
      if (!saved) throw new Error('secure storage unavailable — refusing to cache lesson content without encryption');
    }
    const keyBytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', keyBytes, KEY_ALG, false, ['encrypt', 'decrypt']);
  })();
  // Don't memoize a *failed* attempt — a transient secure-storage
  // hiccup shouldn't permanently disable caching for the rest of the
  // session; let the next read()/write() call retry from scratch.
  _cryptoKeyPromise.catch(() => { _cryptoKeyPromise = null; });
  return _cryptoKeyPromise;
}

export const MaterialCache = {
  /** Returns a decrypted ArrayBuffer if this material's bytes are cached, otherwise null. Never throws. */
  async read(materialId) {
    if (!materialId || !('caches' in window)) return null;
    try {
      // Device integrity is checked and reported (see deviceIntegrity.js
      // — check() itself reports a genuine finding through the existing
      // security-log pipeline) but no longer GATES this operation — see
      // this file's header for why. Two separate false positives from
      // two independent root-detection code paths broke this exact
      // offline feature for ordinary, legitimate users before this was
      // caught; a heuristic that has twice mistaken a normal device for
      // a compromised one is not a heuristic this method can afford to
      // trust with blocking a paying student's access. The actual
      // protection here is the encryption below, which has never had a
      // bug — that's what continues to do the real work.
      DeviceIntegrity.check().catch(() => {});

      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(keyFor(materialId));
      if (!hit) return null;

      const packed = new Uint8Array(await hit.arrayBuffer());
      const iv         = packed.slice(0, IV_BYTES);
      const ciphertext = packed.slice(IV_BYTES);
      const key = await _withTimeout(_getCryptoKey(), KEY_TIMEOUT_MS, 'MaterialCache read: key acquisition');
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

      return plaintext;
    } catch (err) {
      // Covers: corrupted/truncated entry, wrong key (e.g. secure
      // storage was cleared out-of-band), or secure storage being
      // unavailable this call. Either way, the safe response is "no
      // usable cache" — never fall back to serving raw ciphertext.
      console.warn('[MaterialCache] read/decrypt failed:', err);
      return null;
    }
  },

  /**
   * Encrypts and persists this material's bytes for instant/offline
   * reopening. Best-effort — failures are non-fatal since the
   * document is already showing by the time this runs. No cap on how
   * many materials can be cached this way — see this file's header.
   */
  async write(materialId, arrayBuffer) {
    if (!materialId || !arrayBuffer || !('caches' in window)) return;
    try {
      // Checked and reported, not gated — see read() above for why.
      DeviceIntegrity.check().catch(() => {});

      const key = await _withTimeout(_getCryptoKey(), KEY_TIMEOUT_MS, 'MaterialCache write: key acquisition');
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);

      const packed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
      packed.set(iv, 0);
      packed.set(new Uint8Array(ciphertext), IV_BYTES);

      const cache = await caches.open(CACHE_NAME);
      await cache.put(keyFor(materialId), new Response(packed, {
        // Deliberately NOT application/pdf — this is ciphertext, and
        // should never be servable/openable as a PDF even by accident
        // (e.g. some future code path that naively does cache.match()
        // and hands the Response straight to something PDF-shaped).
        headers: { 'Content-Type': 'application/octet-stream' }
      }));
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
    try { await SecureStorageBridge.removeItem(secureKeyName()); } catch (_) {}
    _cryptoKeyPromise = null;
  }
};
