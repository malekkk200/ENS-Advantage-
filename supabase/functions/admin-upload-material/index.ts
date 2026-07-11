// ═════════════════════════════════════════════════════════════════════
// admin-upload-material
// ───────────────────────────────────────────────────────────────────
// One-shot "no-code" upload endpoint for the ENS Advantage admin
// panel. Accepts a multipart/form-data POST containing the PDF
// file plus its metadata, then:
//   1. Verifies the caller's JWT and confirms their email matches
//      the ADMIN_EMAIL secret exactly (checked against the JWT's
//      own verified identity — not anything sent in the request
//      body, so it cannot be spoofed by a client-modified payload).
//      This is intentionally a single admin account gated by a
//      Supabase secret rather than an `is_admin` database flag: the
//      admin panel is meant for exactly one account, and a flag on a
//      table is one accidental UPDATE away from granting access to
//      someone else. The email lives only in the ADMIN_EMAIL secret
//      (Project Settings → Edge Functions → Secrets) — never in
//      source — since this repo is public on GitHub.
//   2. Builds the canonical storage path from semester/category/module
//   3. Verifies the uploaded bytes are actually a PDF (magic-byte
//      check) — the client-supplied Content-Type can be spoofed.
//   4. Uploads the raw file bytes to the private 'course-materials'
//      bucket using the service role (client-side uploads are
//      blocked by storage RLS — this function is the only writer)
//   5. Upserts the matching row in course_materials, and writes a
//      security_logs audit entry for the action.
//
// Both writes happen with the service_role key, which is only ever
// used INSIDE this server-side function — it is never exposed to
// the browser.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, getAdminEmail, logSecurityEvent, verifyFileSignature } from "../_shared/security.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

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

const CATEGORY_LABELS: Record<string, string> = {
  summary:     "Summary",
  full_lesson: "Full Lesson",
  guide:       "Comprehensive Guide",
};

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
      console.error("[admin-upload-material] ADMIN_EMAIL secret is not set.");
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
      await logSecurityEvent(adminClient, { event_type: "admin_upload_material", actor_email: userData.user.email, success: false, detail: { reason: "not_admin" }, req });
      return jsonResponse(req, { error: "Forbidden — admin access required" }, 403);
    }

    // ── 3. Parse multipart form data ─────────────────────
    const form = await req.formData();
    const file        = form.get("file");
    const semesterRaw = form.get("semester");
    const moduleName  = (form.get("module_name") || "").toString().trim();
    const category    = (form.get("category") || "").toString().trim();
    const titleInput  = (form.get("title") || "").toString().trim();

    if (!(file instanceof File)) {
      return jsonResponse(req, { error: "No file provided" }, 400);
    }
    const semester = parseInt(semesterRaw?.toString() || "", 10);
    if (semester !== 1 && semester !== 2) {
      return jsonResponse(req, { error: "semester must be 1 or 2" }, 400);
    }
    if (!moduleName) {
      return jsonResponse(req, { error: "module_name is required" }, 400);
    }
    if (!["summary", "full_lesson", "guide"].includes(category)) {
      return jsonResponse(req, { error: "category must be summary, full_lesson, or guide" }, 400);
    }
    if (file.type !== "application/pdf") {
      return jsonResponse(req, { error: "Only application/pdf files are accepted" }, 400);
    }
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB — matches bucket limit
    if (file.size > MAX_BYTES) {
      return jsonResponse(req, { error: "File exceeds 50MB limit" }, 400);
    }
    if (file.size === 0) {
      return jsonResponse(req, { error: "File is empty" }, 400);
    }

    // ── 3b. Magic-byte check — Content-Type header can be spoofed ──
    const signatureOk = await verifyFileSignature(file, "application/pdf");
    if (!signatureOk) {
      await logSecurityEvent(adminClient, { event_type: "admin_upload_material", actor_email: userData.user.email, success: false, detail: { reason: "signature_mismatch" }, req });
      return jsonResponse(req, { error: "File content does not match a valid PDF" }, 400);
    }

    // ── 4. Build the canonical storage path ──────────────────
    const moduleSlug = slugify(moduleName);
    if (!moduleSlug) {
      return jsonResponse(req, { error: "Could not derive a valid path from module_name" }, 400);
    }

    let storagePath: string;
    if (category === "summary") {
      storagePath = `summaries/s${semester}/${moduleSlug}.pdf`;
    } else {
      const fileName = category === "full_lesson" ? "lesson.pdf" : "guide.pdf";
      storagePath = `premium/s${semester}/${moduleSlug}/${fileName}`;
    }

    const title = titleInput || `${CATEGORY_LABELS[category]} — ${moduleName}`;

    // ── 5. Upload to the private bucket (overwrite if it exists) ──
    const fileBytes = new Uint8Array(await file.arrayBuffer());

    const { error: uploadErr } = await adminClient.storage
      .from("course-materials")
      .upload(storagePath, fileBytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadErr) {
      console.error("[admin-upload-material] storage upload error:", uploadErr.message);
      await logSecurityEvent(adminClient, { event_type: "admin_upload_material", actor_email: userData.user.email, success: false, detail: { reason: "storage_error" }, req });
      return jsonResponse(req, { error: `Storage upload failed: ${uploadErr.message}` }, 500);
    }

    // ── 6. Upsert the metadata row ─────────────────────
    const { data: row, error: dbErr } = await adminClient
      .from("course_materials")
      .upsert(
        { semester, module_name: moduleName, category, title, storage_path: storagePath },
        { onConflict: "semester,module_name,category" }
      )
      .select()
      .single();

    if (dbErr) {
      console.error("[admin-upload-material] db upsert error:", dbErr.message);
      await adminClient.storage.from("course-materials").remove([storagePath]);
      await logSecurityEvent(adminClient, { event_type: "admin_upload_material", actor_email: userData.user.email, success: false, detail: { reason: "db_error" }, req });
      return jsonResponse(req, { error: `Database write failed: ${dbErr.message}` }, 500);
    }

    await logSecurityEvent(adminClient, { event_type: "admin_upload_material", actor_email: userData.user.email, success: true, detail: { semester, category, storagePath }, req });

    return jsonResponse(req, {
      success: true,
      material: row,
      storage_path: storagePath,
    });

  } catch (err) {
    console.error("[admin-upload-material] unexpected error:", err);
    return jsonResponse(req, { error: "Internal server error" }, 500);
  }
});
