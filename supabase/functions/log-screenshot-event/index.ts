import { createClient } from 'jsr:@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────
// This function is intentionally self-contained rather than
// importing ../_shared/security.ts like the admin-* functions do.
// That relative parent-directory import only resolves correctly
// when deployed as part of the whole supabase/functions/ tree (e.g.
// via `supabase functions deploy`); deploying a single function's
// file bundle on its own can't reliably reach outside its own
// folder. The three helpers below are intentionally kept identical
// in behavior to _shared/security.ts's versions.
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://ens-advantage.vercel.app',
  Deno.env.get('EXTRA_ALLOWED_ORIGIN') ?? '',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Native app (Capacitor, mobile-app/) — see get-material-url/index.ts
  // for why these are needed (same CORS-mismatch failure mode).
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

async function logSecurityEvent(
  adminClient: { from: (table: string) => any },
  event: { event_type: string; actor_email?: string | null; success: boolean; detail?: Record<string, unknown>; req?: Request },
): Promise<void> {
  try {
    const ip =
      event.req?.headers.get('cf-connecting-ip') ??
      event.req?.headers.get('x-forwarded-for') ??
      null;
    const userAgent = event.req?.headers.get('user-agent') ?? null;
    await adminClient.from('security_logs').insert({
      event_type: event.event_type,
      actor_email: event.actor_email ?? null,
      success: event.success,
      ip_address: ip,
      user_agent: userAgent,
      detail: event.detail ?? {},
    });
  } catch (_err) {
    // Never let logging failures break the primary request.
  }
}

// ─────────────────────────────────────────────────────────────
// Any authenticated user may call this (it's just reporting on
// themselves) — no admin gate needed. Nothing here BLOCKS a
// screenshot (see client-side notes for why that's impossible on
// iOS); this builds a record. If a specific student's account keeps
// showing up here, that's the actionable signal for a manual account
// review/termination under your ToS — the actual enforcement lever.
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

const ALLOWED_EVENTS = ['screenshot_taken', 'screen_recording_started', 'screen_recording_stopped'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return jsonResponse(req, { error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: 'Invalid or expired session' }, 401);

    const body = await req.json().catch(() => ({}));
    const eventType = (body.event_type ?? '').toString().trim();
    const platform = (body.platform ?? 'unknown').toString().trim().slice(0, 32);
    const context = (body.context ?? '').toString().trim().slice(0, 200);

    if (!ALLOWED_EVENTS.includes(eventType)) {
      return jsonResponse(req, { error: 'Invalid event_type' }, 400);
    }

    await logSecurityEvent(sb, {
      event_type: eventType,
      actor_email: user.email,
      success: true,
      detail: { platform, context, user_id: user.id },
      req,
    });

    return jsonResponse(req, { success: true });
  } catch (err) {
    console.error('[log-screenshot-event] unexpected:', err);
    return jsonResponse(req, { error: 'Internal server error' }, 500);
  }
});
