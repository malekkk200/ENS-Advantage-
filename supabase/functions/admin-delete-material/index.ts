// ═════════════════════════════════════════════════════════════════════
// admin-delete-material
// ───────────────────────────────────────────────────────────────────
// Companion to admin-upload-material. Accepts a JSON POST
// { material_id } and:
//   1. Verifies the caller's JWT and confirms their email matches
//      the ADMIN_EMAIL secret exactly (same boundary as the upload
//      function — see the comment there for why this is a secret
//      rather than an is_admin database flag).
//   2. Looks up the course_materials row to get its storage_path
//   3. Deletes the file from the private 'course-materials' bucket
//   4. Deletes the course_materials row
//
// Both steps use the service_role key server-side only. If the
// storage delete fails we still report an error rather than
// silently deleting just the DB row, so the two never drift apart
// (an orphaned file is recoverable; a dangling DB row pointing at
// a deleted file is not, since PDFViewer would then error for
// students instead of just not listing the material at all).
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    if (!AUTHORIZED_ADMIN_EMAIL) {
      console.error("[admin-delete-material] ADMIN_EMAIL secret is not set.");
      return jsonResponse({ error: "Admin panel is not configured." }, 500);
    }

    // ── 1. Authenticate the caller ────────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "").trim();
    if (!jwt) return jsonResponse({ error: "Missing authorization token" }, 401);

    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Invalid or expired session" }, 401);
    }

    // ── 2. Confirm this is the one authorized account ─────────────
    const callerEmail = (userData.user.email || "").toLowerCase().trim();
    if (callerEmail !== AUTHORIZED_ADMIN_EMAIL.toLowerCase()) {
      return jsonResponse({ error: "Forbidden — admin access required" }, 403);
    }

    // Service-role client for privileged reads/writes — never exposed to browser
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ── 3. Parse + validate body ─────────────────────
    let body: { material_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const materialId = (body.material_id || "").toString().trim();
    if (!materialId) {
      return jsonResponse({ error: "material_id is required" }, 400);
    }

    // ── 4. Look up the row so we know which storage object to remove ──
    const { data: material, error: fetchErr } = await adminClient
      .from("course_materials")
      .select("id, storage_path, title")
      .eq("id", materialId)
      .single();

    if (fetchErr || !material) {
      return jsonResponse({ error: "Material not found" }, 404);
    }

    // ── 5. Delete the storage object first ───────────────
    if (material.storage_path) {
      const { error: removeErr } = await adminClient.storage
        .from("course-materials")
        .remove([material.storage_path]);

      if (removeErr) {
        console.error("[admin-delete-material] storage remove error:", removeErr.message);
        return jsonResponse({ error: `Storage delete failed: ${removeErr.message}` }, 500);
      }
    }

    // ── 6. Delete the metadata row ─────────────────────
    const { error: dbErr } = await adminClient
      .from("course_materials")
      .delete()
      .eq("id", materialId);

    if (dbErr) {
      console.error("[admin-delete-material] db delete error:", dbErr.message);
      return jsonResponse({ error: `Database delete failed: ${dbErr.message}` }, 500);
    }

    return jsonResponse({ success: true, deleted_id: materialId, title: material.title });

  } catch (err) {
    console.error("[admin-delete-material] unexpected error:", err);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
