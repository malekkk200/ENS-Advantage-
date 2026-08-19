/* ═══════════════════════════════════════════════════════════════
   WATERMARK — shared builder for PDF pages + HTML lesson content
   ───────────────────────────────────────────────────────────────
   Not a screenshot BLOCKER (nothing can be, on the web — see the
   README notes on protection.js). This is a screenshot DETERRENT:
   every tile carries the viewing student's name, email, and the
   exact date/time the page was opened, so a screenshot that gets
   shared is traceable back to a specific account and a specific
   session — which is what actually makes account termination /
   ToS enforcement possible after a leak, rather than just hoping
   nobody takes one.

   Deliberately dense + real-opacity (not near-invisible) so it
   survives being re-compressed/re-shared as a JPEG screenshot and
   is still legible — a watermark nobody can read isn't a deterrent.
═══════════════════════════════════════════════════════════════ */
import { State } from './state.js';

/** Builds "First Last · email · date, time" (or just email if no profile name yet). */
export function watermarkText() {
  if (!State.currentUser || !State.currentProfile) return null;
  const name = `${State.currentProfile.first_name || ''} ${State.currentProfile.last_name || ''}`.trim();
  const email = State.currentUser.email || '';
  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return `${name ? name + ' · ' : ''}${email} · ${stamp}`;
}

/**
 * Paints a dense, staggered tile grid of the watermark text into
 * `layer`. Re-run this every time content is opened (not cached) so
 * the timestamp in the watermark reflects the actual viewing moment.
 */
export function paintWatermark(layer, opts = {}) {
  const {
    className = 'watermark-text',
    rows = 12,
    cols = 5,
    rowSpacing = 95,
    colSpacing = 165,
  } = opts;

  layer.innerHTML = '';
  const text = watermarkText();
  if (!text) return;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const el = document.createElement('div');
      el.className = className;
      el.textContent = text;
      // Stagger alternating columns vertically so tiles don't line up
      // into columns a crop could slip between.
      el.style.top = (r * rowSpacing + (c % 2 === 0 ? 18 : rowSpacing / 2)) + 'px';
      el.style.left = (c * colSpacing - 70) + 'px';
      layer.appendChild(el);
    }
  }
}
