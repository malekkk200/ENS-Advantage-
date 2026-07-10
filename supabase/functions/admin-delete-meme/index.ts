import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const ADMIN_EMAIL      = Deno.env.get('ADMIN_EMAIL') ?? 'rahalmalik2018@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return json({ error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Invalid or expired session' }, 401);
    if ((user.email ?? '').toLowerCase() !== ADMIN_EMAIL.toLowerCase())
      return json({ error: 'Forbidden' }, 403);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const memeId = (body.meme_id ?? '').toString().trim();
    if (!memeId) return json({ error: 'meme_id is required' }, 400);

    const { data: meme, error: fetchErr } = await sb
      .from('memes').select('id, storage_path, title').eq('id', memeId).single();
    if (fetchErr || !meme) return json({ error: 'Meme not found' }, 404);

    const { error: removeErr } = await sb.storage.from('memes').remove([meme.storage_path]);
    if (removeErr) {
      console.error('[admin-delete-meme] storage error:', removeErr.message);
      return json({ error: `Storage delete failed: ${removeErr.message}` }, 500);
    }

    const { error: dbErr } = await sb.from('memes').delete().eq('id', memeId);
    if (dbErr) {
      console.error('[admin-delete-meme] db error:', dbErr.message);
      return json({ error: `Database delete failed: ${dbErr.message}` }, 500);
    }

    return json({ success: true, deleted_id: memeId, title: meme.title });
  } catch (err) {
    console.error('[admin-delete-meme] unexpected:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
