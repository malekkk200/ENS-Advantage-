/* ═══════════════════════════════════════════════════════════════
   DEVICE INTEGRITY (root / jailbreak / tamper check)
   ───────────────────────────────────────────────────────────────
   Consulted immediately before MaterialCache decrypts anything
   offline (see materialCache.js) — the "RASP check prior to
   triggering offline decryption" requirement.

   Two tiers, and it's important to be honest about the difference:

   1. NATIVE (mobile app only, when DeviceIntegrityPlugin is
      registered — see mobile-app/android/.../DeviceIntegrityPlugin.java
      and mobile-app/ios/.../DeviceIntegrityPlugin.swift, shipped
      alongside this file but requiring a native build step this
      environment can't perform — see those files' own headers).
      This is a REAL, OS-level check: reading actual filesystem paths
      and build properties a plain WebView script cannot see or
      spoof from JS. Still bypassable in principle by a sufficiently
      determined attacker (root-hiding tools like Magisk's
      DenyList/Zygisk exist specifically to defeat checks like this),
      but it takes real, deliberate effort — not a few lines in
      devtools.

   2. JS FALLBACK (used whenever the native plugin isn't present —
      always on web, and on mobile until the native plugin above is
      actually built in). This can only observe signals available to
      a same-page script, every one of which a moderately capable
      attacker can spoof by simply editing the very same script
      before it runs. It is genuinely useful as a deterrent against
      casual tampering (the median student poking at devtools out of
      curiosity) and as defense-in-depth alongside the encryption
      that does the real work — it is not, and cannot be, a hard
      security boundary on its own. Nothing in this codebase should
      ever treat a `compromised: false` result from this tier as a
      strong guarantee.

   Either way, `check()` NEVER blocks normal use for a false positive
   past the point of reasonable doubt — see the "signals" design: a
   single weak signal on the JS tier is logged but not enforced,
   only a native "rooted/jailbroken: true" or 2+ corroborating JS
   signals actually gate offline decryption. A paying student on an
   ordinary phone should never see this trigger.
═══════════════════════════════════════════════════════════════ */

let _cached = null; // memoized for the lifetime of this page load — device root status doesn't change mid-session

function _nativePlugin() {
  try {
    return window.Capacitor?.isNativePlatform?.() ? (window.Capacitor.Plugins?.DeviceIntegrity || null) : null;
  } catch (_) {
    return null;
  }
}

/** Weak, JS-only heuristics — see file header. Each one alone is common/benign; only counted together. */
function _jsHeuristics() {
  const signals = [];

  // A debugger statement that returns almost instantly means nothing is
  // attached; a multi-hundred-ms pause is the classic signal that
  // devtools (or an attached remote debugger) is open and stepping
  // through code. Same underlying idea as protection.js's window-size
  // devtools check, just harder to spoof by resizing a window.
  try {
    const t0 = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if (performance.now() - t0 > 100) signals.push('debugger_pause');
  } catch (_) {}

  // A WebView reporting itself as a desktop browser, or a "mobile" user
  // agent with no native Capacitor bridge present, suggests the page is
  // being loaded outside the packaged app shell it expects.
  try {
    if (/Capacitor/i.test(navigator.userAgent) === false && window.Capacitor) {
      signals.push('bridge_ua_mismatch');
    }
  } catch (_) {}

  // window.outerWidth/outerHeight are 0 in some automation/headless
  // and repackaging toolchains that render but never open a real
  // window chrome.
  try {
    if (window.outerWidth === 0 || window.outerHeight === 0) signals.push('zero_outer_dimensions');
  } catch (_) {}

  return signals;
}

export const DeviceIntegrity = {
  /** Returns { compromised, signals, source }. Cheap after the first call (memoized). */
  async check() {
    if (_cached) return _cached;

    const native = _nativePlugin();
    if (native) {
      try {
        const result = await native.isCompromised();
        _cached = { compromised: !!result.rooted, signals: result.signals || [], source: 'native' };
        _report(_cached);
        return _cached;
      } catch (_) {
        // Plugin registered but the call itself failed (e.g. not yet
        // built into this particular binary) — fall through to the
        // JS tier rather than treating a plugin error as "compromised."
      }
    }

    const signals = _jsHeuristics();
    // Deliberately conservative: a single weak JS signal is common and
    // often benign (e.g. any developer actually testing the app) — only
    // 2+ corroborating signals are treated as an actual gate.
    _cached = { compromised: signals.length >= 2, signals, source: native ? 'native_unavailable' : 'js_fallback' };
    _report(_cached);
    return _cached;
  },

  /** Clears the memoized result — mainly for tests; not needed in normal app flow since integrity status shouldn't change mid-session. */
  _reset() { _cached = null; }
};

/** Reports a genuine finding to the same pipeline screenshot/recording events already use — see nativeBridge.js. Fire-and-forget, and only for an actual finding: a clean check on every single app open would just be noise, not signal. */
function _report(result) {
  if (!result.compromised || typeof window.__ensReportSecurityEvent !== 'function') return;
  const platform = window.Capacitor?.getPlatform?.() || 'web';
  window.__ensReportSecurityEvent('device_integrity_flagged', {
    platform,
    context: `source=${result.source} signals=${result.signals.join(',')}`,
  });
}
