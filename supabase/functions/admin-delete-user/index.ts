import { createClient } from 'jsr:@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────
// Self-contained rather than importing ../_shared/security.ts —
// see log-screenshot-event/index.ts for why. The helpers below are
// kept identical in behavior to _shared/security.ts's versions.
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://ens-advantage.vercel.app',
  Deno.env.get('EXTRA_ALLOWED_ORIGIN') ?? '',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
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

function getAdminEmail(): string | null {
  const email = Deno.env.get('ADMIN_EMAIL');
  return email && email.trim() ? email.trim().toLowerCase() : null;
}

async function logSecurityEvent(
  adminClient: { from: (table: string) => any },
  event: { event_type: string; actor_email?: string | null; success: boolean; detail?: Record<string, unknown>; req?: Request },
): Promise<void> {
  try {
    const ip = event.req?.headers.get('cf-connecting-ip') ?? event.req?.headers.get('x-forwarded-for') ?? null;
    const userAgent = event.req?.headers.get('user-agent') ?? null;
    await adminClient.from('security_logs').insert({
      event_type: event.event_type,
      actor_email: event.actor_email ?? null,
      success: event.success,
      ip_address: ip,
      user_agent: userAgent,
      detail: event.detail ?? {},
    });
  } catch (_err) { /* never let logging break the primary request */ }
}

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

// ─────────────────────────────────────────────────────────────
// WHY THIS FUNCTION EXISTS
//
// Terminating an account by deleting only its public.user_profiles
// row (e.g. by hand in the Supabase Table Editor) is NOT a real
// deletion: auth.users — and therefore the person's login itself —
// is untouched.
//   - They can still sign back in with their old password at any
//     time; nothing about "deletion" ever revoked that.
//   - If they submit the signup form again with the same email,
//     auth-signup's "existing account" branch does not create a new
//     account — it resets the password on the SAME old auth.users row
//     and lets them straight back in.
//   - Now that user_profiles self-heals (see auth-verify-otp and
//     ensure-profile), the moment they log back in via EITHER path
//     above, their profile row is transparently recreated — which is
//     exactly the right behavior for an accidentally-missing profile,
//     but means a profile-only delete no longer even stays "broken"
//     for a banned user. It actively undoes the ban.
//
// The only real fix is deleting the auth.users row itself. Every
// table that references it (user_profiles, subscription_requests,
// active_sessions, plus Supabase Auth's own internal tables) has
// ON DELETE CASCADE — confirmed directly against this project's
// schema — so this cleanly removes the profile, premium/subscription
// history, and session records together, with nothing left orphaned.
// security_logs and otp_codes key by email (not a user_id FK) by
// design, so the audit trail of what happened correctly survives the
// account being gone.
//
// Once auth.users is actually gone, self-healing is no longer in
// tension with a ban: there is no account left to log into, and a
// fresh signup with that email creates a genuinely new account (new
// id, no old profile, no old subscription history) — which is
// exactly the "permanent delete, fresh start on re-registration"
// behavior wanted.
// ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const AUTHORIZED_ADMIN_EMAIL = getAdminEmail();
    if (!AUTHORIZED_ADMIN_EMAIL) {
      console.error('[admin-delete-user] ADMIN_EMAIL secret is not set.');
      return jsonResponse(req, { error: 'Admin panel is not configured.' }, 500);
    }

    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return jsonResponse(req, { error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user: caller }, error: callerErr } = await authClient.auth.getUser();
    if (callerErr || !caller) return jsonResponse(req, { error: 'Invalid or expired session' }, 401);

    const callerEmail = (caller.email || '').toLowerCase().trim();
    if (callerEmail !== AUTHORIZED_ADMIN_EMAIL) {
      await logSecurityEvent(adminClient, { event_type: 'admin_delete_user', actor_email: caller.email, success: false, detail: { reason: 'not_admin' }, req });
      return jsonResponse(req, { error: 'Forbidden — admin access required' }, 403);
    }

    let body: { email?: string; user_id?: string; confirm?: boolean };
    try {
      body = await req.json();
    } catch {
      return jsonResponse(req, { error: 'Invalid JSON body' }, 400);
    }

    // Irreversible + destructive — require an explicit confirm flag so this
    // can never be triggered by an accidental/malformed call.
    if (body.confirm !== true) {
      return jsonResponse(req, { error: 'This permanently deletes the account and all its data. Pass confirm:true to proceed.' }, 400);
    }

    const targetEmail = (body.email || '').toLowerCase().trim();
    const targetIdInput = (body.user_id || '').trim();
    if (!targetEmail && !targetIdInput) {
      return jsonResponse(req, { error: 'email or user_id is required' }, 400);
    }

    // Resolve to a real auth user. listUsers() has no server-side email
    // filter and only returns one page (max 1000) per call — walk pages
    // until found or exhausted, same approach as auth-verify-otp.
    let target: { id: string; email?: string } | undefined;
    if (targetIdInput) {
      const { data, error } = await adminClient.auth.admin.getUserById(targetIdInput);
      if (error) console.error('[admin-delete-user] getUserById failed:', error.message);
      target = data?.user ?? undefined;
    } else {
      let page = 1;
      for (;;) {
        const { data: pageData, error: pageErr } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
        if (pageErr) { console.error('[admin-delete-user] listUsers failed:', pageErr.message); break; }
        target = pageData?.users?.find((u) => u.email === targetEmail);
        if (target || !pageData?.users || pageData.users.length < 1000) break;
        page++;
      }
    }

    if (!target) {
      return jsonResponse(req, { error: 'No account found for that email/id.' }, 404);
    }

    // Refuse to let the admin delete their own account this way.
    if ((target.email || '').toLowerCase().trim() === AUTHORIZED_ADMIN_EMAIL) {
      return jsonResponse(req, { error: 'Refusing to delete the configured admin account.' }, 400);
    }

    const { error: deleteErr } = await adminClient.auth.admin.deleteUser(target.id);
    if (deleteErr) {
      console.error('[admin-delete-user] deleteUser failed:', deleteErr.message);
      await logSecurityEvent(adminClient, {
        event_type: 'admin_delete_user', actor_email: caller.email, success: false,
        detail: { reason: 'delete_failed', target_email: target.email, target_id: target.id }, req,
      });
      return jsonResponse(req, { error: `Delete failed: ${deleteErr.message}` }, 500);
    }

    await logSecurityEvent(adminClient, {
      event_type: 'admin_delete_user', actor_email: caller.email, success: true,
      detail: { target_email: target.email, target_id: target.id }, req,
    });

    return jsonResponse(req, { success: true, deleted_email: target.email, deleted_id: target.id });
  } catch (err) {
    console.error('[admin-delete-user] unexpected error:', err instanceof Error ? err.stack : err);
    return jsonResponse(req, { error: 'Internal server error.' }, 500);
  }
});
