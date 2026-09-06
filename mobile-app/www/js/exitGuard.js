/* ═══════════════════════════════════════════════════════════════
   DOUBLE BACK-PRESS TO EXIT (mobile app only)
   ───────────────────────────────────────────────────────────────
   Without a listener, Capacitor's default Android back-button
   behavior is: if the WebView has in-page history to go back
   through, go back; otherwise exit immediately on the very first
   press. This app never accumulates real WebView history (BackNav
   drives everything through its own synthetic pushState stack), so
   that default meant a single accidental back press on the Home
   screen closed the app outright with zero warning.

   This adds the standard "press back again to exit" pattern, scoped
   exactly to when the user is on the Home/Main screen (signed in,
   nothing else open):
     • Anything open (PDF viewer, lesson viewer, a modal, a dropdown…)
       → back behaves exactly as it already does: BackNav closes it.
       This module doesn't touch that path at all.
     • On Home/Main with nothing open → first press shows a brief
       toast and arms a 2s window; a second press inside that window
       exits the app. Letting the window lapse just re-arms on the
       next press, same as the pattern on virtually every Android app.
     • Not signed in yet (auth/OTP screens) and nothing open → exits
       immediately on the first press, same as the previous default.
       There's no "Home" to protect there, and no in-app history to
       step back through either.

   Talks to the native side via window.Capacitor.Plugins.App directly
   — the raw Capacitor bridge, same low-level calling convention
   secureStorage.js already uses in this project. There's no bundler
   here, so the @capacitor/app npm package's JS wrapper is never
   loaded, but Capacitor still exposes every registered native plugin
   at that path regardless of whether its convenience wrapper is
   present. Entirely inert outside the native app (a plain browser
   tab, or the packaged app before native bridge init finishes):
   window.Capacitor.isNativePlatform() is simply false there, so
   init() below no-ops.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { BackNav } from './backNav.js';

const EXIT_WINDOW_MS = 2000; // standard Android "press back again" grace period

let _armedAt = 0;

function _capApp() {
  try {
    return window.Capacitor?.isNativePlatform?.() ? (window.Capacitor.Plugins?.App || null) : null;
  } catch (_) {
    return null;
  }
}

/** "Home/Main page" = signed in, main app shown, and nothing else — PDF
 * viewer, lesson/guide viewer, subscription modal, admin panel, a
 * dropdown, etc. — currently open. BackNav's stack is empty exactly
 * when that's true, since every overlay in this app pushes onto it
 * the moment it opens (see backNav.js). */
function _isOnHome() {
  return !!State.currentUser && !BackNav.hasOpenOverlay();
}

function _showExitToast() {
  const toast = $('exit-guard-toast');
  if (!toast) return;
  toast.classList.remove('hidden');
  // Re-trigger the CSS animation even if it's already mid-fade from a
  // very recent previous press — same restart trick protection.js
  // uses for its own toast.
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = 'slideDown .3s ease, fadeOutToast 3s forwards';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.add('hidden'), EXIT_WINDOW_MS + 300);
}

export const ExitGuard = {
  init() {
    const plugin = _capApp();
    if (!plugin) return; // plain web tab, or plugin not registered — nothing to wire up

    plugin.addListener('backButton', () => {
      if (BackNav.hasOpenOverlay()) {
        // Something is open — let the existing back-gesture handling
        // close it, exactly as it already does for a swipe-back.
        history.back();
        return;
      }

      if (!_isOnHome()) {
        // Not signed in yet (auth/OTP screens) and nothing open — no
        // "Home" to protect here, so preserve the previous single-
        // press-exits behavior rather than introducing a new delay
        // on a screen this feature was never asked to cover.
        plugin.exitApp();
        return;
      }

      const now = Date.now();
      if (now - _armedAt < EXIT_WINDOW_MS) {
        plugin.exitApp();
        return;
      }
      _armedAt = now;
      _showExitToast();
    });
  }
};
