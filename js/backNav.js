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
  },

  /**
   * Swaps which close() handler answers for the CURRENTLY pushed history
   * entry, without changing history depth. Use this when one overlay is
   * being replaced by another at the same navigation "level" (e.g. a
   * material picker immediately opening the chosen PDF) instead of
   * calling notifyClose() (which triggers an async history.back()) and
   * then push() (a synchronous history.pushState()) back to back.
   *
   * That close-then-push sequence used to be how this transition was
   * handled, and it raced: history.back() only resolves on a later task,
   * but the very next line's pushState() runs immediately — so the
   * pushState could (and in practice did) land before the browser had
   * actually traversed anywhere, leaving this module's internal stack
   * out of sync with the real history position by one entry. The visible
   * symptom: everything looked fine until the user's NEXT back press,
   * which silently fell through an entry that no longer matched what was
   * on screen, and the press after THAT exited the site straight to
   * whatever page opened it (e.g. a Google search results page).
   *
   * replaceState() is synchronous and never triggers a popstate, so
   * there's nothing here to race.
   */
  replaceTop(closeFn) {
    if (this._stack.length === 0) { this.push(closeFn); return; }
    history.replaceState({ ensOverlay: true }, '');
    this._stack[this._stack.length - 1] = closeFn;
  }
};
