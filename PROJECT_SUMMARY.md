# ENS Advantage — Project Summary

*Internal reference document. Last verified: July 2026, against the live codebase and Supabase project.*

## 1. Overview & Audience

ENS Advantage is an academic platform built for first-year English
Department students across École Normale Supérieure (ENS) campuses in
Algeria. It gives subscribed students access to lesson summaries, full
lessons, and study guides organized by module and semester, plus a
grade calculator. Free "summary" content is open to any signed-in
student; full lessons and guides are premium content unlocked by a
paid subscription, verified manually by the platform admin.

## 2. Tech Stack

| Layer | Provider | Role |
|---|---|---|
| Frontend | Vercel (static hosting) | Serves the site (vanilla HTML/CSS/JS, no build step). Installable as a PWA (`manifest.json` + `sw.js`) on any device. |
| Database & Auth | Supabase (Postgres + Auth + Storage + Edge Functions + Realtime) | User accounts, course content, subscriptions, file storage (PDFs), server-side business logic, live device-kick signaling. |
| Transactional Email | Brevo | Sends signup OTP and password-reset emails (called from `auth-signup` / `auth-forgot-password` Edge Functions). |
| Security / CDN | Cloudflare | **Configured but not currently active** — `CLOUDFLARE-SETUP.md` documents DNS/WAF/TLS setup for use once a custom domain is pointed at Cloudflare. The live site is still on `ens-advantage.vercel.app`, served directly by Vercel's own edge network. |
| Mobile — Android | Capacitor wrapper (`mobile-app/android`) | Loads the live site in a WebView; `MainActivity.java` sets `WindowManager.LayoutParams.FLAG_SECURE`, an OS-enforced flag that blocks screenshots and screen recording and hides the app from the Recent Apps thumbnail. Not yet built into an installable file. |
| Mobile — iOS | Capacitor wrapper (`mobile-app/ios`) | Same live site, loaded via `SecureViewController.swift`. Blacks out the screen for the duration of an active screen recording (`UIScreen.isCaptured`) — a genuine block. A single screenshot cannot be blocked on iOS by any app (no such API exists); instead it's detected (`userDidTakeScreenshotNotification`) and reported to the backend. Not yet built into an installable file. |

## 3. Security & Anti-Theft Measures

These are **deterrents and detection**, not guarantees against all forms
of leaking — see the note at the end of this section.

- **Dynamic watermarking** — every page of premium (paid) content —
  both PDF lessons and HTML-rendered lessons — is overlaid with a
  dense, tiled, semi-transparent watermark showing the viewing
  student's **name, email, and the exact date/time the page was
  opened**. Free "summary" content is not watermarked. *(Correction to
  an earlier internal description: the watermark does not contain
  phone number, IP address, or session ID — only name/email/timestamp,
  rendered client-side.)*
- **Single-device session lock** — the `active_sessions` table
  restricts each account to one signed-in device at a time. Logging in
  on a new device deletes the previous device's session row; that
  device, listening via Supabase Realtime, is immediately signed out
  with an on-screen notice. Aimed at account-sharing, not screenshots.
- **Custom PDF viewer** — lessons are rendered page-by-page as
  `<canvas>` elements via PDF.js, with no download button or link
  exposed anywhere in the UI. Right-click, drag, text selection,
  printing, and common capture-related keyboard shortcuts are blocked
  at the browser level; the view blurs when the tab loses focus or a
  screenshot-adjacent key combination is pressed.
- **Native mobile protections** — see the Android/iOS rows in the tech
  stack table above.
- **Security event logging** — the `security_logs` table (service-role
  write-only; no client can read or write it directly) records admin
  actions, failed/locked login attempts, and — as of this security
  pass — screenshot/recording events reported by the native apps, each
  tied to the acting account's email, IP address, and user-agent.

**Honest limit:** none of the above can prevent someone from
photographing the screen with a second device's camera — that is true
of every platform, not a gap specific to this one. The realistic goal
of this layer is to make unauthorized sharing traceable and
account-terminable under the Terms of Service, not physically
impossible.

## 4. Data Collected

Verified directly against the live schema (`user_profiles`,
`subscription_requests`, `active_sessions`, `security_logs`) rather
than assumed:

| Data | Where | Purpose |
|---|---|---|
| Email, password | Supabase Auth (`auth.users`) | Account identity and login. Password is hashed by Supabase Auth; the app never sees or stores it in plain text. |
| First name, last name, date of birth | `user_profiles` | Displayed in the app (e.g. watermarking) and used to personalize the experience. |
| Subscription access flags (`has_s1_access`, `has_s2_access`) | `user_profiles` | Determines which semester's premium content the account can view. |
| Full name, email, plan chosen, payment reference | `subscription_requests` | Submitted by the student to request a paid subscription; reviewed manually by the admin before access is granted. |
| Device/session identifier, best-effort device label, timestamps | `active_sessions` | Enforces the single-device session policy. |
| IP address, user-agent, event type, associated account email | `security_logs` | Security/audit trail for admin actions, failed logins, and screenshot/recording detection events. Not readable by any client, including the account it concerns. |

**Not collected**: phone number (no field exists anywhere in the
schema), payment card details (subscriptions are verified manually
against a submitted reference, not processed by this platform), or
precise geolocation.
