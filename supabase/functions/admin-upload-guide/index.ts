// ═════════════════════════════════════════════════════════════════════
// admin-upload-guide
// ───────────────────────────────────────────────────────────────────
// Upload path for the "الدليل الشامل" (Comprehensive Guide) content
// type. Unlike the PDF-based admin-upload-material function, a guide
// is plain text plus optional images — it's stored as sanitizeable
// HTML in `guides.content_html` and always opens in the plain HTML
// content window on the client (never the PDF viewer).
//
//   1. Verifies the caller's JWT and confirms their email matches the
//      ADMIN_EMAIL secret — identical boundary to every other admin
//      Edge Function in this project (see admin-upload-material for
//      the full rationale).
//   2. Validates semester / module_name / that at least some content
//      (text or an image) was actually provided.
//   3. Uploads each image (magic-byte verified) to the public
//      'guide-images' bucket using the service role — the bucket
//      denies all client writes by design, this function is the only
//      writer. The bucket is public (like 'memes') so the resulting
//      URLs can be embedded directly and never expire, which matters
//      here since content_html is static, unlike the PDF viewer's
//      short-lived signed URLs.
//   4. Builds simple, escaped HTML from the text (paragraphs) with
//      the images appended below it, then upserts the
//      (module_name, semester) row in `guides` — a fresh upload fully
//      replaces whatever guide existed before for that slot, same as
//      the old PDF-based guide behaviour.
//
// The `guides` table has RLS that denies ALL client writes — the
// service-role client here is the only way rows ever get written.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, getAdminEmail, logSecurityEvent, verifyFileSignature } from "../_shared/security.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // matches the guide-images bucket's file_size_limit
const MAX_IMAGES = 20;

const MIME_EXT: Record<string, string> = {
  "image/png":  ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif":  ".gif",
};

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

async function fallbackSlug(moduleName: string): Promise<string> {
  const bytes = new TextEncoder().encode(moduleName);
  const digestBuf = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `mod-${hex.slice(0, 16)}`;
}

/** Minimal, safe HTML escaping — this text is never trusted as markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text -> paragraphs, blank lines separate paragraphs, single
 *  newlines become line breaks within one. */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
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
      console.error("[admin-upload-guide] ADMIN_EMAIL secret is not set.");
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
      await logSecurityEvent(adminClient, { event_type: "admin_upload_guide", actor_email: userData.user.email, success: false, detail: { reason: "not_admin" }, req });
      return jsonResponse(req, { error: "Forbidden — admin access required" }, 403);
    }

    // ── 3. Parse multipart form data ─────────────────────
    const form = await req.formData();
    const semesterRaw  = form.get("semester");
    const moduleName   = (form.get("module_name") || "").toString().trim();
    const contentText  = (form.get("content_text") || "").toString();
    // Note: `guides` has no title column (module_name + semester is the
    // key) — a "title" field from the client, if sent, is ignored here.

    const semester = parseInt(semesterRaw?.toString() || "", 10);
    if (semester !== 1 && semester !== 2) {
      return jsonResponse(req, { error: "semester must be 1 or 2" }, 400);
    }
    if (!moduleName) {
      return jsonResponse(req, { error: "module_name is required" }, 400);
    }

    // Collect every image_N field, preserving submission order.
    const imageFiles: File[] = [];
    for (const [key, value] of form.entries()) {
      if (key.startsWith("image_") && value instanceof File && value.size > 0) {
        imageFiles.push(value);
      }
    }

    if (!contentText.trim() && imageFiles.length === 0) {
      return jsonResponse(req, { error: "Provide guide text, at least one image, or both" }, 400);
    }
    if (imageFiles.length > MAX_IMAGES) {
      return jsonResponse(req, { error: `Too many images — max ${MAX_IMAGES} per guide` }, 400);
    }

    // ── 3b. Validate every image before uploading any of them ──────
    for (const file of imageFiles) {
      if (!(file.type in MIME_EXT)) {
        return jsonResponse(req, { error: `Unsupported image type: ${file.type}` }, 400);
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return jsonResponse(req, { error: `Image "${file.name}" exceeds the 10MB limit` }, 400);
      }
      const signatureOk = await verifyFileSignature(file, file.type);
      if (!signatureOk) {
        await logSecurityEvent(adminClient, { event_type: "admin_upload_guide", actor_email: userData.user.email, success: false, detail: { reason: "signature_mismatch", file: file.name }, req });
        return jsonResponse(req, { error: `File "${file.name}" content does not match its declared image type` }, 400);
      }
    }

    // ── 4. Build the module's storage folder ──────────────────
    let moduleSlug = slugify(moduleName);
    if (!/[a-z0-9]/.test(moduleSlug)) {
      moduleSlug = await fallbackSlug(moduleName);
    }

    // ── 5. Upload images to the public guide-images bucket ─────────
    const uploadedPaths: string[] = [];
    const imageUrls: string[] = [];

    for (const file of imageFiles) {
      const ext = MIME_EXT[file.type];
      const path = `s${semester}/${moduleSlug}/${crypto.randomUUID()}${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());

      const { error: uploadErr } = await adminClient.storage
        .from("guide-images")
        .upload(path, bytes, { contentType: file.type, upsert: false });

      if (uploadErr) {
        console.error("[admin-upload-guide] image upload error:", uploadErr.message);
        // Roll back any images already uploaded in this same request.
        if (uploadedPaths.length) await adminClient.storage.from("guide-images").remove(uploadedPaths);
        await logSecurityEvent(adminClient, { event_type: "admin_upload_guide", actor_email: userData.user.email, success: false, detail: { reason: "storage_error" }, req });
        return jsonResponse(req, { error: `Image upload failed: ${uploadErr.message}` }, 500);
      }

      uploadedPaths.push(path);
      const { data: pub } = adminClient.storage.from("guide-images").getPublicUrl(path);
      imageUrls.push(pub.publicUrl);
    }

    // ── 6. Find + remove any images the PREVIOUS guide for this
    //       module/semester owned, since this upload fully replaces
    //       it (same "one guide per slot" behaviour as before) ──────
    const { data: existingGuide } = await adminClient
      .from("guides")
      .select("content_html")
      .eq("module_name", moduleName)
      .eq("semester", semester)
      .maybeSingle();

    if (existingGuide?.content_html) {
      const oldPaths = Array.from(
        existingGuide.content_html.matchAll(/\/guide-images\/([^"'\s]+)/g)
      ).map((m) => (m as RegExpMatchArray)[1]);
      if (oldPaths.length) {
        await adminClient.storage.from("guide-images").remove(oldPaths).catch(() => {});
      }
    }

    // ── 7. Build content_html: text first, images appended below ───
    const textHtml = contentText.trim() ? textToHtml(contentText) : "";
    const imagesHtml = imageUrls
      .map((url) => `<img src="${url}" alt="" style="max-width:100%;border-radius:8px;margin-top:.75rem;">`)
      .join("\n");
    const contentHtml = [textHtml, imagesHtml].filter(Boolean).join("\n");

    // ── 8. Upsert the guide row ──────────────────────────────
    const { data: row, error: dbErr } = await adminClient
      .from("guides")
      .upsert(
        { module_name: moduleName, semester, content_html: contentHtml, updated_at: new Date().toISOString() },
        { onConflict: "module_name,semester" }
      )
      .select()
      .single();

    if (dbErr) {
      console.error("[admin-upload-guide] db upsert error:", dbErr.message);
      if (uploadedPaths.length) await adminClient.storage.from("guide-images").remove(uploadedPaths);
      await logSecurityEvent(adminClient, { event_type: "admin_upload_guide", actor_email: userData.user.email, success: false, detail: { reason: "db_error" }, req });
      return jsonResponse(req, { error: `Database write failed: ${dbErr.message}` }, 500);
    }

    await logSecurityEvent(adminClient, { event_type: "admin_upload_guide", actor_email: userData.user.email, success: true, detail: { semester, moduleName, imageCount: imageUrls.length }, req });

    return jsonResponse(req, { success: true, guide: row });

  } catch (err) {
    console.error("[admin-upload-guide] unexpected error:", err);
    return jsonResponse(req, { error: "Internal server error" }, 500);
  }
});
