/* ═══════════════════════════════════════════════════════════════
   MOBILE APP SHELL — bottom nav routing, profile bottom sheet,
   standalone-mode detection, boot skeleton, touch feedback.
   ───────────────────────────────────────────────────────────────
   Purely additive: it only ever adds classes / attaches listeners
   to elements that already exist for desktop (the header, the user
   dropdown) or to new elements that are display:none outside the
   mobile media query (css/mobile-app.css). No desktop behavior,
   routing, or state is touched. If anything here throws, it fails
   silently — it must never block the real app from loading.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';

const MOBILE_MQ = window.matchMedia('(max-width: 768px)');

export const MobileApp = {
  init() {
    try {
      this.detectStandalone();
      this.wireBottomNav();
      this.wireProfileSheet();
      this.wireActiveSectionTracking();
      this.wireTouchFeedback();
      this.armBootSkeletonFallback();
    } catch (e) { console.error('MobileApp.init:', e); }
  },

  /* Installed-PWA detection, parity with the app-mode.css safe-area
     handling but for a browser-installed PWA rather than the
     Capacitor native shell. Only adds a class; changes no markup. */
  detectStandalone() {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true; // iOS Safari
    if (isStandalone) {
      document.documentElement.classList.add('pwa-standalone');
    }
  },

  /* Bottom nav → scrolls to the matching section. Reuses the same
     section ids the desktop nav / anchor links already use. */
  wireBottomNav() {
    const nav = $('bottom-nav');
    if (!nav) return;
    nav.querySelectorAll('.bottom-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        if (targetId === 'profile') {
          this.openProfileSheet();
          return;
        }
        const el = document.getElementById(targetId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  },

  /* Highlights the bottom-nav item matching the section currently
     in view, using IntersectionObserver (cheap, no scroll-handler
     math). Desktop has no equivalent chrome, so this is a no-op
     there — the observer still runs but nothing reads its output
     since .bottom-nav is display:none. */
  wireActiveSectionTracking() {
    const nav = $('bottom-nav');
    if (!nav || !('IntersectionObserver' in window)) return;
    const ids = ['top', 'curriculum-section', 'calculator-section', 'community-section-anchor'];
    const sections = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (!sections.length) return;

    const setActive = (id) => {
      nav.querySelectorAll('.bottom-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-target') === id);
      });
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: '-40% 0px -50% 0px', threshold: 0 });

    sections.forEach(s => observer.observe(s));
  },

  /* Turns the existing desktop .user-dropdown into a bottom sheet
     on mobile: same element, same profile data, same Sign Out /
     admin buttons — just repositioned via CSS (see mobile-app.css)
     plus a backdrop and swipe-down-to-dismiss added here. */
  wireProfileSheet() {
    const dropdown = $('user-dropdown');
    if (!dropdown) return;

    let backdrop = $('sheet-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'sheet-backdrop';
      backdrop.className = 'sheet-backdrop';
      document.body.appendChild(backdrop);
    }
    if (!dropdown.querySelector('.bottom-sheet-handle')) {
      const handle = document.createElement('div');
      handle.className = 'bottom-sheet-handle';
      dropdown.prepend(handle);
    }

    const close = () => {
      dropdown.classList.add('hidden');
      backdrop.classList.remove('open');
    };
    backdrop.addEventListener('click', close);

    // Swipe-down-to-dismiss
    let startY = null;
    dropdown.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    dropdown.addEventListener('touchmove', (e) => {
      if (startY === null || !MOBILE_MQ.matches) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) dropdown.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    dropdown.addEventListener('touchend', (e) => {
      if (startY === null || !MOBILE_MQ.matches) return;
      const dy = e.changedTouches[0].clientY - startY;
      dropdown.style.transform = '';
      if (dy > 80) close();
      startY = null;
    });

    // Keep the backdrop in sync whenever anything else (existing
    // desktop toggleDropdown logic, outside-click handler, etc.)
    // shows or hides the dropdown.
    new MutationObserver(() => {
      if (!MOBILE_MQ.matches) return;
      const isOpen = !dropdown.classList.contains('hidden');
      backdrop.classList.toggle('open', isOpen);
    }).observe(dropdown, { attributes: true, attributeFilter: ['class'] });
  },

  openProfileSheet() {
    const dropdown = $('user-dropdown');
    if (dropdown) dropdown.classList.remove('hidden');
  },

  /* Tiny scale-down tap feedback on cards/buttons that don't
     already have their own :active treatment. Class-based, no
     inline styles, easy to extend to future components. */
  wireTouchFeedback() {
    if (!MOBILE_MQ.matches) return;
    document.querySelectorAll('.grading-card, .module-header, .bottom-nav-item, .chat-btn, .tab-btn')
      .forEach(el => el.classList.add('tap-feedback'));
  },

  /* Safety net: if router.js's render() call is ever skipped or
     throws before reaching its skeleton-removal line, don't leave
     the user stuck looking at a permanent skeleton. */
  armBootSkeletonFallback() {
    setTimeout(() => {
      const skel = $('app-boot-skeleton');
      if (skel) skel.remove();
    }, 6000);
  }
};
