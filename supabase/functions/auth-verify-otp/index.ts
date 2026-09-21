import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [
  'https://ens-advantage.vercel.app',
  Deno.env.get('EXTRA_ALLOWED_ORIGIN') ?? '',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  // Native app (Capacitor, mobile-app/) — without these, verify-OTP
  // requests from the app succeed server-side but the WebView silently
  // discards the response on the CORS mismatch, and the app shows a
  // generic "network error" instead of ever completing signup. See
  // supabase/functions/_shared/security.ts, which needed this
  // identical origin list first.
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
    'Vary': 'Origin',
  };
}

const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  // Defined per-request (captures THIS request's own Origin via
  // closure) rather than at module scope — see auth-signup for why.
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const { email, code } = body;

    if (!email || !code) return json({ error: 'Missing email or code' }, 400);

    const emailLower = email.toLowerCase().trim();
    const codeClean = String(code).trim();

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Find a valid, unused, non-expired OTP for this email
    const { data, error } = await sb
      .from('otp_codes')
      .select('id, code, attempts, pending_password')
      .eq('email', emailLower)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return json({ error: 'Invalid or expired code. Please request a new one.' }, 400);
    }

    // Brute-force protection: lock this code out after MAX_ATTEMPTS wrong guesses.
    if (data.attempts >= MAX_ATTEMPTS) {
      await sb.from('otp_codes').update({ used: true }).eq('id', data.id);
      await sb.from('security_logs').insert({
        event_type: 'auth_otp_locked', actor_email: emailLower, success: false,
        ip_address: req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for'),
        user_agent: req.headers.get('user-agent'), detail: {},
      }).catch(() => {});
      return json({ error: 'Too many incorrect attempts. Please request a new code.' }, 429);
    }

    const expected = data.code.padStart(6, '0');
    const received = codeClean.padStart(6, '0');
    if (expected !== received) {
      const attempts = data.attempts + 1;
      const update: Record<string, unknown> = { attempts };
      if (attempts >= MAX_ATTEMPTS) update.used = true; // burn the code on the final allowed miss
      await sb.from('otp_codes').update(update).eq('id', data.id);
      await sb.from('security_logs').insert({
        event_type: 'auth_otp_failed', actor_email: emailLower, success: false,
        ip_address: req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for'),
        user_agent: req.headers.get('user-agent'), detail: { attempts },
      }).catch(() => {});

      return json(
        attempts >= MAX_ATTEMPTS
          ? { error: 'Too many incorrect attempts. Please request a new code.' }
          : { error: 'Incorrect code. Please check and try again.' },
        attempts >= MAX_ATTEMPTS ? 429 : 400,
      );
    }

    // Mark OTP as used immediately
    await sb.from('otp_codes').update({ used: true }).eq('id', data.id);

    // Look up the auth user now — needed both for the pending_password
    // branch below AND for the user_profiles self-heal that follows it.
    // listUsers() only returns one page (max 1000) per call with no
    // server-side email filter — walk pages until found or exhausted
    // so this doesn't silently miss a real user past the first 1000.
    let user: { id: string; user_metadata?: Record<string, unknown> } | undefined;
    {
      let page = 1;
      for (;;) {
        const { data: pageData, error: pageErr } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        if (pageErr) { console.error('listUsers failed:', pageErr.message); break; }
        user = pageData?.users?.find((u) => u.email === emailLower);
        if (user || !pageData?.users || pageData.users.length < 1000) break;
        page++;
      }
    }

    // If this OTP was issued for an existing-account re-registration
    // (see auth-signup), the new password only gets applied now — after
    // the code for this exact email has been proven correct.
    if (data.pending_password) {
      if (user) {
        const { error: pwErr } = await sb.auth.admin.updateUserById(user.id, {
          password: data.pending_password,
        });
        if (pwErr) {
          console.error('Failed to apply pending_password:', pwErr.message);
          return json({ error: 'Verified, but failed to update password. Please try resetting your password.' }, 500);
        }
      }
      // Never leave the plaintext password sitting in the table longer than necessary.
      await sb.from('otp_codes').update({ pending_password: null }).eq('id', data.id);
    }

    // ── Self-heal a missing user_profiles row ──────────────────────────────
    // Bug: some accounts (created before the auth-signup upsert existed, or
    // hitting any other edge case where that upsert silently failed) have an
    // auth.users row but no public.user_profiles row. The client can never
    // repair this itself — user_profiles has RLS policies that deny client
    // insert/update entirely (service-role only) — and the "existing
    // account" branch of auth-signup deliberately skips touching
    // user_profiles for security reasons (see comment there). This left
    // affected users permanently stuck with a blank "?" avatar and no name,
    // even though login itself succeeded.
    // Every successful OTP verification (fresh signup OR re-verification of
    // an existing account) now runs this upsert with ignoreDuplicates:true,
    // so it's a no-op when a profile already exists and a one-time repair
    // when it doesn't — using whatever name/dob is on the auth user's
    // metadata (set at original signup) as the source of truth.
    if (user) {
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
        console.error('user_profiles self-heal upsert failed:', healErr.message, healErr.details);
      }
    }

    // Generate a one-time magic-link token so the client can open a session
    // without ever needing the user's password on the client side.
    const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
      type: 'magiclink',
      email: emailLower,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error('generateLink failed:', linkErr);
      // OTP is still valid — return success but signal client to fall back to password login
      return json({ success: true, token_hash: null });
    }

    return json({ success: true, token_hash: linkData.properties.hashed_token });
  } catch (err) {
    console.error('auth-verify-otp error:', err);
    return json({ error: 'Internal server error.' }, 500);
  }
});
