/* ═══════════════════════════════════════════════════════════════
   AUTH — login / signup / otp / logout
═══════════════════════════════════════════════════════════════ */
import { sb, Supabase } from './supabaseClient.js';
import { State } from './state.js';
import { $ } from './dom.js';
import { CourseMaterials } from './courseMaterials.js';
import { Realtime } from './realtime.js';
import { Sessions } from './sessions.js';
import { UI } from './ui.js';
import { Content } from './content.js';
import { PDFViewer } from './pdfViewer.js';
import { Protection } from './protection.js';
import { Subscription } from './subscription.js';
import { AdminPanel } from './adminPanel.js';
import { MemeAdmin } from './memeAdmin.js';
import { MaterialCache } from './materialCache.js';
import { render } from './router.js';

/* ─────────────────────────────────────────────────────────────
   AUTH
───────────────────────────────────────────────────────────── */
export const Auth = {
  togglePasswordVisibility(btn, inputId) {
    const input = $(inputId);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('is-visible', !showing);
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  },

  async loadState() {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        State.currentUser = session.user;
        if (window.location.hash.includes('access_token')) {
          history.replaceState(null, '', window.location.pathname);
        }
        if (State.currentUser.email_confirmed_at) {
          await this.loadProfile();
        }
      }
    } catch (e) { console.error('loadState:', e); }
    render();

    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        State.currentUser = session.user;
        if (window.location.hash.includes('access_token')) {
          history.replaceState(null, '', window.location.pathname);
        }
        if (State.currentUser.email_confirmed_at) {
          await this.loadProfile();
        }
        render();
      } else if (event === 'SIGNED_OUT') {
        State.currentUser = null;
        State.currentProfile = null;
        Realtime.teardown();
        Sessions.teardown();
        render();
      }
    });
  },

  async loadProfile() {
    if (!State.currentUser) return;
    const { data } = await sb
      .from('user_profiles')
      .select('*')
      .eq('id', State.currentUser.id)
      .single();
    if (data) State.currentProfile = data;
  },

  switchMode(mode) {
    State.currentAuthMode = mode;
    $('login-error').classList.add('hidden');
    $('signup-error').classList.add('hidden');
    if (mode === 'login') {
      $('tab-login').classList.add('active');
      $('tab-signup').classList.remove('active');
      $('form-login').classList.remove('hidden');
      $('form-signup').classList.add('hidden');
    } else {
      $('tab-signup').classList.add('active');
      $('tab-login').classList.remove('active');
      $('form-signup').classList.remove('hidden');
      $('form-login').classList.add('hidden');
    }
  },

  async login() {
    const email = $('login-email').value.trim().toLowerCase();
    const password = $('login-password').value;
    const errEl = $('login-error');
    errEl.classList.add('hidden');

    const btn = document.querySelector('#form-login .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Signing in…';

    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    btn.disabled = false; btn.textContent = '→ Access My Account';

    if (error) {
      if (error.message === 'Email not confirmed') {
        localStorage.setItem('ens_pending_email', email);
        State.currentUser = { email, email_confirmed_at: null };
        await Supabase.callFunction('auth-signup', { email, resend: true });
        UI.showAuthOtp();
        return;
      }
      errEl.textContent = error.message === 'Invalid login credentials'
        ? 'Incorrect email or password.' : error.message;
      errEl.classList.remove('hidden');
      return;
    }

    State.currentUser = data.user;
    if (State.currentUser.email_confirmed_at) {
      await this.loadProfile();
    } else {
      localStorage.setItem('ens_pending_email', email);
    }
    render();
  },

  async signup() {
    const firstName = $('signup-firstName').value.trim();
    const lastName = $('signup-lastName').value.trim();
    const dob = $('signup-dob').value;
    const email = $('signup-email').value.trim().toLowerCase();
    const password = $('signup-password').value;
    const errEl = $('signup-error');
    errEl.classList.add('hidden');

    if (!firstName || !lastName || !dob || !email || !password) {
      errEl.textContent = 'Please fill in all fields.';
      errEl.classList.remove('hidden'); return;
    }
    if (password.length < 8) {
      errEl.textContent = 'Password must be at least 8 characters.';
      errEl.classList.remove('hidden'); return;
    }

    const btn = document.querySelector('#form-signup .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Creating account…';

    const { ok, json } = await Supabase.callFunction('auth-signup', { email, password, firstName, lastName, dob });

    btn.disabled = false; btn.textContent = '→ Create Account';

    if (!ok || json.error) {
      errEl.textContent = json.error || 'Signup failed. Please try again.';
      errEl.classList.remove('hidden'); return;
    }

    localStorage.setItem('ens_pending_email', email);
    State.currentUser = { email, email_confirmed_at: null };
    render();
  },

  async verifyOtp() {
    const code = $('otp-input').value.trim();
    const email = State.currentUser?.email || localStorage.getItem('ens_pending_email') || '';
    const errEl = $('otp-error');
    errEl.classList.add('hidden');

    if (!code) {
      errEl.textContent = 'Please enter the verification code.';
      errEl.classList.remove('hidden'); return;
    }

    const btn = document.querySelector('#auth-card-otp .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Verifying…';

    const { ok, json } = await Supabase.callFunction('auth-verify-otp', { email, code });

    if (!ok || json.error) {
      btn.disabled = false; btn.textContent = '✓ Verify Account';
      errEl.textContent = json.error || 'Verification failed.';
      errEl.classList.remove('hidden'); return;
    }

    btn.disabled = false; btn.textContent = '✓ Verify Account';

    // Fallback: server couldn't issue a token (rare) → redirect to login
    if (!json.token_hash) {
      errEl.textContent = 'Account verified! Please sign in with your password.';
      errEl.classList.remove('hidden');
      localStorage.removeItem('ens_pending_email');
      setTimeout(() => UI.showAuthLogin(), 2000);
      return;
    }

    // Exchange the server-issued one-time token for a full Supabase session
    const { data, error } = await sb.auth.verifyOtp({
      token_hash: json.token_hash,
      type: 'magiclink'
    });

    if (error || !data?.user) {
      errEl.textContent = 'Account verified! Please sign in with your password.';
      errEl.classList.remove('hidden');
      localStorage.removeItem('ens_pending_email');
      setTimeout(() => UI.showAuthLogin(), 2000);
      return;
    }

    localStorage.removeItem('ens_pending_email');
    State.currentUser = data.user;
    await this.loadProfile();
    render();
  },

  async resendOtp() {
    const email = State.currentUser?.email || localStorage.getItem('ens_pending_email') || '';
    if (!email) return;
    const msg = $('resend-msg');
    msg.style.display = 'block';
    msg.style.color = 'var(--text-secondary)';
    msg.textContent = 'Sending…';

    const { ok, json } = await Supabase.callFunction('auth-signup', { email, resend: true });

    if (!ok || json.error) {
      msg.textContent = json?.error || 'Could not resend code. Please try again.';
      msg.style.color = 'var(--red, #ef4444)';
    } else {
      msg.textContent = 'Code resent! Check your inbox.';
      msg.style.color = 'var(--green)';
    }
    setTimeout(() => { msg.style.display = 'none'; }, 5000);
  },

  clearOtpError() {
    const el = $('otp-error');
    if (el) el.classList.add('hidden');
  },

  showForgotPassword() {
    $('auth-card-main').classList.add('hidden');
    $('auth-card-otp').classList.add('hidden');
    $('auth-card-forgot').classList.remove('hidden');
  },

  backToLogin() {
    // Clear forgot form
    $('forgot-email') && ($('forgot-email').value = '');
    $('forgot-error')?.classList.add('hidden');
    // Clear reset form
    $('reset-code') && ($('reset-code').value = '');
    $('new-password') && ($('new-password').value = '');
    $('confirm-password') && ($('confirm-password').value = '');
    $('new-password-error')?.classList.add('hidden');
    sessionStorage.removeItem('pw_reset_email');

    $('auth-card-forgot').classList.add('hidden');
    $('auth-card-new-password').classList.add('hidden');
    $('auth-card-main').classList.remove('hidden');
  },

  async forgotPassword() {
    const email = $('forgot-email').value.trim().toLowerCase();
    const errEl = $('forgot-error');
    errEl.classList.add('hidden');

    if (!email) {
      errEl.textContent = 'Please enter your email address.';
      errEl.classList.remove('hidden'); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.classList.remove('hidden'); return;
    }

    const btn = document.querySelector('#auth-card-forgot .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Sending…';

    const { ok, json } = await Supabase.callFunction('auth-forgot-password', { action: 'send', email });

    btn.disabled = false; btn.textContent = '→ Send Reset Code';

    if (!ok || json.error) {
      errEl.textContent = json?.error || 'Failed to send code. Please try again.';
      errEl.classList.remove('hidden'); return;
    }

    // Store email for the verify step, then show the code+password card
    sessionStorage.setItem('pw_reset_email', email);
    $('auth-card-forgot').classList.add('hidden');
    $('auth-card-new-password').classList.remove('hidden');
    const disp = $('reset-email-display');
    if (disp) disp.textContent = `Code sent to ${email} — enter it below`;
  },

  async resetPassword() {
    const email    = sessionStorage.getItem('pw_reset_email') || '';
    const code     = ($('reset-code')?.value || '').trim();
    const password = $('new-password')?.value || '';
    const confirm  = $('confirm-password')?.value || '';
    const errEl    = $('new-password-error');
    errEl.classList.add('hidden');

    if (!code) {
      errEl.textContent = 'Please enter the reset code from your email.';
      errEl.classList.remove('hidden'); return;
    }
    if (password.length < 8) {
      errEl.textContent = 'Password must be at least 8 characters.';
      errEl.classList.remove('hidden'); return;
    }
    if (password !== confirm) {
      errEl.textContent = 'Passwords do not match. Please try again.';
      errEl.classList.remove('hidden'); return;
    }

    const btn = document.querySelector('#auth-card-new-password .btn-primary');
    btn.disabled = true; btn.textContent = '⏳ Updating…';

    const { ok, json } = await Supabase.callFunction('auth-forgot-password', {
      action: 'verify', email, code, password
    });

    btn.disabled = false; btn.textContent = '→ Reset Password';

    if (!ok || json.error) {
      errEl.textContent = json?.error || 'Failed to reset password. Please try again.';
      errEl.classList.remove('hidden'); return;
    }

    sessionStorage.removeItem('pw_reset_email');
    $('new-password').value = '';
    $('confirm-password').value = '';
    $('reset-code').value = '';

    // Back to login with a success notice
    $('auth-card-new-password').classList.add('hidden');
    $('auth-card-main').classList.remove('hidden');
    const notice = $('login-error');
    notice.style.cssText = 'color:var(--green);background:var(--green-light);';
    notice.textContent = '✓ Password updated successfully. Please sign in.';
    notice.classList.remove('hidden');
  },

  async logout() {
    Realtime.teardown();
    await Sessions.releaseOnLogout();
    // Close every overlay before signing out — otherwise, if one
    // happened to be open (PDF/content viewer, subscription modal, or
    // either admin panel), it stayed visibly open floating over the
    // freshly-rendered login screen, since render()/showAuthLogin()
    // never touch these overlay elements themselves.
    PDFViewer.close();
    Content.close();
    Subscription.close();
    AdminPanel.close();
    MemeAdmin.close();
    await sb.auth.signOut();
    State.currentUser         = null;
    State.currentProfile      = null;
    State.dropdownOpen        = false;
    State.pdfViewerActive     = false;
    State.contentViewerActive = false;
    // Invalidate cached materials — next login fetches a fresh,
    // subscription-accurate set from the database.
    CourseMaterials.invalidate();
    // Same reasoning, for the on-device PDF byte cache (free summaries
    // only — see materialCache.js) so a shared/public device doesn't
    // keep serving a previous student's cached files after sign-out.
    MaterialCache.clear();
    $('admin-dropdown-btn')?.classList.add('hidden');
    Protection.deactivate();
    render();
  }
};

