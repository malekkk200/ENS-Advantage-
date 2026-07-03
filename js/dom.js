/* ═══════════════════════════════════════════════════════════════
   DOM HELPERS
   ───────────────────────────────────────────────────────────────
   Small, dependency-light DOM utilities used across almost every
   other module: the `$` shorthand, an HTML-escaping helper for
   safely interpolating user/DB strings into innerHTML, and the
   IntersectionObserver-based scroll-reveal-on-scroll animation.
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';

/* ─────────────────────────────────────────────────────────────
   SMALL DOM HELPERS
───────────────────────────────────────────────────────────── */
export const $ = (id) => document.getElementById(id);

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─────────────────────────────────────────────────────────────
   SCROLL REVEAL
───────────────────────────────────────────────────────────── */
export function initScrollReveal() {
  if (!State.scrollObserver) {
    State.scrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('active');
          const delayStr = entry.target.style.animationDelay || '0s';
          const delayMs = parseFloat(delayStr) * 1000;
          setTimeout(() => {
            entry.target.classList.remove('reveal', 'reveal-left', 'reveal-right', 'active');
            entry.target.style.animationDelay = '';
          }, 800 + delayMs + 50);
          State.scrollObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  }
  document.querySelectorAll('.reveal:not(.active), .reveal-left:not(.active), .reveal-right:not(.active)')
    .forEach(el => State.scrollObserver.observe(el));
}

