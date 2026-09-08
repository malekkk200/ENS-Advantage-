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
   past the point of reasonable doubt: only a native "rooted/jailbroken:
   true" result actually gates offline decryption. The JS-only tier
   below is advisory ONLY — it can observe a signal and report it, but
   it never sets `compromised: true` by itself. That's not the original
   design (an earlier version gated on 2+ JS signals too) — it was
   changed after a real false-positive in production: on the actual
   packaged app, `window.outerWidth`/`outerHeight` are legitimately 0 in
   many mobile WebViews as completely normal behavior (not a tamper
   signal at all — this is a well-documented WebView quirk, not
   specific to this app), and Capacitor does not tag its WebView's
   `navigator.userAgent` by default the way this file used to assume.
   Both of the checks built around those two assumptions were removed
   outright rather than "tuned" — see git history if you want the
   specifics — because the failure mode (silently blocking a paying
   student's offline caching, everywhere, always) is categorically
   worse than under-detecting. A paying student on an ordinary phone
   should never see this trigger, and now structurally cannot, from
   this tier.
═══════════════════════════════════════════════════════════════ */

let _cached = null; // memoized for the lifetime of this page load — device root status doesn't change mid-session

function _nativePlugin() {
  try {
    return window.Capacitor?.isNativePlatform?.() ? (window.Capacitor.Plugins?.DeviceIntegrity || null) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Advisory-only JS heuristics — see file header for why this tier
 * never gates anything by itself. Currently just one signal:
 * a `debugger;` statement that takes noticeably longer than
 * instantaneous to execute means something is actually stepping
 * through code (devtools paused, or a remote debugger attached).
 * Same underlying idea as protection.js's window-size devtools
 * check, just harder to spoof by resizing a window. Kept for
 * possible future use (e.g. surfacing it in a support/analytics
 * view) — never treated as a block on its own.
 */
function _jsHeuristics() {
  const signals = [];
  try {
    const t0 = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if (performance.now() - t0 > 100) signals.push('debugger_pause');
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

    // Advisory only — see file header. This tier NEVER sets
    // compromised: true; it can only report what it saw. Actual
    // blocking is reserved entirely for a genuine native finding above.
    const signals = _jsHeuristics();
    _cached = { compromised: false, signals, source: native ? 'native_unavailable' : 'js_fallback' };
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
