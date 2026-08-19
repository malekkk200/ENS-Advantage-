import { createClient } from 'jsr:@supabase/supabase-js@2';

// ─────────────────────────────────────────────────────────────
// get-material-url
//
// Replaces the client's previous direct call to
// `sb.storage.from('course-materials').createSignedUrl(...)`.
// Access control does NOT move here — storage RLS (cm_storage_select,
// keyed off has_s1_access/has_s2_access) remains the actual gate,
// enforced by calling createSignedUrl() with a client authenticated
// AS THE REQUESTING USER, not the service-role key. This function's
// only job is to sit in front of that call so every attempt (granted
// or denied) gets a security_logs row, and so a burst of requests
// from one account can be throttled before it reaches storage.
//
// Self-contained (same reasoning as log-screenshot-event): relative
// imports from ../_shared don't reliably resolve on a single-function
// deploy, so the CORS/logging helpers are duplicated here rather than
// imported.
// ─────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://ens-advantage.vercel.app',
  Deno.env.get('EXTRA_ALLOWED_ORIGIN') ?? '',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Native app (Capacitor, mobile-app/) — without these, requests from
  // the app succeed server-side (see security_logs) but the WebView
  // silently discards the response on the CORS mismatch, and the app
  // shows a false "access denied / verify your subscription" error.
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

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

const SIGNED_URL_TTL_SECONDS = 90;

// Soft throttle: a real student opening documents one at a time will
// never come close to this within a minute. A script walking the
// whole catalog will. We don't hard-block below this — legitimate
// bursts (e.g. flipping through several summaries quickly) still work
// — but requests are hard-blocked past the ceiling.
const SOFT_FLAG_THRESHOLD_1MIN = 20;
const HARD_BLOCK_THRESHOLD_1MIN = 45;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return jsonResponse(req, { error: 'Missing authorization token' }, 401);

    // Client authenticated AS THE USER — this is what makes storage
    // RLS (cm_storage_select) the real access gate below, exactly as
    // it was when the frontend called createSignedUrl() directly.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: 'Invalid or expired session' }, 401);

    const body = await req.json().catch(() => ({}));
    const storagePath = (body.storage_path ?? '').toString().trim();
    const materialId   = (body.material_id ?? '').toString().trim().slice(0, 100);
    const title         = (body.title ?? '').toString().trim().slice(0, 200);

    if (!storagePath) return jsonResponse(req, { error: 'storage_path is required' }, 400);

    // ── Rolling 1-minute request count for this user ──
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    const { count: recentCount } = await admin
      .from('security_logs')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'student_view_material')
      .eq('actor_email', user.email)
      .gte('created_at', oneMinAgo);

    if ((recentCount ?? 0) >= HARD_BLOCK_THRESHOLD_1MIN) {
      await logSecurityEvent(admin, {
        event_type: 'student_view_material',
        actor_email: user.email,
        success: false,
        detail: { storage_path: storagePath, material_id: materialId, title, blocked: true, reason: 'rate_limit', recent_count: recentCount },
        req,
      });
      return jsonResponse(req, { error: 'Too many requests. Please slow down.' }, 429);
    }

    const flagged = (recentCount ?? 0) >= SOFT_FLAG_THRESHOLD_1MIN;

    // ── Create the signed URL as the user — RLS still gates this ──
    const { data, error } = await userClient.storage
      .from('course-materials')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    await logSecurityEvent(admin, {
      event_type: 'student_view_material',
      actor_email: user.email,
      success: !error && !!data?.signedUrl,
      detail: {
        storage_path: storagePath,
        material_id: materialId,
        title,
        flagged_rate: flagged,
        recent_count: recentCount,
        denial_reason: error?.message ?? null,
      },
      req,
    });

    if (error || !data?.signedUrl) {
      return jsonResponse(req, { error: 'Access denied or content unavailable.' }, 403);
    }

    return jsonResponse(req, { signedUrl: data.signedUrl });
  } catch (err) {
    console.error('[get-material-url] unexpected:', err);
    return jsonResponse(req, { error: 'Internal server error' }, 500);
  }
});
