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
    const adminEmail = getAdminEmail();
    if (!adminEmail) {
      console.error('[admin-delete-meme] ADMIN_EMAIL secret is not configured — denying all requests.');
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
      await logSecurityEvent(sb, { event_type: 'admin_delete_meme', actor_email: user.email, success: false, detail: { reason: 'not_admin' }, req });
      return jsonResponse(req, { error: 'Forbidden' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const memeId = (body.meme_id ?? '').toString().trim();
    if (!memeId) return jsonResponse(req, { error: 'meme_id is required' }, 400);

    const { data: meme, error: fetchErr } = await sb
      .from('memes').select('id, storage_path, title').eq('id', memeId).single();
    if (fetchErr || !meme) return jsonResponse(req, { error: 'Meme not found' }, 404);

    const { error: removeErr } = await sb.storage.from('memes').remove([meme.storage_path]);
    if (removeErr) {
      console.error('[admin-delete-meme] storage error:', removeErr.message);
      await logSecurityEvent(sb, { event_type: 'admin_delete_meme', actor_email: user.email, success: false, detail: { reason: 'storage_error', memeId }, req });
      return jsonResponse(req, { error: `Storage delete failed: ${removeErr.message}` }, 500);
    }

    const { error: dbErr } = await sb.from('memes').delete().eq('id', memeId);
    if (dbErr) {
      console.error('[admin-delete-meme] db error:', dbErr.message);
      await logSecurityEvent(sb, { event_type: 'admin_delete_meme', actor_email: user.email, success: false, detail: { reason: 'db_error', memeId }, req });
      return jsonResponse(req, { error: `Database delete failed: ${dbErr.message}` }, 500);
    }

    await logSecurityEvent(sb, { event_type: 'admin_delete_meme', actor_email: user.email, success: true, detail: { memeId, title: meme.title }, req });
    return jsonResponse(req, { success: true, deleted_id: memeId, title: meme.title });
  } catch (err) {
    console.error('[admin-delete-meme] unexpected:', err);
    return jsonResponse(req, { error: 'Internal server error' }, 500);
  }
});
