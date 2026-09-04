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
     * Offline-only fallback for Auth.loadState(): reads the session
     * straight out of encrypted storage (the exact same adapter/key
     * supabase-js itself reads from), bypassing getSession()'s
     * network-dependent refresh entirely.
     *
     * Why this is needed: on a cold app launch, if the stored access
     * token's real expiry (not just its proactive refresh margin) has
     * already passed, getSession() tries to refresh it over the
     * network before resolving. Offline, that refresh fails and
     * getSession() correctly returns `session: null` — even though a
     * valid refresh token (and the identity that goes with it) is
     * sitting right there in encrypted storage. Call this ONLY when
     * getSession() failed with isAuthRetryableFetchError (a network
     * failure, not an invalid/revoked session) — see Auth.loadState().
     *
     * This is a UI-only trust decision, never an authorization one:
     * the user object returned here is exactly what was already
     * signed in on this device. Every subsequent server call still
     * carries this same (possibly stale) JWT and is checked by
     * RLS/Edge Functions exactly as always — a genuinely revoked
     * session fails those calls the moment the device is back online,
     * same as it always would. Returns null on any parse/shape
     * failure so callers fall back to the normal logged-out state.
     */
    async getStoredSessionUser() {
      try {
        const raw = await encryptedAuthStorage.getItem(client.auth.storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const session = parsed?.currentSession ?? parsed; // supabase-js has used both shapes across versions
        return session?.user ?? null;
      } catch (_) {
        return null;
      }
    },
    /**
     * Resolves a fresh access token for an authenticated Edge Function
     * call, tolerating a single transient network blip during the
     * token refresh itself.
     *
     * Bug this fixes: client.auth.getSession() silently attempts a
     * network refresh whenever the stored access token's real expiry
     * has passed (same underlying mechanism as the offline cold-launch
     * fix in auth.js). Calling it unguarded here meant ANY admin write
     * — upload material, upload/delete guide, upload/toggle/delete meme
     * — would throw a raw, uncaught error the instant that refresh hit
     * even a brief mobile-network hiccup, which every caller then
     * displayed as the same opaque "network error" message regardless
     * of what actually went wrong.
     *
     * Fix: retry the refresh once after a short delay (mobile network
     * blips are usually sub-second) before giving up, and return a
     * specific, honest reason when it still fails — expired session
     * vs. genuine connectivity trouble — instead of throwing. This
     * changes nothing about the security boundary: a genuinely invalid
     * or revoked session still cannot obtain a token here, and every
     * Edge Function still independently re-verifies the caller
     * server-side regardless of what this returns.
     */
    async _getAccessTokenForRequest() {
      const attempt = async () => {
        const { data: { session } } = await client.auth.getSession();
        return session?.access_token ?? null;
      };
      try {
        const token = await attempt();
        if (token) return { ok: true, token };
        return { ok: false, message: 'انتهت صلاحية الجلسة. الرجاء تسجيل الخروج ثم الدخول مجدداً.' };
      } catch (err) {
        if (!window.supabase.isAuthRetryableFetchError(err)) {
          return { ok: false, message: 'انتهت صلاحية الجلسة. الرجاء تسجيل الخروج ثم الدخول مجدداً.' };
        }
        await new Promise((r) => setTimeout(r, 800)); // one bounded retry for a transient blip
        try {
          const token = await attempt();
          if (token) return { ok: true, token };
          return { ok: false, message: 'خطأ في الشبكة. تحقق من اتصالك وحاول مجدداً.' };
        } catch (_err2) {
          return { ok: false, message: 'خطأ في الشبكة. تحقق من اتصالك وحاول مجدداً.' };
        }
      }
    },
    /**
     * Wraps the apikey header automatically for Edge Functions.
     * Also attaches the user's JWT so server-side functions can verify identity
     * without trusting any user-supplied IDs in the request body.
     */
    async callFunction(name, body) {
      const tokenResult = await this._getAccessTokenForRequest();
      if (!tokenResult.ok) return { ok: false, json: { error: tokenResult.message } };
      const res = await fetch(`${URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: KEY,
          Authorization: `Bearer ${tokenResult.token}`
        },
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
      const tokenResult = await this._getAccessTokenForRequest();
      if (!tokenResult.ok) return { ok: false, json: { error: tokenResult.message } };
      const res = await fetch(`${URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${tokenResult.token}` }, // no Content-Type — browser sets multipart boundary
        body: formData
      });
      let json = {};
      try { json = await res.json(); } catch (_) { /* empty body is fine */ }
      return { ok: res.ok, json };
    }
  };
})();
export const sb = Supabase.client;

