// supabase/functions/_shared/security.ts
//
// Shared hardening helpers used by every admin/auth Edge Function:
//   - CORS restricted to known frontend origins (no more `*`)
//   - Admin-email check that FAILS CLOSED if the ADMIN_EMAIL secret is
//     unset, instead of silently falling back to a hardcoded address
//   - A tiny best-effort security event logger (writes to the
//     `security_logs` table via the service-role client; never throws)
//
// This file is deployed alongside each function that imports it
// (Supabase bundles relative imports at deploy time), so it does not
// need to be deployed on its own.

/** Frontend origins allowed to call these functions via CORS. */
const ALLOWED_ORIGINS = [
  "https://ens-advantage.vercel.app",
  // Optional: set EXTRA_ALLOWED_ORIGIN in Edge Function secrets for a
  // custom domain (e.g. https://www.yourdomain.com) without editing code.
  Deno.env.get("EXTRA_ALLOWED_ORIGIN") ?? "",
  // Local development only.
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // Native app (Capacitor, mobile-app/) — the WebView sends one of
  // these as its Origin header, not the website's origin. Without
  // these, the request still succeeds server-side (so security_logs
  // shows success:true) but the browser/WebView silently discards the
  // response due to the CORS mismatch, and the app shows a false
  // "access denied" error even though nothing was actually denied.
  // Android (Capacitor default androidScheme is "https"):
  "https://localhost",
  // iOS (Capacitor default ios scheme):
  "capacitor://localhost",
  // Defensive extra for older WebViews / non-default configs:
  "http://localhost",
].filter(Boolean);

/**
 * Builds CORS headers for a given request, reflecting back the request's
 * Origin only if it's on the allow-list. Falls back to the production
 * origin (not `*`) so browsers still get a valid header on a mismatch —
 * the request will simply be rejected by the browser's CORS check.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/**
 * Returns the authorized admin email, or null if ADMIN_EMAIL is not
 * configured. Callers MUST treat null as "deny" (fail closed) — never
 * fall back to a hardcoded address.
 */
export function getAdminEmail(): string | null {
  const email = Deno.env.get("ADMIN_EMAIL");
  return email && email.trim() ? email.trim().toLowerCase() : null;
}

/**
 * Validates a file's actual binary signature against its claimed MIME
 * type. The browser-supplied Content-Type and file extension can both
 * be spoofed by a malicious client — this checks the real magic bytes
 * so a renamed/relabeled malicious file can't slip past the upload
 * MIME allow-list.
 */
export async function verifyFileSignature(file: File, claimedMime: string): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const hex = Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join("");

  switch (claimedMime) {
    case "application/pdf":
      // "%PDF-"
      return hex.startsWith("255044462d");
    case "image/gif":
      // "GIF87a" or "GIF89a"
      return hex.startsWith("474946383761") || hex.startsWith("474946383961");
    case "image/png":
      // 89 50 4E 47 0D 0A 1A 0A
      return hex.startsWith("89504e470d0a1a0a");
    case "image/jpeg":
      // FF D8 FF
      return hex.startsWith("ffd8ff");
    case "image/webp": {
      // "RIFF" .... "WEBP" — bytes 0-3 and 8-11
      const riff = hex.slice(0, 8) === "52494646";
      const webp = hex.slice(16, 24) === "57454250";
      return riff && webp;
    }
    case "video/webm":
      // EBML header
      return hex.startsWith("1a45dfa3");
    case "video/mp4":
      // ISO base media file format: bytes 4-7 are "ftyp"
      return hex.slice(8, 16) === "66747970";
    default:
      return false;
  }
}

/**
 * Best-effort security/audit logger. Swallows all errors so a logging
 * failure never breaks the calling function's actual behavior.
 * Requires a `security_logs` table (service-role insert only — see
 * the migration that creates it).
 */
export async function logSecurityEvent(
  adminClient: { from: (table: string) => any },
  event: {
    event_type: string;
    actor_email?: string | null;
    success: boolean;
    detail?: Record<string, unknown>;
    req?: Request;
  },
): Promise<void> {
  try {
    const ip =
      event.req?.headers.get("cf-connecting-ip") ??
      event.req?.headers.get("x-forwarded-for") ??
      null;
    const userAgent = event.req?.headers.get("user-agent") ?? null;
    await adminClient.from("security_logs").insert({
      event_type: event.event_type,
      actor_email: event.actor_email ?? null,
      success: event.success,
      ip_address: ip,
      user_agent: userAgent,
      detail: event.detail ?? {},
    });
  } catch (_err) {
    // Never let logging failures break the primary request.
  }
}
