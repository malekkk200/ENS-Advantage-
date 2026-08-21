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

/* ─────────────────────────────────────────────────────────────
   SUPABASE
───────────────────────────────────────────────────────────── */
export const Supabase = (() => {
  const URL = SUPABASE_URL;
  const KEY = SUPABASE_ANON_KEY;
  // persistSession/autoRefreshToken are already supabase-js v2's
  // defaults — set explicitly (not a behavior change) so the
  // returning-user session persistence this app relies on is
  // documented here rather than implicit. Session is stored in
  // localStorage under a `sb-<project-ref>-auth-token` key (read by
  // the pre-paint check in index.html); autoRefreshToken silently
  // renews the access token in the background before it expires, so
  // a signed-in student stays logged in without re-entering
  // credentials until they explicitly log out or the refresh token
  // itself is revoked/expires.
  const client = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
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

