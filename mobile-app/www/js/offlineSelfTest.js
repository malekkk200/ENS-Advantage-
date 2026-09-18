/* ═══════════════════════════════════════════════════════════════
   OFFLINE SELF-TEST
   ───────────────────────────────────────────────────────────────
   Exercises every link in the offline-download chain on the REAL
   device and reports, in plain language, exactly which one fails.

   Why this exists: the offline feature has now been "fixed" several
   times based on reading the code alone, and each fix addressed a
   real bug that nonetheless wasn't THE bug the student was hitting.
   Reading code can't observe what a specific Android WebView
   actually does with Cache Storage, the native Keystore bridge, or
   an async session restore on a cold offline launch. This can.

   Everything here is read-only apart from writing and then deleting
   one small test entry under a reserved id — it never touches real
   cached lessons, never uploads anything, and never prints key
   material (only whether a key could be obtained and whether a
   round-trip decrypt matched).
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';
import { SecureStorageBridge } from './secureStorage.js';
import { MaterialCache } from './materialCache.js';
import { CourseMaterials } from './courseMaterials.js';

const TEST_ID = '__offline_selftest__';

function line(ok, label, detail) {
  return { ok, label, detail: detail ?? '' };
}

export const OfflineSelfTest = {
  /**
   * Runs the full chain and returns an array of { ok, label, detail }.
   * Never throws — a thrown error anywhere becomes a failed line, so
   * the report always renders.
   */
  async run() {
    const results = [];

    // 1. Platform capabilities the whole feature rests on.
    results.push(line(
      typeof window.caches !== 'undefined',
      'Cache Storage API available',
      typeof window.caches === 'undefined' ? 'MISSING — offline caching cannot work at all in this WebView' : ''
    ));
    results.push(line(
      !!(window.crypto && window.crypto.subtle),
      'Web Crypto (subtle) available',
      !window.crypto?.subtle ? 'MISSING — encryption cannot work; note this requires a secure context' : ''
    ));
    results.push(line(
      !!window.isSecureContext,
      'Running in a secure context',
      window.isSecureContext ? '' : 'NOT SECURE — crypto.subtle is unavailable outside https/localhost origins'
    ));

    // 2. Native secure storage (where the AES key lives).
    // Report the plugin's actual method surface first: a mismatch here
    // between what the plugin exposes natively and what this app calls
    // was the ACTUAL root cause of offline mode never working (the app
    // called setItem/getItem, which only exist in the plugin's JS
    // wrapper — natively it implements internalSetItem/internalGetItem).
    // If this feature ever breaks again after a plugin upgrade, this
    // line will say so immediately.
    try {
      const surface = SecureStorageBridge.describe();
      const hasInternal = surface.methods.includes('internalSetItem') && surface.methods.includes('internalGetItem');
      results.push(line(
        surface.available && hasInternal,
        'Secure storage plugin method surface',
        !surface.available
          ? 'Plugin NOT REGISTERED on this platform (expected on web/browser; a problem in the native app).'
          : `exposes: ${surface.methods.join(', ') || '(none of the expected methods!)'}`
            + (hasInternal ? '' : ' — MISSING internalSetItem/internalGetItem, which this app calls. The plugin API likely changed; secureStorage.js needs updating to match.')
      ));
    } catch (err) {
      results.push(line(false, 'Secure storage plugin method surface', 'THREW: ' + (err?.message || err)));
    }

    let secureOk = false;
    try {
      const probeKey = '__selftest_probe__';
      const wrote = await SecureStorageBridge.setItem(probeKey, 'ok');
      const readBack = wrote ? await SecureStorageBridge.getItem(probeKey) : null;
      await SecureStorageBridge.removeItem(probeKey).catch(() => {});
      secureOk = wrote && readBack === 'ok';
      results.push(line(
        secureOk,
        'Secure storage (Keystore/Keychain) read+write',
        secureOk
          ? ''
          : `FAILED — setItem returned ${wrote}, getItem returned ${JSON.stringify(readBack)}. Without this the encryption key cannot persist, so nothing can be cached.`
      ));
    } catch (err) {
      results.push(line(false, 'Secure storage (Keystore/Keychain) read+write', 'THREW: ' + (err?.message || err)));
    }

    // 3. Identity — this is what the encryption key name is derived
    //    from, and getting it wrong is what silently makes every
    //    cached file undecryptable.
    const liveId = State.currentUser?.id || null;
    let rememberedOwner = null;
    try { rememberedOwner = localStorage.getItem('ensCacheKeyOwner_v1'); } catch (_) {}
    results.push(line(
      !!(liveId || rememberedOwner),
      'Account identity known (for key derivation)',
      `live session id: ${liveId ? liveId.slice(0, 8) + '…' : 'NOT YET RESOLVED'} | remembered key owner: ${rememberedOwner ? rememberedOwner.slice(0, 8) + '…' : 'none'}`
      + (!liveId && !rememberedOwner ? ' — key would fall back to "anon", which cannot decrypt files written while signed in' : '')
    ));
    if (liveId && rememberedOwner && liveId !== rememberedOwner) {
      results.push(line(false, 'Key owner matches signed-in account',
        'MISMATCH — files were encrypted under a different account on this device; they cannot be decrypted by the current one.'));
    }

    // 4. The actual round trip: encrypt -> store -> read back ->
    //    decrypt -> compare. This is the single most informative
    //    check here, because it exercises the exact same code path a
    //    real lesson uses.
    try {
      const payload = new TextEncoder().encode('offline-selftest-payload-v1').buffer;
      await MaterialCache.write(TEST_ID, payload);
      const back = await MaterialCache.read(TEST_ID);
      const matched = !!back && new TextDecoder().decode(back) === 'offline-selftest-payload-v1';
      results.push(line(
        matched,
        'Encrypted write → read → decrypt round trip',
        matched
          ? 'Content can be stored and read back correctly on this device.'
          : (back ? 'Read back, but decrypted content did not match.' : 'Nothing could be read back — the write silently failed (see the checks above for why).')
      ));
      await MaterialCache.evict(TEST_ID).catch(() => {});
    } catch (err) {
      results.push(line(false, 'Encrypted write → read → decrypt round trip', 'THREW: ' + (err?.message || err)));
    }

    // 5. What's actually cached right now, and whether the catalog
    //    the app has offline agrees with it.
    try {
      let cachedCount = 0;
      if (typeof window.caches !== 'undefined') {
        const cache = await caches.open('ens-materials-v2');
        cachedCount = (await cache.keys()).length;
      }
      let recordCount = 0;
      try {
        recordCount = Object.keys(JSON.parse(localStorage.getItem('ensOfflineLicenses') || '{}')).length;
      } catch (_) {}
      results.push(line(
        true,
        'Currently stored on this device',
        `${cachedCount} encrypted file(s) in cache, ${recordCount} download record(s).`
        + (cachedCount !== recordCount ? ' (These disagreeing is normal right after an eviction, but a large gap is worth reporting.)' : '')
      ));
    } catch (err) {
      results.push(line(false, 'Currently stored on this device', 'THREW: ' + (err?.message || err)));
    }

    // 6. Offline catalog — without this, the app can't even list the
    //    lessons to open them, regardless of whether their bytes are
    //    cached.
    try {
      await CourseMaterials.load();
      // load() populates the module's own _cache Map rather than
      // returning it, so read that directly (checked against
      // courseMaterials.js — it is a Map keyed "sem:module:category").
      const cache = CourseMaterials._cache;
      const groups = cache instanceof Map ? cache.size : 0;
      let materials = 0;
      if (cache instanceof Map) {
        for (const arr of cache.values()) materials += Array.isArray(arr) ? arr.length : 0;
      }
      results.push(line(
        !!groups,
        'Offline course catalog present',
        groups
          ? `${groups} module/category group(s), ${materials} material(s) listed.`
          : 'EMPTY — the app has no cached list of materials, so nothing can be opened offline even if files are cached.'
      ));
    } catch (err) {
      results.push(line(false, 'Offline course catalog present', 'THREW: ' + (err?.message || err)));
    }

    results.push(line(true, 'Network state at time of test', navigator.onLine === false ? 'OFFLINE (this is the state we want to test in)' : 'ONLINE — re-run this with airplane mode ON to test real offline behaviour'));

    return results;
  },

  /** Runs the test and renders a readable report into an alert-style modal. */
  async runAndShow() {
    const results = await this.run();
    const pass = results.filter(r => r.ok).length;
    const text = results
      .map(r => `${r.ok ? '✅' : '❌'} ${r.label}${r.detail ? '\n     ' + r.detail : ''}`)
      .join('\n\n');
    const summary = `OFFLINE SELF-TEST — ${pass}/${results.length} checks passed\n\n${text}`;
    // Deliberately a plain alert: this has to work even when the app's
    // own UI is in whatever broken state prompted running it.
    window.alert(summary);
    console.log('[OfflineSelfTest]\n' + summary);
    return summary;
  }
};
