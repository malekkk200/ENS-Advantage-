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
  if (!State.currentUser) {
    UI.showAuthLogin();
  } else if (!State.currentUser.email_confirmed_at) {
    UI.showAuthOtp();
  } else {
    await UI.showMainApp();
  }
  // A real screen is now showing — remove the mobile boot skeleton
  // (see index.html / css/mobile-app.css §6). No-op on desktop,
  // where the element is never visible in the first place.
  document.getElementById('app-boot-skeleton')?.remove();
}

