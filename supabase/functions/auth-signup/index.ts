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

const buildOtpHtml = (code: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>ENS ADVANTAGE — Verification Code</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10);">
        <tr>
          <td style="background:linear-gradient(135deg,#0f1f3d 0%,#1a3460 100%);padding:32px 32px 28px;text-align:center;">
            <div style="display:inline-block;width:52px;height:52px;background:rgba(255,255,255,.15);border-radius:12px;line-height:52px;font-size:26px;font-weight:800;color:white;border:1px solid rgba(255,255,255,.2);margin-bottom:12px;">E</div>
            <h1 style="margin:0;color:white;font-size:22px;font-weight:800;">ENS ADVANTAGE</h1>
            <p style="margin:6px 0 0;color:#94a3b8;font-size:14px;">Email Verification</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 24px;">
            <p style="margin:0 0 8px;color:#334155;font-size:15px;">Hello,</p>
            <p style="margin:0 0 28px;color:#475569;font-size:15px;line-height:1.6;">Use the code below to verify your ENS Advantage account. It expires in <strong>10 minutes</strong>.</p>
            <div style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:12px;padding:28px 16px;text-align:center;margin-bottom:28px;">
              <div style="font-size:42px;font-weight:800;letter-spacing:14px;font-family:monospace;color:#0f1f3d;line-height:1;">${code}</div>
              <p style="margin:12px 0 0;color:#94a3b8;font-size:12px;letter-spacing:.04em;text-transform:uppercase;">Verification Code</p>
            </div>
            <p style="margin:0 0 8px;color:#64748b;font-size:13px;line-height:1.6;">Enter this code on the ENS Advantage website to activate your account.</p>
            <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">If you did not request this code, you can safely ignore this email.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">&copy; ${new Date().getFullYear()} ENS ADVANTAGE &middot; École Normale Supérieure &middot; English Department</p>
            <p style="margin:8px 0 0;color:#cbd5e1;font-size:11px;">This is an automated transactional email. Please do not reply.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const buildOtpText = (code: string) =>
`ENS ADVANTAGE — Email Verification
====================================

Your verification code is: ${code}

This code expires in 10 minutes.

Enter it on the ENS Advantage website to activate your account.

If you did not request this, please ignore this email.

---
ENS ADVANTAGE | École Normale Supérieure | English Department
This is an automated transactional email. Please do not reply.`;

// listUsers() is paginated (1000/page max) and has no server-side email
// filter, so a single call only ever sees the first page — once the
// user base passes 1000 accounts, an existing user past that point
// would look "new" here and hit createUser() again (which at least
// fails loudly rather than corrupting anything, but breaks signup/
// resend for them regardless). This walks every page until the email
// is found or the pages run out.
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

// ─── Shared OTP send helper ───────────────────────────────────────────────────
// pendingPassword: if set, the password is NOT applied to the auth account yet.
// It's stored alongside the OTP row and only applied by auth-verify-otp once
// the code for THIS email is successfully verified. This is what prevents
// someone from hijacking an existing account just by re-submitting the signup
// form with that account's email and a password of their choosing.
async function sendOtp(
  sb: ReturnType<typeof createClient>,
  emailLower: string,
  smtpUser: string,
  smtpPass: string,
  pendingPassword?: string,
): Promise<{ error?: string }> {
  // Rate-limit: max 1 OTP per 60s
  const { data: recent } = await sb
    .from('otp_codes')
    .select('created_at')
    .eq('email', emailLower)
    .eq('used', false)
    .gt('created_at', new Date(Date.now() - 60_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  if (recent && recent.length > 0) {
    return { error: 'Please wait 60 seconds before requesting a new code.' };
  }

  // Invalidate old codes
  await sb.from('otp_codes').update({ used: true }).eq('email', emailLower).eq('used', false);

  // Generate OTP
  const code = Math.floor(100_000 + Math.random() * 900_000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  const { error: insertErr } = await sb.from('otp_codes').insert({
    email: emailLower,
    code,
    expires_at: expiresAt,
    used: false,
    attempts: 0,
    pending_password: pendingPassword ?? null,
  });
  if (insertErr) {
    console.error('otp_codes insert failed:', insertErr.message);
    return { error: 'Failed to store verification code.' };
  }

  // Send via Brevo SMTP relay
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
      pool: false,
    });

    await transporter.sendMail({
      from: '"ENS ADVANTAGE" <rahalmalek.eng@gmail.com>',
      to: emailLower,
      subject: `[${code}] Your ENS Advantage verification code`,
      text: buildOtpText(code),
      html: buildOtpHtml(code),
      headers: {
        'X-Entity-Ref-ID': `ens-advantage-otp-${Date.now()}`,
        'X-Mailer': 'ENS-Advantage-Mailer/1.0',
        'Precedence': 'transactional',
        'Auto-Submitted': 'auto-generated',
      },
    });
  } catch (mailErr) {
    console.error('Brevo SMTP send failed:', mailErr instanceof Error ? mailErr.message : mailErr);
    return { error: 'Could not send verification email. Please try again shortly.' };
  }

  return {};
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const { email, password, firstName, lastName, dob, resend } = body;

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const smtpUser = Deno.env.get('BREVO_SMTP_USER');
    const smtpPass = Deno.env.get('BREVO_SMTP_PASS');
    if (!smtpUser || !smtpPass) {
      console.error('Missing BREVO_SMTP_USER / BREVO_SMTP_PASS secrets.');
      return json({ error: 'Email service is not configured. Please contact support.' }, 500);
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── RESEND MODE: existing user just needs a fresh OTP, no account changes ──
    if (resend) {
      if (!email) return json({ error: 'Missing email' }, 400);
      const emailLower = email.toLowerCase().trim();
      if (!emailRe.test(emailLower)) return json({ error: 'Invalid email address' }, 400);

      // Verify the user actually exists before resending
      const { user: existingUser, error: findErr } = await findUserByEmail(sb, emailLower);
      if (findErr) {
        console.error('listUsers failed:', findErr.message);
        return json({ error: 'Could not verify account status. Please try again.' }, 500);
      }
      if (!existingUser) {
        return json({ error: 'No account found for this email. Please sign up first.' }, 404);
      }

      const { error: otpErr } = await sendOtp(sb, emailLower, smtpUser, smtpPass);
      if (otpErr) return json({ error: otpErr }, otpErr.includes('60 seconds') ? 429 : 500);

      return json({ success: true });
    }

    // ── SIGNUP MODE ───────────────────────────────────────────────────────────
    if (!email || !password || !firstName || !lastName) {
      return json({ error: 'Missing required fields' }, 400);
    }

    const emailLower = email.toLowerCase().trim();
    if (!emailRe.test(emailLower)) return json({ error: 'Invalid email address' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

    const { user: existingUser, error: listErr } = await findUserByEmail(sb, emailLower);
    if (listErr) {
      console.error('listUsers failed:', listErr.message);
      return json({ error: 'Could not verify account status. Please try again.' }, 500);
    }

    if (!existingUser) {
      // Brand new account — safe to create immediately. The account is
      // unusable (email_confirm is set for Supabase's own bookkeeping, but
      // login is still gated by our own OTP step in the client) until the
      // OTP is verified.
      const { data: created, error: createErr } = await sb.auth.admin.createUser({
        email: emailLower,
        password,
        email_confirm: true,
        user_metadata: { first_name: firstName, last_name: lastName, dob: dob || '' },
      });
      if (createErr || !created?.user) {
        console.error('createUser failed:', createErr?.message);
        return json({ error: createErr?.message || 'Could not create account' }, 400);
      }
      const userId = created.user.id;

      const { error: upsertErr } = await sb
        .from('user_profiles')
        .upsert(
          { id: userId, first_name: firstName, last_name: lastName, dob: dob || null },
          { onConflict: 'id', ignoreDuplicates: false }
        );
      if (upsertErr) {
        console.error('user_profiles upsert failed:', upsertErr.message, upsertErr.details);
      }

      const { error: otpErr } = await sendOtp(sb, emailLower, smtpUser, smtpPass);
      if (otpErr) return json({ error: otpErr }, otpErr.includes('60 seconds') ? 429 : 500);

      return json({ success: true });
    }

    // ── EXISTING ACCOUNT ────────────────────────────────────────────────────
    // SECURITY: We do NOT touch the auth password or the user_profiles row
    // here. Whoever is submitting this form has not proven they own this
    // email yet — only a successfully verified OTP proves that. The new
    // password is stashed on the OTP row and applied by auth-verify-otp
    // only once the code sent to this email is confirmed. This mirrors how
    // auth-forgot-password already handles password changes.
    const { error: otpErr } = await sendOtp(sb, emailLower, smtpUser, smtpPass, password);
    if (otpErr) return json({ error: otpErr }, otpErr.includes('60 seconds') ? 429 : 500);

    return json({ success: true });
  } catch (err) {
    console.error('auth-signup error:', err instanceof Error ? err.stack : err);
    return json({ error: 'Internal server error. Please try again.' }, 500);
  }
});
