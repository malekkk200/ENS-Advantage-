/* ═══════════════════════════════════════════════════════════════
   SUBSCRIPTION MODAL
   ───────────────────────────────────────────────────────────────
   The "Get Premium" modal: plan selection UI + submission of the
   subscription request to the submit-subscription Edge Function.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Supabase } from './supabaseClient.js';

/* ─────────────────────────────────────────────────────────────
   SUBSCRIPTION MODAL
───────────────────────────────────────────────────────────── */
export const Subscription = {
  PRICES: { S1: '2,000 DZD', S2: '2,000 DZD', BOTH: '3,500 DZD' },

  open(defaultSemester) {
    State.subModalDefaultSemester = defaultSemester;
    State.selectedPlan = defaultSemester === 2 ? 'S2' : 'S1';
    $('tx-ref').value = '';
    this.updateSubmitBtn();
    $('sub-success').classList.add('hidden');
    $('sub-normal').classList.remove('hidden');
    this.updatePlanUI();
    $('sub-modal').classList.remove('hidden');
    State.subModalOpen = true;
  },

  close() {
    $('sub-modal').classList.add('hidden');
    State.subModalOpen = false;
    $('sub-success').classList.add('hidden');
    $('sub-normal').classList.remove('hidden');
  },

  handleOverlayClick(e) {
    if (e.target === $('sub-modal')) this.close();
  },

  selectPlan(id) {
    State.selectedPlan = id;
    this.updatePlanUI();
  },

  updatePlanUI() {
    ['S1', 'S2', 'BOTH'].forEach((id) => {
      const el = $('plan-' + id);
      if (el) el.classList.toggle('selected', id === State.selectedPlan);
    });
    $('modal-price').textContent = this.PRICES[State.selectedPlan];
  },

  copy(text, id) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    const btn = $('copy-' + id);
    if (btn) {
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋 Copy';
        btn.classList.remove('copied');
      }, 2000);
    }
  },

  updateSubmitBtn() {
    const val = $('tx-ref').value.trim();
    $('sub-submit-btn').disabled = !val;
  },

  async submit() {
    const txVal = $('tx-ref').value.trim();
    if (!txVal) return;
    const btn = $('sub-submit-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Submitting…';

    const fullName = ((State.currentProfile?.first_name || '') + ' ' + (State.currentProfile?.last_name || '')).trim();

    // Route through the submit-subscription Edge Function which enforces:
    //  • rate limiting (max 3 requests per user per 24 h)
    //  • duplicate transaction reference detection
    //  • server-side identity verification via JWT (no user-supplied user_id)
    const { ok, json: respJson } = await Supabase.callFunction('submit-subscription', {
      full_name: fullName,
      plan: State.selectedPlan,
      transaction_ref: txVal
    });

    btn.disabled = false;
    btn.innerHTML = '✓ Confirm Payment &amp; Activate';

    if (!ok) {
      const errEl = document.createElement('div');
      errEl.className = 'error-msg';
      errEl.style.marginTop = '.75rem';
      errEl.textContent = respJson?.error || 'Submission failed. Please try again or contact support.';
      btn.parentNode.appendChild(errEl);
      setTimeout(() => errEl.remove(), 5000);
      return;
    }

    $('sub-normal').classList.add('hidden');
    $('sub-success').classList.remove('hidden');
    setTimeout(() => this.close(), 3500);
  }
};

