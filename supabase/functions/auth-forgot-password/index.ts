import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer';

const CORS = {
  'Access-Control-Allow-Origin': 'https://ens-advantage.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const MAX_ATTEMPTS = 5;

// ─── Email template ───────────────────────────────────────────────────────────────
const buildHtml = (code: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>ENS ADVANTAGE — Password Reset</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
        <tr>
          <td style="background:linear-gradient(135deg,#0f1f3d 0%,#1a3460 100%);padding:32px 32px 28px;text-align:center;">
            <div style="display:inline-block;width:52px;height:52px;background:rgba(255,255,255,.15);border-radius:12px;line-height:52px;font-size:26px;font-weight:800;color:white;border:1px solid rgba(255,255,255,.2);margin-bottom:12px;">E</div>
            <h1 style="margin:0;color:white;font-size:22px;font-weight:800;">ENS ADVANTAGE</h1>
            <p style="margin:6px 0 0;color:#94a3b8;font-size:14px;">Password Reset</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 24px;">
            <p style="margin:0 0 8px;color:#334155;font-size:15px;">Hello,</p>
            <p style="margin:0 0 28px;color:#475569;font-size:15px;line-height:1.6;">You requested a password reset. Use the code below to set a new password. It expires in <strong>10 minutes</strong>.</p>
            <div style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:28px 16px;text-align:center;margin-bottom:28px;">
              <div style="font-size:42px;font-weight:800;letter-spacing:14px;font-family:monospace;color:#0f1f3d;line-height:1;">${code}</div>
              <p style="margin:12px 0 0;color:#94a3b8;font-size:12px;letter-spacing:.04em;text-transform:uppercase;">Password Reset Code</p>
            </div>
            <p style="margin:0 0 8px;color:#64748b;font-size:13px;line-height:1.6;">Enter this code on the ENS Advantage website to set your new password.</p>
            <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">If you did not request a password reset, you can safely ignore this email. Your password will not change.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} ENS ADVANTAGE &middot; École Normale Supérieure &middot; English Department</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const buildText = (code: string) =>
`ENS ADVANTAGE — Password Reset
===============================

Your password reset code is: ${code}

This code expires in 10 minutes.

Enter it on the ENS Advantage website to set your new password.

If you did not request this, please ignore this email — your password will not change.

---
ENS ADVANTAGE | École Normale Supérieure | English Department`;

// listUsers() only returns one page (max 1000) per call with no
// server-side email filter — past 1000 total accounts, a single call
// can silently miss a real user. This walks pages until found or
// exhausted, same fix as auth-signup / auth-verify-otp.
async function findUserByEmail(
  sb: ReturnType<typeof createClient>,
  emailLower: string,
) {
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) return { user: undefined, error };
    const found = data?.users?.find((u) => u.email === emailLower);
    if (found) return { user: found, error: null };
    if (!data?.users || data.users.length < perPage) return { user: undefined, error: null };
    page++;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const { action, email, code, password } = body;

    if (!email) return json({ error: 'Missing email.' }, 400);

    const emailLower = String(email).toLowerCase().trim();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(emailLower)) return json({ error: 'Invalid email address.' }, 400);

    // Prefix used to keep reset codes separate from signup OTPs in the same table
    const resetKey = `reset:${emailLower}`;

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── SEND reset code ─────────────────────────────────────────────────────────────
    if (action === 'send') {
      // Verify the account exists (don't reveal this in the response — always say success)
      const { user: existingUser, error: findErr } = await findUserByEmail(sb, emailLower);
      if (findErr) console.error('listUsers failed:', findErr.message);
      const userExists = !!existingUser;
      // We still return success even if the account doesn't exist (security)

      if (userExists) {
        // Rate-limit: max 1 code per 60 s
        const { data: recent } = await sb
          .from('otp_codes')
          .select('created_at')
          .eq('email', resetKey)
          .eq('used', false)
          .gt('created_at', new Date(Date.now() - 60_000).toISOString())
          .limit(1);

        if (recent && recent.length > 0) {
          return json({ error: 'Please wait 60 seconds before requesting another code.' }, 429);
        }

        // Invalidate any existing reset codes for this email
        await sb.from('otp_codes').update({ used: true }).eq('email', resetKey).eq('used', false);

        // Generate and store new code
        const newCode = Math.floor(100_000 + Math.random() * 900_000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

        const { error: insertErr } = await sb.from('otp_codes').insert({
          email: resetKey, code: newCode, expires_at: expiresAt, used: false, attempts: 0,
        });
        if (insertErr) {
          console.error('otp_codes insert:', insertErr.message);
          return json({ error: 'Could not generate reset code. Please try again.' }, 500);
        }

        // Send via Brevo
        const smtpUser = Deno.env.get('BREVO_SMTP_USER');
        const smtpPass = Deno.env.get('BREVO_SMTP_PASS');
        if (!smtpUser || !smtpPass) {
          console.error('Missing BREVO_SMTP_USER / BREVO_SMTP_PASS');
          return json({ error: 'Email service not configured.' }, 500);
        }

        try {
          const transporter = nodemailer.createTransport({
            host: 'smtp-relay.brevo.com', port: 587, secure: false,
            auth: { user: smtpUser, pass: smtpPass }, pool: false,
          });
          await transporter.sendMail({
            from: '"ENS ADVANTAGE" <rahalmalek.eng@gmail.com>',
            to: emailLower,
            subject: `[${newCode}] Your ENS Advantage password reset code`,
            text: buildText(newCode),
            html: buildHtml(newCode),
            headers: {
              'X-Entity-Ref-ID': `ens-advantage-reset-${Date.now()}`,
              'Precedence': 'transactional',
              'Auto-Submitted': 'auto-generated',
            },
          });
        } catch (mailErr) {
          console.error('Brevo SMTP error:', mailErr instanceof Error ? mailErr.message : mailErr);
          return json({ error: 'Could not send email. Please try again shortly.' }, 500);
        }
      }

      // Always return success (never reveal whether the account exists)
      return json({ success: true });
    }

    // ── VERIFY reset code + update password ───────────────────────────────────────────────────
    if (action === 'verify') {
      if (!code || !password) return json({ error: 'Missing code or password.' }, 400);
      if (String(password).length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

      const codeClean = String(code).trim();

      const { data: otpRow, error: otpErr } = await sb
        .from('otp_codes')
        .select('id, code, attempts')
        .eq('email', resetKey)
        .eq('used', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (otpErr || !otpRow) {
        return json({ error: 'Invalid or expired code. Please request a new one.' }, 400);
      }

      // Brute-force protection: lock this code out after MAX_ATTEMPTS wrong guesses.
      if (otpRow.attempts >= MAX_ATTEMPTS) {
        await sb.from('otp_codes').update({ used: true }).eq('id', otpRow.id);
        return json({ error: 'Too many incorrect attempts. Please request a new code.' }, 429);
      }

      if (otpRow.code.padStart(6, '0') !== codeClean.padStart(6, '0')) {
        const attempts = otpRow.attempts + 1;
        const update: Record<string, unknown> = { attempts };
        if (attempts >= MAX_ATTEMPTS) update.used = true;
        await sb.from('otp_codes').update(update).eq('id', otpRow.id);

        return json(
          attempts >= MAX_ATTEMPTS
            ? { error: 'Too many incorrect attempts. Please request a new code.' }
            : { error: 'Incorrect code. Please check and try again.' },
          attempts >= MAX_ATTEMPTS ? 429 : 400,
        );
      }

      // Mark code used immediately
      await sb.from('otp_codes').update({ used: true }).eq('id', otpRow.id);

      // Find user
      const { user, error: findErr } = await findUserByEmail(sb, emailLower);
      if (findErr) console.error('listUsers failed:', findErr.message);
      if (!user) return json({ error: 'Account not found.' }, 404);

      // Update password
      const { error: updateErr } = await sb.auth.admin.updateUserById(user.id, { password });
      if (updateErr) {
        console.error('updateUserById:', updateErr.message);
        return json({ error: 'Failed to update password. Please try again.' }, 500);
      }

      return json({ success: true });
    }

    return json({ error: 'Invalid action.' }, 400);
  } catch (err) {
    console.error('auth-forgot-password error:', err);
    return json({ error: 'Internal server error.' }, 500);
  }
});
