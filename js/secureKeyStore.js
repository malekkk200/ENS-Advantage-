/* ═══════════════════════════════════════════════════════════════
   SECURE KEY STORE (web)
   ───────────────────────────────────────────────────────────────
   Browser-native equivalent of mobile-app's secureStorage.js. A
   packaged app can call into the Android Keystore / iOS Keychain
   through a native plugin; a website has no such primitive — the
   closest real equivalent the Web Crypto API offers is a
   *non-extractable* CryptoKey persisted in IndexedDB.

   "Non-extractable" is a genuine property enforced by the browser's
   crypto implementation, not just a naming convention: once a key is
   generated with extractable=false, no JavaScript on the page — this
   module, devtools, another script on the same origin, none of it —
   can ever read its raw bytes back out. IndexedDB is one of the few
   storage APIs that can hold a CryptoKey object directly (via
   structured clone) without exporting it first, so the key can
   persist across page loads/sessions while remaining permanently
   unreadable as bytes. That's what makes it safe to use as an
   at-rest encryption key for cached lesson PDFs: the ciphertext and
   the key live in two different browser storage areas, and the key
   itself can never be exfiltrated by any script, ever.

   Honest limit, stated once here rather than repeated at every call
   site: this deters casual copying (browsing to the cache in
   devtools, a naive "export IndexedDB" tool, etc.) — it is not
   real DRM. A user with full control of their own machine can, in
   principle, instrument the browser's own crypto internals. That is
   the same ceiling every client-side "offline download" scheme runs
   into (see materialCache.js for the fuller version of this note);
   it is *not* a reason to fall back to storing plaintext instead.
═══════════════════════════════════════════════════════════════ */

const DB_NAME    = 'ens-secure-keys';
const DB_VERSION = 1;
const STORE      = 'keys';
const KEY_ALG    = { name: 'AES-GCM', length: 256 };

function debugLog(...args) {
  try { window.__authDebug?.('[SecureKeyStore]', ...args); } catch (_) {}
}

let _dbPromise = null;

function _openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  // Don't memoize a failed open — a transient failure shouldn't
  // permanently disable the key store for the rest of the session.
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function _idbGet(db, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error || new Error('IndexedDB get failed'));
  });
}

function _idbPut(db, name, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error || new Error('IndexedDB put failed'));
  });
}

function _idbDelete(db, name) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve(); // best-effort delete — never throw
    } catch (_) { resolve(); }
  });
}

export const SecureKeyStore = {
  /** True when the browser supports everything this module needs. */
  isAvailable() {
    return !!(window.crypto?.subtle && 'indexedDB' in window);
  },

  /**
   * Returns the named non-extractable AES-256-GCM CryptoKey, creating
   * it on first use. Throws if Web Crypto / IndexedDB are genuinely
   * unavailable — callers must treat that as "don't cache this,"
   * never as "cache it unencrypted instead" (fail closed).
   */
  async getOrCreateKey(name) {
    if (!this.isAvailable()) throw new Error('Web Crypto / IndexedDB unavailable');
    const db = await _openDb();
    const existing = await _idbGet(db, name);
    if (existing) { debugLog('getOrCreateKey: found existing key', name); return existing; }

    const key = await crypto.subtle.generateKey(KEY_ALG, false, ['encrypt', 'decrypt']);
    await _idbPut(db, name, key);
    debugLog('getOrCreateKey: generated new key', name);
    return key;
  },

  /** Best-effort delete — call on logout so a shared/public device can't keep decrypting a previous student's cache. */
  async removeKey(name) {
    try {
      const db = await _openDb();
      await _idbDelete(db, name);
      debugLog('removeKey', name);
    } catch (err) {
      debugLog('removeKey FAILED', name, err?.message || err);
    }
  }
};
