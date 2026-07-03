/* ═══════════════════════════════════════════════════════════════
   UI — auth screens, header, dropdown
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Curriculum } from './curriculum.js';
import { CourseMaterials } from './courseMaterials.js';
import { Protection } from './protection.js';
import { Realtime } from './realtime.js';
import { Modules } from './modules.js';
import { Community } from './community.js';
import { AdminPanel } from './adminPanel.js';
import { Calc } from './calc.js';

/* ─────────────────────────────────────────────────────────────
   UI — auth screens, header, dropdown
───────────────────────────────────────────────────────────── */
export const UI = {
  showAuthLogin() {
    $('auth-screen').classList.remove('hidden');
    $('auth-card-main').classList.remove('hidden');
    $('auth-card-otp').classList.add('hidden');
    $('auth-card-forgot').classList.add('hidden');
    $('auth-card-new-password').classList.add('hidden');
    $('main-app').classList.add('hidden');
    Protection.deactivate();
    Realtime.teardown();
  },

  showAuthOtp() {
    $('auth-screen').classList.remove('hidden');
    $('auth-card-main').classList.add('hidden');
    $('auth-card-otp').classList.remove('hidden');
    $('main-app').classList.add('hidden');
    const email = State.currentUser?.email || localStorage.getItem('ens_pending_email') || '';
    if (email) $('otp-email-display').textContent = email;
    Protection.deactivate();
  },

  async showMainApp() {
    $('auth-screen').classList.add('hidden');
    $('main-app').classList.remove('hidden');
    this.updateHeader();

    // Fetch curriculum and course-material metadata in parallel.
    // Both are cached — subsequent calls return immediately.
    await Promise.all([
      Curriculum.load(),
      CourseMaterials.load()
    ]);

    Modules.render(true);
    Modules.updatePremiumNotice();
    $('footer-year').textContent =
      '© ' + new Date().getFullYear() + ' ENS Advantage. All rights reserved. Content protected by anti-theft technology.';
    Community.updateNote();
    Protection.activate();
    Realtime.setup();
    Calc.init();
  },

  updateHeader() {
    if (!State.currentProfile) return;
    const fn = State.currentProfile.first_name || '';
    const ln = State.currentProfile.last_name || '';
    const initials = ((fn[0] || '') + (ln[0] || '')).toUpperCase() || '?';
    $('user-avatar-initials').textContent = initials;
    $('user-first-name').textContent = fn;
    $('dd-name').textContent = (fn + ' ' + ln).trim();
    $('dd-email').textContent = State.currentUser?.email || '';

    const badgesEl = $('dd-badges');
    badgesEl.innerHTML = '';
    if (State.currentProfile.has_s1_access) badgesEl.innerHTML += '<span class="badge badge-s1">S1 Premium</span>';
    if (State.currentProfile.has_s2_access) badgesEl.innerHTML += '<span class="badge badge-s2">S2 Premium</span>';
    if (!State.currentProfile.has_s1_access && !State.currentProfile.has_s2_access) badgesEl.innerHTML += '<span class="badge badge-free">Free</span>';

    // Show the no-code admin upload entry point only for admin accounts
    AdminPanel.refreshVisibility();

    const premBtn = $('premium-btn');
    const eliteBadge = $('elite-badge');
    const partialBadge = $('partial-badge');
    const hasS1 = !!State.currentProfile.has_s1_access;
    const hasS2 = !!State.currentProfile.has_s2_access;

    premBtn.classList.add('hidden');
    eliteBadge.classList.add('hidden');
    partialBadge.classList.add('hidden');

    if (hasS1 && hasS2) {
      eliteBadge.classList.remove('hidden');
    } else if (hasS1 || hasS2) {
      const sem = hasS1 ? 'S1' : 'S2';
      $('partial-badge-text').textContent = sem + ' Active';
      partialBadge.classList.remove('hidden');
    } else {
      premBtn.classList.remove('hidden');
    }
  },

  toggleDropdown() {
    State.dropdownOpen = !State.dropdownOpen;
    const dd = $('user-dropdown');
    dd.classList.toggle('hidden', !State.dropdownOpen);
  },

  toggleHelpPopover() {
    State.helpPopoverOpen = !State.helpPopoverOpen;
    $('help-popover').classList.toggle('hidden', !State.helpPopoverOpen);
  }
};

