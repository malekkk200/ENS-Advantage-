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
//   3. Uploads the raw file bytes to the private 'course-materials'
//      bucket using the service role (client-side uploads are
//      blocked by storage RLS — this function is the only writer)
//   4. Upserts the matching row in course_materials
//
// Both writes happen with the service_role key, which is only ever
// used INSIDE this server-side function — it is never exposed to
// the browser.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY               = Deno.env.get("SUPABASE_ANON_KEY")!;

// The ONE account allowed to use the admin upload/delete panel.
// Stored as a secret, not hardcoded — this repo is public.
const AUTHORIZED_ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Build a clean, predictable storage path from the slug + metadata
function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")       // strip accents
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
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    if (!AUTHORIZED_ADMIN_EMAIL) {
      console.error("[admin-upload-material] ADMIN_EMAIL secret is not set.");
      return jsonResponse({ error: "Admin panel is not configured." }, 500);
    }

    // ── 1. Authenticate the caller ────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) return jsonResponse({ error: "Missing authorization token" }, 401);

    // Use the anon client only to resolve the JWT → user identity
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Invalid or expired session" }, 401);
    }

    // ── 2. Confirm this is the one authorized account ─────────────
    // Checked against the JWT-verified email (server-resolved, not
    // client-supplied) — this is the actual security boundary.
    const callerEmail = (userData.user.email || "").toLowerCase().trim();
    if (callerEmail !== AUTHORIZED_ADMIN_EMAIL.toLowerCase()) {
      return jsonResponse({ error: "Forbidden — admin access required" }, 403);
    }

    // Service-role client for privileged writes — never exposed to browser
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ── 3. Parse multipart form data ─────────────────────
    const form = await req.formData();
    const file        = form.get("file");
    const semesterRaw = form.get("semester");
    const moduleName  = (form.get("module_name") || "").toString().trim();
    const category    = (form.get("category") || "").toString().trim();
    const titleInput  = (form.get("title") || "").toString().trim();

    if (!(file instanceof File)) {
      return jsonResponse({ error: "No file provided" }, 400);
    }
    const semester = parseInt(semesterRaw?.toString() || "", 10);
    if (semester !== 1 && semester !== 2) {
      return jsonResponse({ error: "semester must be 1 or 2" }, 400);
    }
    if (!moduleName) {
      return jsonResponse({ error: "module_name is required" }, 400);
    }
    if (!["summary", "full_lesson", "guide"].includes(category)) {
      return jsonResponse({ error: "category must be summary, full_lesson, or guide" }, 400);
    }
    if (file.type !== "application/pdf") {
      return jsonResponse({ error: "Only application/pdf files are accepted" }, 400);
    }
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB — matches bucket limit
    if (file.size > MAX_BYTES) {
      return jsonResponse({ error: "File exceeds 50MB limit" }, 400);
    }

    // ── 4. Build the canonical storage path ──────────────────
    const moduleSlug = slugify(moduleName);
    if (!moduleSlug) {
      return jsonResponse({ error: "Could not derive a valid path from module_name" }, 400);
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
        upsert: true, // re-uploading the same module/category replaces the old file
      });

    if (uploadErr) {
      console.error("[admin-upload-material] storage upload error:", uploadErr.message);
      return jsonResponse({ error: `Storage upload failed: ${uploadErr.message}` }, 500);
    }

    // ── 6. Upsert the metadata row ─────────────────────
    const { data: row, error: dbErr } = await adminClient
      .from("course_materials")
      .upsert(
        {
          semester,
          module_name: moduleName,
          category,
          title,
          storage_path: storagePath,
        },
        { onConflict: "semester,module_name,category" }
      )
      .select()
      .single();

    if (dbErr) {
      console.error("[admin-upload-material] db upsert error:", dbErr.message);
      // Best-effort rollback of the uploaded file so we don't leave an orphan
      await adminClient.storage.from("course-materials").remove([storagePath]);
      return jsonResponse({ error: `Database write failed: ${dbErr.message}` }, 500);
    }

    return jsonResponse({
      success: true,
      material: row,
      storage_path: storagePath,
    });

  } catch (err) {
    console.error("[admin-upload-material] unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
