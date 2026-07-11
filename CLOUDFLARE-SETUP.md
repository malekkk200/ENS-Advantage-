# Cloudflare Free Plan Setup — ENS Advantage

ENS Advantage is a static site deployed on **Vercel**. Cloudflare sits in
front of it as DNS + CDN/WAF proxy (domain's nameservers point to
Cloudflare, and a proxied CNAME/A record points at Vercel). Almost
everything below is a **Cloudflare Dashboard setting**, not something
that lives in this repo — Cloudflare's Free plan has no Infrastructure-
as-Code (Terraform/API token) access included for zone-level settings
in this project, so it must be configured manually once per domain.

If you're already on `ens-advantage.vercel.app` (Vercel's own domain)
rather than a custom domain, **none of this applies yet** — Cloudflare
only sits in front of a domain if you own the DNS for it. To use any of
this, you'd first buy/point a custom domain and follow Vercel's
"Add Domain" + Cloudflare's "Add a Site" flow.

## 1. DNS
- Add your domain to Cloudflare, update nameservers at your registrar.
- `A`/`CNAME` record for the apex/`www` → Vercel's target (per Vercel's
  domain setup instructions) — **Proxy status: Proxied (orange cloud)**.
- Enable **DNSSEC** (free, Dashboard → DNS → Settings).

## 2. SSL/TLS
- SSL/TLS → Overview → **Full (Strict)** (Vercel serves valid certs, so
  Strict is safe and prevents a downgrade-to-HTTP hop between Cloudflare
  and Vercel).
- Edge Certificates →
  - **Always Use HTTPS**: On
  - **Automatic HTTPS Rewrites**: On
  - **Minimum TLS Version**: 1.2
  - **TLS 1.3**: On
  - **HSTS**: enable with `max-age=63072000; includeSubDomains; preload`
    (this repo also sends this header from Vercel directly — enabling it
    at Cloudflare too is redundant but harmless and covers edge-only
    responses like error pages).

## 3. Speed
- Speed → Optimization → **Brotli**: On
- **Early Hints**: On (Free plan includes this)
- Network → **HTTP/3 (with QUIC)**: On
- **HTTP/2**: On by default
- Auto Minify: safe to enable for **HTML, CSS, JS** — this is a static
  site with no build step, so minifying at the edge is low-risk. Test
  after enabling, since aggressive JS minification has occasionally
  broken template-literal-heavy code in the past.

## 4. Caching
- Caching → Configuration → **Caching Level**: Standard
- **Browser Cache TTL**: Respect Existing Headers (this repo already
  sends explicit `Cache-Control` via `vercel.json` — `immutable,
  max-age=31536000` for `/assets`, `/css`, `/js`, and `no-cache`-style
  revalidation for `index.html` — so let Cloudflare defer to those
  rather than overriding them).
- Optional Cache Rule (Rules → Cache Rules, Free plan includes a
  limited number): cache everything under `/assets/*`, `/css/*`,
  `/js/*` at the edge for a long TTL, bypass cache for `/` and any
  future API-like paths.

## 5. Security Level & WAF
- Security → Settings → **Security Level**: Medium (High is fine too;
  this site has no login-wall content worth being aggressive about, and
  Medium avoids annoying legitimate students with challenges).
- **Bot Fight Mode**: On (Free plan feature — challenges known bad bots;
  keep an eye on it after enabling in case it ever challenges the
  Supabase/Telegram link-preview crawlers you rely on for OG images).
- WAF → Managed Rules: enable the **Cloudflare Free Managed Ruleset**
  (OWASP-style core ruleset is Free-plan eligible in most zones — check
  your dashboard, it's included for all plans as of Cloudflare's 2024
  WAF changes). Leave in "Log" mode for a week before switching flagged
  rules to "Block" so you can confirm nothing legitimate (e.g. the admin
  panel's multipart PDF/video uploads) gets false-positived.
- **Rate Limiting Rules** (Free plan includes a small quota): add a rule
  like "if URI path contains `/auth-verify-otp` or `/auth-signup` or
  `/submit-subscription`, and requests from the same IP exceed 20 in 1
  minute → Challenge or Block for 10 minutes." This backs up the
  application-level rate limiting already implemented in
  `submit-subscription` and the OTP attempt-lockout, at the edge instead
  of Supabase compute.
- **Hotlink Protection**: not necessary — `/assets/logo.jpg` is meant to
  be embedded in social link previews (Open Graph), and the meme storage
  bucket is intentionally public. Enabling this would break both.

## 6. What requires Cloudflare Pro or higher (not available today)
- Advanced/custom WAF rules beyond the included managed ruleset count.
- Advanced Rate Limiting with more granular rule counts.
- Image Resizing / Polish (automatic image optimization at the edge).
- Argo Smart Routing (paid add-on even on Pro).
- Web Application Firewall's full OWASP ruleset customization.
- Load Balancing.

## 7. What must be enabled manually (cannot be set from this repo)
Everything in sections 1–5 above. Additionally, outside Cloudflare
entirely:
- **Supabase → Authentication → Policies → "Leaked password
  protection"**: currently disabled per Supabase's own security
  advisor. Enable it in the Supabase Dashboard (Auth → Providers →
  Password → check "Leaked password protection" or the equivalent in
  Auth settings) — it checks new passwords against HaveIBeenPwned
  without sending the raw password anywhere.
- **Vercel/Supabase secrets**: confirm `ADMIN_EMAIL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and Brevo SMTP credentials are set as
  Edge Function secrets (Project Settings → Edge Functions → Secrets),
  not committed anywhere — this was already the case for most functions
  and is now the case for all of them after this pass.
