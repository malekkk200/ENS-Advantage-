/* ═══════════════════════════════════════════════════════════════
   RENDER ROUTER
   ───────────────────────────────────────────────────────────────
   The single top-level "what screen should be showing" decision.
   Split into its own tiny module because both auth.js and
   realtime.js need to trigger it, while it itself only needs
   State + UI — keeping it separate avoids a bigger circular
   dependency between auth.js and ui.js.
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';
import { UI } from './ui.js';

/* ─────────────────────────────────────────────────────────────
   RENDER ROUTER
───────────────────────────────────────────────────────────── */
export async function render() {
  // The real, authoritative auth decision is being made right now —
  // release the optimistic "returning-user" pre-paint reveal from
  // index.html's <head> (see its comment). Safe/idempotent to call
  // even when the class was never set.
  if (window.__authDebug) {
    window.__authDebug('router.render() fired. State.currentUser present:', !!State.currentUser, '| had .returning-user class:', document.documentElement.classList.contains('returning-user'));
  }
  document.documentElement.classList.remove('returning-user');

  if (!State.currentUser) {
    UI.showAuthLogin();
  } else if (!State.currentUser.email_confirmed_at) {
    UI.showAuthOtp();
  } else {
    await UI.showMainApp();
  }
}

