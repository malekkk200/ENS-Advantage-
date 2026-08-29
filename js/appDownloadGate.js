/* ═══════════════════════════════════════════════════════════════
   APP DOWNLOAD GATE  (website only)
   ───────────────────────────────────────────────────────────────
   Full lessons are no longer rendered on the website. When a
   subscribed student taps "Full Lesson" on the web, Content.open()
   intercepts before any content is fetched and calls open() here
   instead, which shows a simple modal directing them to the app.

   This file has no counterpart in mobile-app/www — the native app
   is exactly where full lessons ARE still viewed directly (via
   PDFViewer / the HTML content overlay, unchanged there), so it has
   no reason to gate itself.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { BackNav } from './backNav.js';

// Single source of truth for the download link — update this one
// constant once the real hosting link is ready; nothing else in the
// app needs to change.
const APP_DOWNLOAD_LINK = "MEDIAFIRE_LINK_PLACEHOLDER";

export const AppDownloadGate = {
  open() {
    const link = $('app-gate-download-btn');
    if (link) {
      // Set on every open (not just once at module load) so a later
      // edit to APP_DOWNLOAD_LINK during development/testing is
      // always reflected without needing a hard refresh to matter.
      link.href = APP_DOWNLOAD_LINK;
    }
    $('app-gate-modal').classList.remove('hidden');
    State.appGateOpen = true;
    BackNav.push(() => this.close());
  },

  close() {
    BackNav.notifyClose();
    $('app-gate-modal').classList.add('hidden');
    State.appGateOpen = false;
  },

  handleOverlayClick(e) {
    if (e.target === $('app-gate-modal')) this.close();
  }
};
