/* ═══════════════════════════════════════════════════════════════
   CONFIG
   ───────────────────────────────────────────────────────────────
   Supabase project connection details.

   NOTE ON SAFETY: the "anon" key below is a PUBLIC key by design —
   Supabase's security model relies on Row Level Security (RLS)
   policies on the database tables/storage buckets, not on hiding
   this key. It is safe to ship inside client-side JavaScript and
   safe to commit to a public GitHub repository. This is the same
   approach Supabase's own documentation uses.
   https://supabase.com/docs/guides/api/api-keys

   These defaults can optionally be overridden at deploy time by
   running `node scripts/inject-env.js` (wired up as the Vercel
   "Build Command" in vercel.json) with SUPABASE_URL and
   SUPABASE_ANON_KEY environment variables set in the Vercel
   dashboard — handy if you ever want to point the same codebase
   at a different Supabase project (e.g. a staging environment)
   without touching code. See README.md for details. If you don't
   need that, just leave the values below as-is.
═══════════════════════════════════════════════════════════════ */

export const SUPABASE_URL = 'https://sjzgjtpkyvrwgdeakoah.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqemdqdHBreXZyd2dkZWFrb2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTY4MzMsImV4cCI6MjA5Njg3MjgzM30.GoSKi2KkGIbHlEGW3I9tAVBBLsbKgfIn6CfUNs0F_nI';
