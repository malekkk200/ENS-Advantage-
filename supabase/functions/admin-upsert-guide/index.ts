// ═════════════════════════════════════════════════════════════════════
// admin-upsert-guide
// ───────────────────────────────────────────────────────────────────
// Writes/updates the "Comprehensive Guide" (الدليل الشامل) content for
// one (semester, module) pair — the HTML-window content type, NOT a
// PDF. Called from the same "رفع درس جديد" admin panel used for PDF
// uploads, but only when the guide content type's text/image mode is
// used.
//
// Accepts multipart/form-data:
//   semester      "1" | "2"                         (required)
//   module_name   string, exact curriculum name      (required)
//   text          plain text — becomes paragraphs    (optional)
//   mode          "append" | "replace"                (default "append")
//   images        0+ image files (repeat the field)   (optional)
//
// Behavior:
//   1. Verifies the caller's JWT and confirms their email matches the
//      ADMIN_EMAIL secret — identical auth boundary to every other
//      admin-* function (see admin-upload-material for the full
//      rationale: single-admin, secret-gated, never a spoofable
//      client-side flag).
//   2. Validates + magic-byte-checks every image, uploads each to the
//      public `guide-images` bucket (client writes to that bucket are
//      denied by storage RLS — this function's service-role client is
//      the only writer), and builds an HTML fragment: escaped text
//      paragraphs, then every newly-uploaded image below them.
//   3. In "append" mode (the default — matches "add pictures BELOW
//      the info I already uploaded"), the new fragment is appended to
//      whatever content_html already exists for that module/semester.
//      In "replace" mode the whole guide is overwritten.
//   4. Upserts the `guides` row (unique on module_name+semester). The
//      table itself denies ALL client writes via RLS — only the
//      service-role key used here can write it; students get free
//      read access regardless of subscription (guides are free).
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, getAdminEmail, logSecurityEvent, verifyFileSignature } from "../_shared/security.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png":  "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif":  "gif",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB — matches the bucket's own limit
const MAX_IMAGES_PER_REQUEST = 20;

/** Escapes text for safe insertion into HTML (this becomes content_html — no other sanitization happens before it's rendered client-side via DOMPurify, but that's a second, independent layer; this function must not rely on it). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text -> safe paragraph HTML. Blank lines separate <p>s; single newlines become <br>.
 * dir="rtl" is set explicitly: this platform's guide content is Arabic-first
 * with embedded English words/numbers, and without an explicit direction the
 * browser defaults to LTR, which misaligns Arabic paragraphs and scrambles
 * the reading order of mixed Arabic/English lines. unicode-bidi:plaintext
 * (applied via CSS on render, not inline here) still lets a rare English-only
 * paragraph read left-to-right instead of being forced backwards. */
function textToParagraphs(text: string): string {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks
    .map((b) => `<p dir="rtl">${escapeHtml(b).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

async function stableModuleHash(semester: number, moduleName: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${semester}:${moduleName}`);
  const digestBuf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digestBuf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed" }, 405);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const AUTHORIZED_ADMIN_EMAIL = getAdminEmail();
    if (!AUTHORIZED_ADMIN_EMAIL) {
      console.error("[admin-upsert-guide] ADMIN_EMAIL secret is not set.");
      return jsonResponse(req, { error: "Admin panel is not configured." }, 500);
    }

    // ── 1. Authenticate the caller ────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) return jsonResponse(req, { error: "Missing authorization token" }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse(req, { error: "Invalid or expired session" }, 401);
    }

    // ── 2. Confirm this is the one authorized account ─────────────
    const callerEmail = (userData.user.email || "").toLowerCase().trim();
    if (callerEmail !== AUTHORIZED_ADMIN_EMAIL) {
      await logSecurityEvent(adminClient, { event_type: "admin_upsert_guide", actor_email: userData.user.email, success: false, detail: { reason: "not_admin" }, req });
      return jsonResponse(req, { error: "Forbidden — admin access required" }, 403);
    }

    // ── 3. Parse multipart form data ───────────────────────────────
    const form = await req.formData();
    const semesterRaw = form.get("semester");
    const moduleName  = (form.get("module_name") || "").toString().trim();
    const text        = (form.get("text") || "").toString();
    const modeRaw     = (form.get("mode") || "append").toString().trim().toLowerCase();
    const mode        = modeRaw === "replace" ? "replace" : "append";
    const imageFiles  = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);

    const semester = parseInt(semesterRaw?.toString() || "", 10);
    if (semester !== 1 && semester !== 2) {
      return jsonResponse(req, { error: "semester must be 1 or 2" }, 400);
    }
    if (!moduleName) {
      return jsonResponse(req, { error: "module_name is required" }, 400);
    }
    if (!text.trim() && imageFiles.length === 0) {
      return jsonResponse(req, { error: "Provide text and/or at least one image" }, 400);
    }
    if (imageFiles.length > MAX_IMAGES_PER_REQUEST) {
      return jsonResponse(req, { error: `You can attach at most ${MAX_IMAGES_PER_REQUEST} images per upload` }, 400);
    }
    for (const f of imageFiles) {
      if (!(f.type in IMAGE_MIME_TO_EXT)) {
        return jsonResponse(req, { error: `Unsupported image type: ${f.type || "unknown"}` }, 400);
      }
      if (f.size > MAX_IMAGE_BYTES) {
        return jsonResponse(req, { error: `Image "${f.name}" exceeds the 10MB limit` }, 400);
      }
    }

    // ── 3b. Magic-byte check every image — Content-Type can be spoofed ──
    for (const f of imageFiles) {
      const ok = await verifyFileSignature(f, f.type);
      if (!ok) {
        await logSecurityEvent(adminClient, { event_type: "admin_upsert_guide", actor_email: userData.user.email, success: false, detail: { reason: "signature_mismatch", file: f.name }, req });
        return jsonResponse(req, { error: `"${f.name}" does not match a valid image file` }, 400);
      }
    }

    // ── 4. Upload images (if any) to the public guide-images bucket ──
    const folderHash = await stableModuleHash(semester, moduleName);
    const uploadedUrls: string[] = [];
    const uploadedPaths: string[] = [];
    for (const f of imageFiles) {
      const ext = IMAGE_MIME_TO_EXT[f.type];
      const path = `s${semester}/${folderHash}/${crypto.randomUUID()}.${ext}`;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { error: upErr } = await adminClient.storage
        .from("guide-images")
        .upload(path, bytes, { contentType: f.type, upsert: false });
      if (upErr) {
        console.error("[admin-upsert-guide] image upload error:", upErr.message);
        // Roll back whatever we already uploaded this request, so a
        // partial failure doesn't leave orphaned images with nothing
        // referencing them.
        if (uploadedPaths.length) await adminClient.storage.from("guide-images").remove(uploadedPaths);
        await logSecurityEvent(adminClient, { event_type: "admin_upsert_guide", actor_email: userData.user.email, success: false, detail: { reason: "storage_error" }, req });
        return jsonResponse(req, { error: `Image upload failed: ${upErr.message}` }, 500);
      }
      uploadedPaths.push(path);
      const { data: pub } = adminClient.storage.from("guide-images").getPublicUrl(path);
      uploadedUrls.push(pub.publicUrl);
    }

    // ── 5. Build the new HTML fragment ─────────────────────────────
    const paragraphHtml = text.trim() ? textToParagraphs(text) : "";
    const imagesHtml = uploadedUrls
      .map((url) => `<img src="${url}" alt="" loading="lazy" style="display:block;width:100%;height:auto;border-radius:10px;margin:1rem 0;" />`)
      .join("\n");
    const newFragment = [paragraphHtml, imagesHtml].filter(Boolean).join("\n");

    // ── 6. Merge with existing content (append) or overwrite (replace) ──
    const { data: existing } = await adminClient
      .from("guides")
      .select("id, content_html")
      .eq("module_name", moduleName)
      .eq("semester", semester)
      .maybeSingle();

    // Old rows can still carry the original seed placeholder ("Guide
    // content coming soon." / "المحتوى قريباً.") as their entire
    // content_html. That placeholder isn't real prior content, so it
    // must never be preserved by appending onto it — strip it before
    // merging, otherwise every future append keeps re-surfacing it
    // above the actual guide text.
    const PLACEHOLDER_RE = /^<div class="mock-content"><h4>🎯[^<]*<\/h4><p><em>(Guide content coming soon\.|المحتوى قريباً\.)<\/em><\/p><\/div>\n?/;
    const existingHtml = (existing?.content_html || "").replace(PLACEHOLDER_RE, "");

    const finalHtml = (mode === "append" && existingHtml)
      ? `${existingHtml}\n${newFragment}`
      : newFragment;

    const { data: row, error: dbErr } = await adminClient
      .from("guides")
      .upsert(
        { module_name: moduleName, semester, content_html: finalHtml },
        { onConflict: "module_name,semester" }
      )
      .select()
      .single();

    if (dbErr) {
      console.error("[admin-upsert-guide] db upsert error:", dbErr.message);
      await logSecurityEvent(adminClient, { event_type: "admin_upsert_guide", actor_email: userData.user.email, success: false, detail: { reason: "db_error" }, req });
      return jsonResponse(req, { error: `Database write failed: ${dbErr.message}` }, 500);
    }

    await logSecurityEvent(adminClient, { event_type: "admin_upsert_guide", actor_email: userData.user.email, success: true, detail: { semester, module_name: moduleName, mode, images: uploadedUrls.length }, req });

    return jsonResponse(req, {
      success: true,
      guide: row,
      images_added: uploadedUrls.length,
    });

  } catch (err) {
    console.error("[admin-upsert-guide] unexpected error:", err);
    return jsonResponse(req, { error: "Internal server error" }, 500);
  }
});
