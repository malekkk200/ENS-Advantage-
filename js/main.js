/* ═══════════════════════════════════════════════════════════════
   ENS ADVANTAGE — APP ENTRY POINT
   ───────────────────────────────────────────────────────────────
   This is the only <script type="module"> loaded by index.html.
   It imports every feature module (each one is scoped to its own
   file — nothing leaks onto `window` from them individually),
   wires the single `App` namespace that the inline onclick="..."
   attributes in the HTML call into, registers the document-level
   listeners, and finally boots the app.

   Module map:
     config.js          — Supabase URL / anon key
     supabaseClient.js  — Supabase client + Edge Function helpers
     state.js           — the one and only mutable app state object
     dom.js             — $ / escHtml / scroll-reveal helpers
     curriculum.js      — module/UE data (loaded from DB)
     courseMaterials.js — PDF metadata cache (semester × module × category)
     router.js          — top-level render() screen router
     realtime.js        — postgres_changes subscription for profile updates
     auth.js            — login / signup / otp / logout
     ui.js               — header, dropdown, generic chrome
     modules.js          — semester tabs + module list rendering/expansion
     content.js          — lesson/guide viewer (HTML fallback path)
     pdfViewer.js         — secure canvas-based PDF renderer (primary path)
     protection.js        — anti-copy / anti-screenshot measures
     subscription.js      — the "Get Premium" modal + request submission
     community.js         — help popover + Telegram community card
     calc.js               — the grade calculator
     adminPanel.js         — no-code admin PDF upload panel
     memeSystem.js         — GPA-bracket meme player (session-only, zero student data)
     memeAdmin.js          — admin interface for meme catalog management
     appDownloadGate.js    — website-only "download the app" modal for Full Lesson taps
     materialCache.js      — encrypted on-device byte cache for free + paid lesson PDFs
     pdfExtras.js           — PDF viewer TOC / search / pan / dictionary / dark-sepia
     listeners.js          — document-level keydown/mousedown handlers
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Auth } from './auth.js';
import { UI } from './ui.js';
import { Modules } from './modules.js';
import { Content } from './content.js';
import { PDFViewer } from './pdfViewer.js';
import { PDFExtras } from './pdfExtras.js';
import { AdminPanel } from './adminPanel.js';
import { Protection } from './protection.js';
import { Subscription } from './subscription.js';
import { Community } from './community.js';
import { Calc } from './calc.js';
import { MemeSystem } from './memeSystem.js';
import { MemeAdmin } from './memeAdmin.js';
import { AppDownloadGate } from './appDownloadGate.js';
import { BackNav } from './backNav.js';

// Registers its own document-level 'mousedown' / 'keydown' listeners
// as a side effect of being imported — no exports needed.
import './listeners.js';
import './nativeBridge.js';

/* ─────────────────────────────────────────────────────────────
   PUBLIC SURFACE — the only thing this module puts on `window`.
   Inline onclick="App.X.y()" handlers in the HTML call into this.
───────────────────────────────────────────────────────────── */
window.App = { Auth, UI, Modules, Content, PDFViewer, PDFExtras, AdminPanel, Protection, Subscription, Community, Calc, State, MemeAdmin, AppDownloadGate };

/* ─────────────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────────────── */
// Copy logo synchronously — before any async call so it appears instantly
(function initLogo() {
  const src = document.querySelector('.header-logo img')?.src;
  if (src) {
    const a = $('auth-logo-img');
    if (a) a.src = src;
  }
})();

// Must be initialized before any overlay can possibly open, so the
// very first back-gesture is already handled correctly.
BackNav.init();

// Wires the PDF viewer's pan-tool / tap-to-define listeners once,
// up front — the canvas zone element exists (hidden) in the static
// markup from first paint, so this is safe to do at boot rather than
// on every PDFViewer.open().
PDFExtras.initGlobalListeners();

Auth.loadState();

// Kick off background catalog fetch for the meme system (non-blocking).
// Must run after page is interactive — does not affect TTI/LCP.
// No student data is involved; this only fetches meme metadata (URLs + categories).
MemeSystem.init();
