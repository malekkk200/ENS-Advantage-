/* ═══════════════════════════════════════════════════════════════
   SESSIONS — single active device per account
   ───────────────────────────────────────────────────────────────
   Not a screenshot defense. This is aimed at the bigger revenue
   leak for a subscription platform: one paid account, credentials
   shared with several people using it at once. Logging in from a
   new device deletes every other active_sessions row for that
   account; the deleted device is listening via Realtime and signs
   itself out the moment that happens.

   Deliberately "kick, don't block": a student switching from phone
   to laptop just gets logged out on the phone and can carry on —
   no friction for the common single-owner case. Two people trying
   to use the same account concurrently end up fighting over who's
   currently signed in, which is exactly the deterrent this is for.
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { State } from './state.js';
import { $ } from './dom.js';

const STORAGE_KEY = 'ens_device_session_id';
const HEARTBEAT_MS = 3 * 60 * 1000; // keep last_seen_at fresh every 3 min

function _deviceId() {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

/** Best-effort, human-readable "Chrome on Windows" style label — cosmetic only. */
function _deviceLabel() {
  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    /Firefox\//.test(ua) ? 'Firefox' : 'a browser';
  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Linux/.test(ua) ? 'Linux' : 'an unknown device';
  return `${browser} on ${os}`;
}

export const Sessions = {
  _heartbeatTimer: null,
  _kicked: false,

  /** Call once, right after a user is confirmed signed in (login, or app boot with an existing session). */
  async claim() {
    if (!State.currentUser || State.sessionChannel) return; // already claimed this app session
    this._kicked = false;
    const myId = _deviceId();

    // Kick every other device for this account first, then register
    // this one — in that order, so a race between two logins still
    // converges to "whoever's insert lands last wins," never to both
    // surviving.
    await sb.from('active_sessions').delete().eq('user_id', State.currentUser.id).neq('id', myId);
    await sb.from('active_sessions').upsert({
      id: myId,
      user_id: State.currentUser.id,
      device_label: _deviceLabel(),
      last_seen_at: new Date().toISOString(),
    });

    this._listen();
    this._startHeartbeat();
  },

  _listen() {
    if (State.sessionChannel) return; // already subscribed
    const myId = _deviceId();
    State.sessionChannel = sb
      .channel('session_' + State.currentUser.id)
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'active_sessions',
        filter: 'user_id=eq.' + State.currentUser.id,
      }, (payload) => {
        // Only react if OUR row was the one deleted — a delete caused
        // by us claiming a new device (which removes the *other*
        // row) must not sign us out.
        if (payload.old?.id === myId && !this._kicked) {
          this._kicked = true;
          this._forceSignOut();
        }
      })
      .subscribe();
  },

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (!State.currentUser || this._kicked) return;
      sb.from('active_sessions')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', _deviceId());
    }, HEARTBEAT_MS);
  },

  async _forceSignOut() {
    const toast = $('protection-toast');
    if (toast) {
      toast.style.background = 'var(--red, #dc2626)';
      toast.textContent = '🔒 Signed out — this account was opened on another device.';
      toast.classList.remove('hidden');
      toast.style.animation = 'none';
      void toast.offsetWidth;
      toast.style.animation = 'slideDown .3s ease, fadeOutToast 5s forwards';
      setTimeout(() => { toast.classList.add('hidden'); toast.style.background = ''; }, 5300);
    }
    this.teardown();
    await sb.auth.signOut();
  },

  /** Call on explicit logout — removes this device's row so a stale entry doesn't linger. */
  async releaseOnLogout() {
    const myId = _deviceId();
    this.teardown();
    if (State.currentUser) {
      await sb.from('active_sessions').delete().eq('id', myId).eq('user_id', State.currentUser.id);
    }
  },

  teardown() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (State.sessionChannel) { sb.removeChannel(State.sessionChannel); State.sessionChannel = null; }
  },
};
