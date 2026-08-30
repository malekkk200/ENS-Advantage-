/* ═══════════════════════════════════════════════════════════════
   SUPABASE CLIENT
   ───────────────────────────────────────────────────────────────
   Creates the Supabase client (window.supabase comes from the UMD
   CDN <script> tag loaded in index.html — no bundler required) and
   exposes two small helpers used throughout the app:
     • sb                    — the raw Supabase client
     • Supabase.callFunction / callFunctionMultipart
                              — fetch wrappers for Edge Functions
                                that automatically attach the
                                user's JWT + apikey header
═══════════════════════════════════════════════════════════════ */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { SecureStorageBridge } from './secureStorage.js';

/* ─────────────────────────────────────────────────────────────
   ENCRYPTED SESSION STORAGE ADAPTER
   ───────────────────────────────────────────────────────────────
   supabase-js v2's `auth.storage` option accepts any object shaped
   like { getItem, setItem, removeItem } — sync OR async (this is an
   officially supported pattern; it's the same interface point
   React Native apps use to plug in expo-secure-store/Keychain
   instead of AsyncStorage). Passing this adapter routes the actual
   session/refresh token through SecureStorageBridge — Android
   Keystore-backed encryption / iOS Keychain — instead of plain
   localStorage.

   Falls back to localStorage automatically (per key, per call) if
   secure storage is ever unavailable, so a plugin/platform hiccup
   degrades to "as secure as before this change" rather than
   breaking login entirely.

   Separately, every successful write also mirrors a small
   NON-SENSITIVE hint into plain localStorage under 'ensAuthHint' —
   just a boolean-ish "a session existed, expiring around T" marker,
   containing no bearer token or anything usable to authenticate as
   the user. This exists purely so index.html's pre-paint script can
   make its "skip the login screen" decision synchronously, before
   first paint, without ever touching the encrypted store (which is
   only reachable asynchronously through the native bridge — there is
   no such thing as a synchronous native-plugin call in Capacitor, so
   an instant pre-paint decision and an encrypted-at-rest token are
   only simultaneously possible by splitting them like this).
───────────────────────────────────────────────────────────── */
const AUTH_TOKEN_KEY_RE = /-auth-token$/;

function updateAuthHint(key, rawValue) {
  if (!AUTH_TOKEN_KEY_RE.test(key)) return;
  try {
    if (rawValue == null) {
      localStorage.removeItem('ensAuthHint');
      return;
    }
    const parsed  = JSON.parse(rawValue);
    const session = parsed?.currentSession ?? parsed; // supabase-js has used both shapes across versions
    const accessToken = session?.access_token;
    const expiresAt   = session?.expires_at; // unix seconds
    if (accessToken && expiresAt) {
      localStorage.setItem('ensAuthHint', JSON.stringify({ hasToken: true, expiresAt }));
    } else {
      localStorage.removeItem('ensAuthHint');
    }
  } catch (_) {
    // Don't let a hint-parsing hiccup affect the real (secure) write above.
  }
}

const encryptedAuthStorage = {
  async getItem(key) {
    const secureValue = await SecureStorageBridge.getItem(key);
    if (secureValue !== null) return secureValue;
    // Fall back to localStorage — covers devices/builds where secure
    // storage isn't available yet, and reads back anything written
    // there before this adapter existed.
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  },
  async setItem(key, value) {
    const savedSecurely = await SecureStorageBridge.setItem(key, value);
    if (!savedSecurely) {
      try { window.localStorage.setItem(key, value); } catch (_) { /* nothing more we can do */ }
    } else {
      // Now that the real token lives in secure storage, make sure a
      // stale plaintext copy from before this change (or from a
      // fallback write) isn't left sitting in localStorage too.
      try { window.localStorage.removeItem(key); } catch (_) {}
    }
    updateAuthHint(key, value);
  },
  async removeItem(key) {
    await SecureStorageBridge.removeItem(key);
    try { window.localStorage.removeItem(key); } catch (_) {}
    updateAuthHint(key, null);
  }
};

/* ─────────────────────────────────────────────────────────────
   SUPABASE
───────────────────────────────────────────────────────────── */
export const Supabase = (() => {
  const URL = SUPABASE_URL;
  const KEY = SUPABASE_ANON_KEY;
  // persistSession/autoRefreshToken are supabase-js v2's defaults —
  // set explicitly (not a behavior change) so the returning-user
  // session persistence this app relies on is documented here rather
  // than implicit. `storage: encryptedAuthStorage` is the behavior
  // change: the session/refresh token itself is now encrypted at
  // rest (see above) instead of sitting in plain localStorage.
  // autoRefreshToken silently renews the access token in the
  // background before it expires, so a signed-in student stays
  // logged in without re-entering credentials until they explicitly
  // log out or the refresh token itself is revoked/expires.
  const client = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: encryptedAuthStorage }
  });
  return {
    client,
    url: URL,
    key: KEY,
    /**
     * Wraps the apikey header automatically for Edge Functions.
     * Also attaches the user's JWT so server-side functions can verify identity
     * without trusting any user-supplied IDs in the request body.
     */
    async callFunction(name, body) {
      const { data: { session } } = await client.auth.getSession();
      const authHeader = session?.access_token
        ? { 'Authorization': `Bearer ${session.access_token}` }
        : {};
      const res = await fetch(`${URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: KEY, ...authHeader },
        body: JSON.stringify(body)
      });
      let json = {};
      try { json = await res.json(); } catch (_) { /* empty body is fine */ }
      return { ok: res.ok, json };
    },
    /**
     * Like callFunction, but sends a multipart/form-data body — used for
     * file uploads (the admin PDF upload panel). Browsers set the correct
     * multipart boundary automatically when Content-Type is omitted and a
     * FormData object is passed as the body.
     */
    async callFunctionMultipart(name, formData) {
      const { data: { session } } = await client.auth.getSession();
      const authHeader = session?.access_token
        ? { 'Authorization': `Bearer ${session.access_token}` }
        : {};
      const res = await fetch(`${URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: { apikey: KEY, ...authHeader }, // no Content-Type — browser sets multipart boundary
        body: formData
      });
      let json = {};
      try { json = await res.json(); } catch (_) { /* empty body is fine */ }
      return { ok: res.ok, json };
    }
  };
})();
export const sb = Supabase.client;

