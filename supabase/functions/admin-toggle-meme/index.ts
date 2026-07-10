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
    const active = typeof body.active === 'boolean' ? body.active : null;
    if (!memeId) return json({ error: 'meme_id is required' }, 400);
    if (active === null) return json({ error: 'active (boolean) is required' }, 400);

    const { data: row, error: updateErr } = await sb
      .from('memes').update({ active }).eq('id', memeId).select().single();
    if (updateErr || !row) {
      console.error('[admin-toggle-meme] db error:', updateErr?.message);
      return json({ error: 'Update failed' }, 500);
    }

    return json({ success: true, meme: row });
  } catch (err) {
    console.error('[admin-toggle-meme] unexpected:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
