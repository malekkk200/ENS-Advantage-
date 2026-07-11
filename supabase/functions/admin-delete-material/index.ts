// ═════════════════════════════════════════════════════════════════════
// admin-delete-material — see admin-upload-material for the auth model.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, getAdminEmail, logSecurityEvent } from "../_shared/security.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;

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
      console.error("[admin-delete-material] ADMIN_EMAIL secret is not set.");
      return jsonResponse(req, { error: "Admin panel is not configured." }, 500);
    }

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

    const callerEmail = (userData.user.email || "").toLowerCase().trim();
    if (callerEmail !== AUTHORIZED_ADMIN_EMAIL) {
      await logSecurityEvent(adminClient, { event_type: "admin_delete_material", actor_email: userData.user.email, success: false, detail: { reason: "not_admin" }, req });
      return jsonResponse(req, { error: "Forbidden — admin access required" }, 403);
    }

    let body: { material_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse(req, { error: "Invalid JSON body" }, 400);
    }
    const materialId = (body.material_id || "").toString().trim();
    if (!materialId) {
      return jsonResponse(req, { error: "material_id is required" }, 400);
    }

    const { data: material, error: fetchErr } = await adminClient
      .from("course_materials")
      .select("id, storage_path, title")
      .eq("id", materialId)
      .single();

    if (fetchErr || !material) {
      return jsonResponse(req, { error: "Material not found" }, 404);
    }

    if (material.storage_path) {
      const { error: removeErr } = await adminClient.storage
        .from("course-materials")
        .remove([material.storage_path]);

      if (removeErr) {
        console.error("[admin-delete-material] storage remove error:", removeErr.message);
        await logSecurityEvent(adminClient, { event_type: "admin_delete_material", actor_email: userData.user.email, success: false, detail: { reason: "storage_error", materialId }, req });
        return jsonResponse(req, { error: `Storage delete failed: ${removeErr.message}` }, 500);
      }
    }

    const { error: dbErr } = await adminClient
      .from("course_materials")
      .delete()
      .eq("id", materialId);

    if (dbErr) {
      console.error("[admin-delete-material] db delete error:", dbErr.message);
      await logSecurityEvent(adminClient, { event_type: "admin_delete_material", actor_email: userData.user.email, success: false, detail: { reason: "db_error", materialId }, req });
      return jsonResponse(req, { error: `Database delete failed: ${dbErr.message}` }, 500);
    }

    await logSecurityEvent(adminClient, { event_type: "admin_delete_material", actor_email: userData.user.email, success: true, detail: { materialId, title: material.title }, req });
    return jsonResponse(req, { success: true, deleted_id: materialId, title: material.title });

  } catch (err) {
    console.error("[admin-delete-material] unexpected error:", err);
    return jsonResponse(req, { error: "Internal server error" }, 500);
  }
});
