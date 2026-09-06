/* ═══════════════════════════════════════════════════════════════
   NATIVE BRIDGE — screenshot/recording/integrity event reporting
   ───────────────────────────────────────────────────────────────
   The iOS app (mobile-app/ios/App/App/SecureViewController.swift)
   loads this live site inside its WebView and calls
   window.__ensReportSecurityEvent(eventType) when it detects a
   screenshot or the start/end of screen recording. This file wires
   that call through to the log-screenshot-event Edge Function,
   using the session that's already signed in here — the native side
   never needs its own copy of the Supabase auth token.

   Also used by deviceIntegrity.js (same function, different caller)
   to report a rooted/jailbroken/tampered-device finding — which is
   why platform/context are now optional parameters instead of a
   hardcoded 'ios' literal: this function is no longer iOS-only, only
   iOS-originated by default (matching every existing call site
   before this comment was updated).

   Harmless on Android and on the plain website too: if nothing ever
   calls this function, it just sits unused.
═══════════════════════════════════════════════════════════════ */
import { sb, Supabase } from './supabaseClient.js';

async function reportSecurityEvent(eventType, { platform = 'ios', context = '' } = {}) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // not signed in — nothing to attribute this to

    await Supabase.callFunction('log-screenshot-event', {
      event_type: eventType,
      platform,
      context: context || document.title || location.hash || '',
    });
  } catch (_err) {
    // Best-effort only — never let a logging failure affect the app.
  }
}

window.__ensReportSecurityEvent = reportSecurityEvent;
