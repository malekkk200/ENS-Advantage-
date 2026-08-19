/* ═══════════════════════════════════════════════════════════════
   COMMUNITY (help popover + Telegram community card)
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Subscription } from './subscription.js';

/* ─────────────────────────────────────────────────────────────
   COMMUNITY (help popover + Telegram card)
───────────────────────────────────────────────────────────── */
export const Community = {
  handleChat() {
    if (State.hasAnyPremium()) {
      window.open('https://t.me/+3CER_-lPAbs5ZTRk', '_blank', 'noopener,noreferrer');
    } else {
      Subscription.open(undefined);
    }
  },
  updateNote() {
    const note = $('community-premium-note');
    if (note) note.style.display = State.hasAnyPremium() ? 'none' : 'block';
  }
};

