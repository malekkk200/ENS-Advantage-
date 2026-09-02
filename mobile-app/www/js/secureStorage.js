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

export const SecureStorageBridge = {
  /** True only when running in the native app AND the plugin is registered. */
  isAvailable() {
    return !!bridge();
  },

  /** Returns the stored string, or null if absent / unavailable / on any error (including a timeout). Never throws. */
  async getItem(key) {
    const plugin = bridge();
    if (!plugin) { debugLog('getItem: plugin unavailable, key=', key); return null; }
    try {
      const result = await withTimeout(plugin.getItem({ key }), `getItem(${key})`);
      // The plugin's low-level getItem() returns { value } (mirrors
      // @capacitor/preferences' shape by the author's own design —
      // see its README) or null/undefined for a missing key.
      const value = (result && typeof result.value === 'string') ? result.value : null;
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
      await withTimeout(plugin.setItem({ key, value: String(value) }), `setItem(${key})`);
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
      await withTimeout(plugin.removeItem({ key }), `removeItem(${key})`);
      debugLog('removeItem OK key=', key);
    } catch (err) {
      debugLog('removeItem FAILED key=', key, 'err=', err?.message || err);
      console.warn('[SecureStorage] removeItem failed:', err?.message || err);
    }
  }
};
