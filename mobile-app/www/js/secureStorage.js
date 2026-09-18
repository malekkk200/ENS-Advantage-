/* ═══════════════════════════════════════════════════════════════
   SECURE STORAGE BRIDGE
   ───────────────────────────────────────────────────────────────
   Thin wrapper around the @aparajita/capacitor-secure-storage native
   plugin, called via the raw Capacitor bridge (window.Capacitor.Plugins.
   SecureStorage) rather than importing the plugin's npm JS package —
   this app has no bundler (plain ES modules loaded directly by
   <script type="module">), and Capacitor's bridge exposes every
   registered native plugin as window.Capacitor.Plugins.<Name> without
   needing its JS wrapper loaded at all. This is Capacitor's normal,
   documented low-level calling convention, not a workaround.

   On Android this plugin encrypts with AES-GCM using a key generated
   by (and never leaving) the Android Keystore, then stores the
   ciphertext in SharedPreferences. On iOS it uses the system Keychain.
   Both are the platform-standard "SecureStore"-equivalent primitives
   the task asked for.

   Every method here is defensive by design: if the plugin isn't
   registered (e.g. `npx cap sync` hasn't run since it was added, an
   unexpected platform, or a genuine plugin failure), calls resolve to
   a safe "unavailable" result instead of throwing — callers (see
   supabaseClient.js, materialCache.js) fall back to a less-secure but
   still-functional path rather than breaking auth or lesson viewing
   outright. This can't silently make the WHOLE app depend on a piece
   of native code that has never been exercised on a real device from
   this sandboxed environment — see the honesty note in this project's
   memory/commit history about the same limitation for the Android
   FLAG_SECURE / iOS SecureViewController work.
═══════════════════════════════════════════════════════════════ */

function debugLog(...args) {
  try { window.__authDebug?.('[SecureStorage]', ...args); } catch (_) {}
}

function bridge() {
  try {
    return window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.SecureStorage : null;
  } catch (_) {
    return null;
  }
}

// Bounds how long any single native bridge call is waited on. Native
// plugin calls are a black box from here — if one ever genuinely hangs
// (rather than resolving or rejecting) on some device/OS combination,
// nothing downstream should wait on it forever; every caller in this
// app is written to treat a timeout exactly like any other failure
// (fall back to a less-secure-but-functional path, or simply "don't
// cache this one").
const CALL_TIMEOUT_MS = 3000;

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// ── The plugin's ACTUAL native method surface ───────────────────
// This is the bug that broke offline mode entirely, confirmed by the
// on-device self-test (setItem returned false, getItem returned null
// on a real device) and then against the plugin's own source:
//
// @aparajita/capacitor-secure-storage registers as 'SecureStorage',
// but the methods it implements NATIVELY are internalSetItem /
// internalGetItem / internalRemoveItem. The friendly setItem()/
// getItem()/removeItem() names are implemented in the plugin's
// JavaScript wrapper class (dist/esm/base.js), which we deliberately
// don't load (this app has no bundler). Calling plugin.setItem(...)
// straight over the Capacitor bridge therefore invoked a native
// method that does not exist — every call rejected, setItem() returned
// false, no encryption key could ever persist, and so NOTHING could
// ever be cached. Every downstream "offline" symptom followed from
// this single mismatch.
//
// Verified against the plugin's Android source
// (android/src/main/java/com/aparajita/capacitor/securestorage/SecureStorage.java):
//   internalSetItem({ prefixedKey, data, sync, access })  -> resolves empty
//   internalGetItem({ prefixedKey, sync })                -> { data: string|null }
//   internalRemoveItem({ prefixedKey, sync })             -> { success: boolean }
//
// The wrapper also PREFIXES every key with 'capacitor-storage_' before
// handing it to native. We must apply the same prefix ourselves, or
// keys written by one path wouldn't be found by the other.
const KEY_PREFIX = 'capacitor-storage_'; // matches SecureStorageBase.prefix in the plugin's own JS wrapper
const SYNC = false;                      // iOS Keychain iCloud-sync; the wrapper's default is false
const ACCESS_WHEN_UNLOCKED = 0;          // KeychainAccess.whenUnlocked — iOS only, ignored on Android

function prefixed(key) {
  return KEY_PREFIX + String(key);
}

/**
 * Reports which of the expected native methods the registered plugin
 * actually exposes. Used by the offline self-test (offlineSelfTest.js)
 * so a future plugin version that renames its native surface again is
 * diagnosable in seconds instead of by another round of guessing —
 * note there are open dependency bumps for this plugin to 8.x, which
 * is exactly the kind of change that caused this bug.
 */
function methodSurface() {
  const plugin = bridge();
  if (!plugin) return { available: false, methods: [] };
  const expected = ['internalSetItem', 'internalGetItem', 'internalRemoveItem', 'setItem', 'getItem', 'removeItem'];
  return {
    available: true,
    methods: expected.filter((m) => typeof plugin[m] === 'function'),
  };
}

export const SecureStorageBridge = {
  /** True only when running in the native app AND the plugin is registered. */
  isAvailable() {
    return !!bridge();
  },

  /** Diagnostic only — see methodSurface() above. */
  describe() {
    return methodSurface();
  },

  /** Returns the stored string, or null if absent / unavailable / on any error (including a timeout). Never throws. */
  async getItem(key) {
    const plugin = bridge();
    if (!plugin) { debugLog('getItem: plugin unavailable, key=', key); return null; }
    try {
      const result = await withTimeout(
        plugin.internalGetItem({ prefixedKey: prefixed(key), sync: SYNC }),
        `getItem(${key})`
      );
      // Native resolves { data: <string> } or { data: null } for a
      // missing key (NOT { value } — that was part of the original
      // mismatch described above).
      const value = (result && typeof result.data === 'string') ? result.data : null;
      debugLog('getItem key=', key, 'found=', value !== null);
      return value;
    } catch (err) {
      debugLog('getItem FAILED key=', key, 'err=', err?.message || err);
      console.warn('[SecureStorage] getItem failed, treating as absent:', err?.message || err);
      return null;
    }
  },

  /** Returns true on success, false on any failure (plugin unavailable, native error, timeout, etc). Never throws. */
  async setItem(key, value) {
    const plugin = bridge();
    if (!plugin) { debugLog('setItem: plugin unavailable, key=', key); return false; }
    try {
      await withTimeout(
        plugin.internalSetItem({
          prefixedKey: prefixed(key),
          data: String(value),
          sync: SYNC,
          access: ACCESS_WHEN_UNLOCKED,
        }),
        `setItem(${key})`
      );
      debugLog('setItem OK key=', key);
      return true;
    } catch (err) {
      debugLog('setItem FAILED key=', key, 'err=', err?.message || err);
      console.warn('[SecureStorage] setItem failed:', err?.message || err);
      return false;
    }
  },

  /** Best-effort delete — never throws, doesn't report whether the key existed. */
  async removeItem(key) {
    const plugin = bridge();
    if (!plugin) return;
    try {
      await withTimeout(
        plugin.internalRemoveItem({ prefixedKey: prefixed(key), sync: SYNC }),
        `removeItem(${key})`
      );
      debugLog('removeItem OK key=', key);
    } catch (err) {
      debugLog('removeItem FAILED key=', key, 'err=', err?.message || err);
      console.warn('[SecureStorage] removeItem failed:', err?.message || err);
    }
  }
};
