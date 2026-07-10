import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
// Prefer the ADMIN_EMAIL secret; fall back to hardcoded for continuity.
// Set the secret in Supabase Dashboard → Project Settings → Edge Functions → Secrets.
const ADMIN_EMAIL      = Deno.env.get('ADMIN_EMAIL') ?? 'rahalmalik2018@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const VALID_CATEGORIES = new Set([
  'cat_below_8', 'cat_8_to_9_50', 'cat_9_51_to_9_99',
  'cat_10_to_10_50', 'cat_10_51_to_12', 'cat_12_01_to_13_50',
  'cat_13_51_to_14_99', 'cat_15_to_15_99', 'cat_16_plus',
]);

const VALID_MIME: Record<string, string> = {
  'video/mp4':  '.mp4',
  'video/webm': '.webm',
  'image/gif':  '.gif',
};

const MAX_BYTES = 50 * 1024 * 1024;

function slugify(s: string): string {
  return s.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-')
    .slice(0, 60);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1. Auth
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return json({ error: 'Missing authorization token' }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: userErr } = await authClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Invalid or expired session' }, 401);

    const callerEmail = (user.email ?? '').toLowerCase().trim();
    if (callerEmail !== ADMIN_EMAIL.toLowerCase())
      return json({ error: 'Forbidden — admin access required' }, 403);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 2. Parse form
    const form = await req.formData();
    const file     = form.get('file');
    const category = (form.get('category') ?? '').toString().trim();
    const title    = (form.get('title') ?? '').toString().trim() || null;

    if (!(file instanceof File)) return json({ error: 'No file provided' }, 400);
    if (!VALID_CATEGORIES.has(category)) return json({ error: 'Invalid category' }, 400);
    if (!(file.type in VALID_MIME))
      return json({ error: 'Only video/mp4, video/webm, and image/gif are accepted' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'File exceeds 50 MB limit' }, 400);
    if (file.size === 0) return json({ error: 'File is empty' }, 400);

    // 3. Build storage path
    const ext      = VALID_MIME[file.type];
    const base     = slugify(title ?? '') || crypto.randomUUID().slice(0, 8);
    const uniqueId = crypto.randomUUID().slice(0, 8);
    const path     = `${category}/${base}-${uniqueId}${ext}`;

    // 4. Upload
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await sb.storage
      .from('memes')
      .upload(path, bytes, { contentType: file.type, upsert: false });

    if (uploadErr) {
      console.error('[admin-upload-meme] storage error:', uploadErr.message);
      return json({ error: `Storage upload failed: ${uploadErr.message}` }, 500);
    }

    // 5. Public URL
    const { data: { publicUrl } } = sb.storage.from('memes').getPublicUrl(path);

    // 6. Insert DB row
    const { data: row, error: dbErr } = await sb
      .from('memes')
      .insert({ category, storage_path: path, file_url: publicUrl, title, content_type: file.type, active: true })
      .select()
      .single();

    if (dbErr) {
      console.error('[admin-upload-meme] db error:', dbErr.message);
      await sb.storage.from('memes').remove([path]);
      return json({ error: `Database insert failed: ${dbErr.message}` }, 500);
    }

    return json({ success: true, meme: row });

  } catch (err) {
    console.error('[admin-upload-meme] unexpected:', err);
    return json({ error: 'Internal server error' }, 500);
  }
});
