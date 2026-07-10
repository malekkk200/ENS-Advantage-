import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

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
      return json({ error: 'Too many incorrect attempts. Please request a new code.' }, 429);
    }

    const expected = data.code.padStart(6, '0');
    const received = codeClean.padStart(6, '0');
    if (expected !== received) {
      const attempts = data.attempts + 1;
      const update: Record<string, unknown> = { attempts };
      if (attempts >= MAX_ATTEMPTS) update.used = true; // burn the code on the final allowed miss
      await sb.from('otp_codes').update(update).eq('id', data.id);

      return json(
        attempts >= MAX_ATTEMPTS
          ? { error: 'Too many incorrect attempts. Please request a new code.' }
          : { error: 'Incorrect code. Please check and try again.' },
        attempts >= MAX_ATTEMPTS ? 429 : 400,
      );
    }

    // Mark OTP as used immediately
    await sb.from('otp_codes').update({ used: true }).eq('id', data.id);

    // If this OTP was issued for an existing-account re-registration
    // (see auth-signup), the new password only gets applied now — after
    // the code for this exact email has been proven correct.
    if (data.pending_password) {
      const { data: userList } = await sb.auth.admin.listUsers({ perPage: 1000 });
      const user = userList?.users?.find((u) => u.email === emailLower);
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
