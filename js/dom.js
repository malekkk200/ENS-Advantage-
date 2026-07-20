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
   SCROLL LOCK
   ───────────────────────────────────────────────────────────
   Used whenever a full-screen overlay (PDF viewer, content
   viewer/picker) opens, so the page behind it can't be scrolled
   at the same time.

   `document.body.style.overflow = 'hidden'` alone is NOT enough:
   iOS Safari still lets touch-scroll gestures move the page
   underneath a `position: fixed` overlay even with overflow
   hidden on body — a well-known iOS quirk. The reliable fix is to
   pin the body itself with `position: fixed` (restoring the exact
   scroll offset on unlock), which works everywhere.
───────────────────────────────────────────────────────────── */
let _lockedScrollY = 0;
let _lockCount = 0; // supports nested lock/unlock calls safely

export function lockBodyScroll() {
  _lockCount++;
  if (_lockCount > 1) return; // already locked by an outer caller
  _lockedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_lockedScrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll() {
  if (_lockCount === 0) return;
  _lockCount--;
  if (_lockCount > 0) return; // still locked by another caller
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  document.body.style.overflow = '';
  // Explicit 'instant' — not the 2-argument form, and not behavior:'auto'.
  // base.css sets `scroll-behavior: smooth` globally, and per spec
  // 'auto' means "follow the CSS scroll-behavior", so it would still
  // animate. The user never actually moved (position:fixed kept the
  // same content on screen the whole time this was locked), so an
  // animated scroll here just looks like the page glides back down to
  // a spot it was already showing — 'instant' bypasses that and snaps
  // back with no visible motion, matching what the user expects.
  window.scrollTo({ top: _lockedScrollY, left: 0, behavior: 'instant' });
}


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

