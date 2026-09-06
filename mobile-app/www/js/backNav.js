/* ═══════════════════════════════════════════════════════════════
   BACK-GESTURE / BACK-BUTTON NAVIGATION GUARD
   ───────────────────────────────────────────────────────────────
   This is a single-page app that never pushes any history entries
   of its own. On mobile that means a back-swipe gesture (or the
   Android hardware/gesture back action) falls straight through to
   the browser/OS, which just exits the page or reloads it — instead
   of closing whatever overlay (PDF viewer, lesson/guide viewer,
   subscription modal, admin panels…) is currently open.

   Fix: every overlay pushes one history entry the moment it opens,
   and registers its own close() as the handler for the next
   `popstate` (back navigation). So:
     • Back gesture while an overlay is open  → just closes the
       overlay, exactly like tapping its own ✕ button. The page
       itself is never left/reloaded.
     • Back gesture with nothing open         → behaves exactly as
       before (native browser back / app exit).

   Overlays can also be closed the "normal" way (✕ button, tapping
   the backdrop, an auto-timeout, etc.) — in every one of those
   cases the overlay's close() calls BackNav.notifyClose(), which
   quietly consumes the history entry we pushed (via history.back())
   so it doesn't pile up as a dead entry the *next* back gesture has
   to click through.
═══════════════════════════════════════════════════════════════ */
export const BackNav = {
  _stack: [],          // one closeFn per currently-pushed history entry
  _pendingBacks: 0,     // programmatic history.back() calls we issued ourselves
  _inPopstate: false,   // true while a fn() is running because of a real popstate

  init() {
    window.addEventListener('popstate', () => {
      if (this._pendingBacks > 0) {
        // This popstate is the result of our own notifyClose() calling
        // history.back() — the overlay already closed itself through
        // the normal code path, so just keep the stack in sync.
        this._pendingBacks--;
        this._stack.pop();
        return;
      }
      const fn = this._stack.pop();
      if (fn) {
        this._inPopstate = true;
        fn();
        this._inPopstate = false;
      }
    });
  },

  /**
   * Call once, right after an overlay becomes visible. closeFn should
   * be that overlay's own close() — the function that just hides the
   * DOM again (it does NOT need to know anything about history).
   */
  push(closeFn) {
    history.pushState({ ensOverlay: true }, '');
    this._stack.push(closeFn);
  },

  /**
   * Call from the top of every overlay's close(). No-ops safely if
   * this close wasn't triggered by a back-gesture/pushed entry (e.g.
   * defensive double-close, or an overlay that never pushed).
   */
  notifyClose() {
    if (this._inPopstate) return; // already unwinding from a back-gesture
    if (this._stack.length === 0) return;
    this._pendingBacks++;
    history.back();
  },

  /** True while any overlay is open (i.e. we're not on the bare Home/Main screen). */
  hasOpenOverlay() {
    return this._stack.length > 0;
  }
};
