/* ═══════════════════════════════════════════════════════════════
   DOCUMENT-LEVEL LISTENERS (outside-click closing, Enter-to-submit)
   ───────────────────────────────────────────────────────────────
   NOTE: the original monolithic file referenced these through the
   `App.PDFViewer` global namespace since everything lived in one
   scope. Now that PDFViewer is an importable module, these call it
   directly — behaviourally identical (App.PDFViewer === PDFViewer),
   just without the unnecessary indirection through `window.App`.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Auth } from './auth.js';
import { PDFViewer } from './pdfViewer.js';

/* ─────────────────────────────────────────────────────────────
   DOCUMENT-LEVEL LISTENERS (outside-click closing, Enter-to-submit)
───────────────────────────────────────────────────────────── */
document.addEventListener('mousedown', (e) => {
  const chip = $('user-chip');
  if (chip && !chip.contains(e.target)) {
    State.dropdownOpen = false;
    $('user-dropdown').classList.add('hidden');
  }
  const helpBtn = $('help-btn');
  const helpPop = $('help-popover');
  if (helpBtn && helpPop && !helpBtn.contains(e.target) && !helpPop.contains(e.target)) {
    State.helpPopoverOpen = false;
    helpPop.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  // PDF viewer keyboard nav (takes priority when viewer is open)
  if (State.pdfViewerActive) {
    if (e.key === 'Escape')     { PDFViewer.close(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  { PDFViewer.nextPage(); return; }
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')    { PDFViewer.prevPage(); return; }
  }

  if (e.key !== 'Enter') return;
  if (!$('auth-screen').classList.contains('hidden')) {
    if (!$('auth-card-otp').classList.contains('hidden')) {
      Auth.verifyOtp();
    } else if (!$('auth-card-forgot').classList.contains('hidden')) {
      Auth.forgotPassword();
    } else if (!$('auth-card-new-password').classList.contains('hidden')) {
      Auth.resetPassword();
    } else if (State.currentAuthMode === 'login') {
      Auth.login();
    } else {
      Auth.signup();
    }
  }
});

