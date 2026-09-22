import { createClient } from 'jsr:@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────
// Self-contained rather than importing ../_shared/security.ts —
// see log-screenshot-event/index.ts for why (relative parent-dir
// imports only resolve when the whole supabase/functions/ tree is
// deployed together; a lone function bundle can't reach outside its
// own folder). The helpers below are kept identical in behavior to
// _shared/security.ts's versions.
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://ens-advantage.vercel.app',
  Deno.env.get('EXTRA_ALLOWED_ORIGIN') ?? '',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Native app (Capacitor, mobile-app/) — see auth-signup/index.ts for
  // why these are needed (same CORS-mismatch failure mode).
  'https://localhost',      // Android (Capacitor default androidScheme)
  'capacitor://localhost',  // iOS (Capacitor default ios scheme)
  'http://localhost',       // defensive extra for older WebViews
].filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

// ─────────────────────────────────────────────────────────────
// WHY THIS FUNCTION EXISTS
//
// public.user_profiles is normally kept in sync with auth.users two
// ways: the `on_auth_user_created` DB trigger creates a row the
// instant a new auth user is inserted, and auth-verify-otp additionally
// self-heals it on every OTP-based signup/re-verification. Both are
// solid, but neither one runs on a PLAIN password login or an app
// cold-launch resuming an existing session (Auth.login() calls
// sb.auth.signInWithPassword() directly, and Auth.loadState() calls
// sb.auth.getSession() directly — neither goes through any Edge
// Function at all). If a profile row is ever missing for a user who
// only ever logs back in that way — which is the common case for a
// returning user — nothing has ever repaired it, and RLS explicitly
// denies the client any insert/update on user_profiles (service-role
// only), so the client can't fix it itself either. That combination
// is exactly what left real accounts permanently stuck with a blank
// avatar and no name after a successful login.
//
// The client now calls this function as a fallback specifically when
// Auth.loadProfile()'s SELECT comes back empty (see js/auth.js and
// mobile-app/www/js/auth.js) — not on every login — so the common
// case (profile already exists) never pays for an extra round trip.
//
// SECURITY: this can only ever create/repair the CALLER's OWN row.
// The user id is taken exclusively from their verified JWT (via
// authClient.auth.getUser()), never from anything the client sends in
// the request body, so there is no way to target another user's row.
// The upsert uses ignoreDuplicates:true (INSERT ... ON CONFLICT DO
// NOTHING) — if a profile already exists this is a guaranteed no-op,
// so it can never reset an admin-set has_s1_access / has_s2_access /
// is_admin flag or overwrite a name the user has since changed.
// ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return jsonResponse(req, { error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: 'Invalid or expired session' }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;

    const { error: healErr } = await sb
      .from('user_profiles')
      .upsert(
        {
          id: user.id,
          first_name: (meta.first_name as string) || '',
          last_name: (meta.last_name as string) || '',
          dob: (meta.dob as string) || null,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );
    if (healErr) {
      console.error('ensure-profile upsert failed:', healErr.message, healErr.details);
      return jsonResponse(req, { error: 'Could not verify profile.' }, 500);
    }

    const { data: profile, error: selectErr } = await sb
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (selectErr || !profile) {
      console.error('ensure-profile post-upsert select failed:', selectErr?.message);
      return jsonResponse(req, { error: 'Could not load profile.' }, 500);
    }

    return jsonResponse(req, { success: true, profile });
  } catch (err) {
    console.error('ensure-profile error:', err instanceof Error ? err.stack : err);
    return jsonResponse(req, { error: 'Internal server error.' }, 500);
  }
});
