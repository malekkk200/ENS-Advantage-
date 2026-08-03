/* ═══════════════════════════════════════════════════════════════
   SUBSCRIPTION MODAL
   ───────────────────────────────────────────────────────────────
   The "Get Premium" modal: plan selection UI + submission of the
   subscription request to the submit-subscription Edge Function.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Supabase, sb } from './supabaseClient.js';
import { BackNav } from './backNav.js';

/* ─────────────────────────────────────────────────────────────
   SUBSCRIPTION MODAL
───────────────────────────────────────────────────────────── */
const fmt = (n) => n.toLocaleString('en-US') + ' DZD';

export const Subscription = {
  BASE_PRICES: { S1: 2000, S2: 2000, BOTH: 3500 },
  DISCOUNT_RATE: 0.4, // new-student first-subscription offer

  discountedPrice(plan) {
    return Math.round(this.BASE_PRICES[plan] * (1 - this.DISCOUNT_RATE));
  },
  currentPrice(plan) {
    return State.discountEligible ? this.discountedPrice(plan) : this.BASE_PRICES[plan];
  },

  /**
   * "New student" = never had an APPROVED subscription before. This is only
   * used to decide what to *show*; the real, trusted decision is always
   * re-checked server-side in the submit-subscription Edge Function, which
   * ignores anything the client claims.
   */
  async checkDiscountEligibility() {
    if (!State.currentUser?.id) { State.discountEligible = false; return; }
    const { count } = await sb
      .from('subscription_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', State.currentUser.id)
      .eq('status', 'approved');
    State.discountEligible = (count ?? 0) === 0;
  },

  /**
   * Which plans this user is still allowed to buy, based on the access
   * flags already granted on their profile (source of truth — set by
   * the admin approving a previous request). Once one semester is
   * approved, "BOTH" no longer makes sense (it would just re-sell
   * something already partially owned) and that same semester can't
   * be bought again — only the other, still-missing semester can.
   */
  eligiblePlans() {
    const hasS1 = !!State.currentProfile?.has_s1_access;
    const hasS2 = !!State.currentProfile?.has_s2_access;
    if (hasS1 && hasS2) return [];
    if (hasS1) return ['S2'];
    if (hasS2) return ['S1'];
    return ['S1', 'S2', 'BOTH'];
  },

  async open(defaultSemester) {
    State.subModalDefaultSemester = defaultSemester;

    const eligible = this.eligiblePlans();
    // Pick a sensible default: the requested semester if it's still
    // purchasable, otherwise whichever single plan remains eligible.
    const preferred = defaultSemester === 2 ? 'S2' : 'S1';
    State.selectedPlan = eligible.includes(preferred) ? preferred : (eligible[0] || preferred);

    $('tx-ref').value = '';
    this.updateSubmitBtn();
    $('sub-success').classList.add('hidden');
    $('sub-normal').classList.remove('hidden');
    $('sub-modal').classList.remove('hidden');
    State.subModalOpen = true;
    BackNav.push(() => this.close());
    // Show the modal immediately with list prices, then upgrade to the
    // discounted view once eligibility comes back (usually instant).
    this.updatePlanUI();
    await this.checkDiscountEligibility();
    this.updatePlanUI();
  },

  close() {
    BackNav.notifyClose();
    $('sub-modal').classList.add('hidden');
    State.subModalOpen = false;
    $('sub-success').classList.add('hidden');
    $('sub-normal').classList.remove('hidden');
  },

  handleOverlayClick(e) {
    if (e.target === $('sub-modal')) this.close();
  },

  selectPlan(id) {
    if (!this.eligiblePlans().includes(id)) return; // defence in depth — card should already be hidden
    State.selectedPlan = id;
    this.updatePlanUI();
  },

  updatePlanUI() {
    const eligible = !!State.discountEligible;
    const banner = $('discount-banner');
    if (banner) banner.classList.toggle('hidden', !eligible);

    const eligiblePlans = this.eligiblePlans();

    ['S1', 'S2', 'BOTH'].forEach((id) => {
      const el = $('plan-' + id);
      if (!el) return;

      // A plan the user already owns (or "BOTH" once any one semester
      // is owned) simply disappears from the picker — nothing to
      // reconsider, so there's no reason to show it as an option.
      const isEligible = eligiblePlans.includes(id);
      el.classList.toggle('hidden', !isEligible);
      el.classList.toggle('selected', isEligible && id === State.selectedPlan);

      const priceEl = $('price-' + id);
      const origEl = $('price-orig-' + id);
      if (!priceEl) return;
      if (eligible) {
        priceEl.textContent = fmt(this.discountedPrice(id));
        if (origEl) { origEl.textContent = fmt(this.BASE_PRICES[id]); origEl.classList.remove('hidden'); }
      } else {
        priceEl.textContent = fmt(this.BASE_PRICES[id]);
        if (origEl) origEl.classList.add('hidden');
      }
    });

    const submitBtn = $('sub-submit-btn');
    const fullAccessNotice = $('sub-full-access-notice');
    if (eligiblePlans.length === 0) {
      // Already has full access to both semesters — nothing left to sell.
      $('modal-price').textContent = '—';
      if (submitBtn) submitBtn.disabled = true;
      if (fullAccessNotice) fullAccessNotice.classList.remove('hidden');
    } else {
      $('modal-price').textContent = fmt(this.currentPrice(State.selectedPlan));
      if (fullAccessNotice) fullAccessNotice.classList.add('hidden');
    }
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
    $('sub-submit-btn').disabled = !val || this.eligiblePlans().length === 0;
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

