import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse, getAdminEmail, logSecurityEvent } from '../_shared/security.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'Method not allowed' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // Fail closed: if the ADMIN_EMAIL secret isn't configured, deny
    // everyone rather than falling back to a hardcoded address.
    const adminEmail = getAdminEmail();
    if (!adminEmail) {
      console.error('[admin-toggle-meme] ADMIN_EMAIL secret is not configured — denying all requests.');
      return jsonResponse(req, { error: 'Server misconfiguration' }, 500);
    }

    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return jsonResponse(req, { error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: 'Invalid or expired session' }, 401);
    if ((user.email ?? '').toLowerCase() !== adminEmail) {
      await logSecurityEvent(sb, { event_type: 'admin_toggle_meme', actor_email: user.email, success: false, detail: { reason: 'not_admin' }, req });
      return jsonResponse(req, { error: 'Forbidden' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const memeId = (body.meme_id ?? '').toString().trim();
    const active = typeof body.active === 'boolean' ? body.active : null;
    if (!memeId) return jsonResponse(req, { error: 'meme_id is required' }, 400);
    if (active === null) return jsonResponse(req, { error: 'active (boolean) is required' }, 400);

    const { data: row, error: updateErr } = await sb
      .from('memes').update({ active }).eq('id', memeId).select().single();
    if (updateErr || !row) {
      console.error('[admin-toggle-meme] db error:', updateErr?.message);
      await logSecurityEvent(sb, { event_type: 'admin_toggle_meme', actor_email: user.email, success: false, detail: { reason: 'db_error', memeId }, req });
      return jsonResponse(req, { error: 'Update failed' }, 500);
    }

    await logSecurityEvent(sb, { event_type: 'admin_toggle_meme', actor_email: user.email, success: true, detail: { memeId, active }, req });
    return jsonResponse(req, { success: true, meme: row });
  } catch (err) {
    console.error('[admin-toggle-meme] unexpected:', err);
    return jsonResponse(req, { error: 'Internal server error' }, 500);
  }
});
