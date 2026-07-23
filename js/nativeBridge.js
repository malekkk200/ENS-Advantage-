/* ═══════════════════════════════════════════════════════════════
   NATIVE BRIDGE — screenshot/recording event reporting
   ───────────────────────────────────────────────────────────────
   The iOS app (mobile-app/ios/App/App/SecureViewController.swift)
   loads this live site inside its WebView and calls
   window.__ensReportSecurityEvent(eventType) when it detects a
   screenshot or the start/end of screen recording. This file wires
   that call through to the log-screenshot-event Edge Function,
   using the session that's already signed in here — the native side
   never needs its own copy of the Supabase auth token.

   Harmless on Android and on the plain website too: if nothing ever
   calls this function, it just sits unused. Not meant to be called
   from anywhere in this codebase itself — it exists purely as the
   landing point for the native call.
═══════════════════════════════════════════════════════════════ */
import { sb, Supabase } from './supabaseClient.js';

async function reportSecurityEvent(eventType) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // not signed in — nothing to attribute this to

    await Supabase.callFunction('log-screenshot-event', {
      event_type: eventType,
      platform: 'ios',
      context: document.title || location.hash || '',
    });
  } catch (_err) {
    // Best-effort only — never let a logging failure affect the app.
  }
}

window.__ensReportSecurityEvent = reportSecurityEvent;
