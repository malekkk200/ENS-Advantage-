import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://ens-advantage.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // 1. Verify caller identity from JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized." }, 401);

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_ANON_KEY"),
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) return json({ error: "Unauthorized." }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    // 2. Rate limit: max 3 requests per user per 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("subscription_requests")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .gte("created_at", since);

    if ((count ?? 0) >= 3) {
      return json({ error: "Too many requests. You can only submit 3 payment requests per day. Please wait 24 hours." }, 429);
    }

    // 3. Parse and validate body
    let body;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid request body." }, 400); }

    const VALID_PLANS = ["S1", "S2", "BOTH"];
    const plan = String(body.plan ?? "").trim();
    if (!VALID_PLANS.includes(plan)) {
      return json({ error: "Invalid plan selected." }, 400);
    }

    const transaction_ref = String(body.transaction_ref ?? "").trim().slice(0, 100);
    if (!transaction_ref) {
      return json({ error: "Transaction reference is required." }, 400);
    }

    const full_name = String(body.full_name ?? "").trim().slice(0, 200);

    // 3.5. Enforce access rules: once a semester is approved, that
    // semester can't be bought again, and "BOTH" becomes unavailable —
    // only the remaining (not-yet-approved) semester can still be
    // purchased. This is re-derived here from user_profiles (the same
    // source of truth the admin edits when approving a request) rather
    // than trusted from the client.
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("user_profiles")
      .select("has_s1_access, has_s2_access")
      .eq("id", user.id)
      .single();

    if (profileErr || !profile) {
      return json({ error: "Could not verify your account access. Please try again." }, 500);
    }

    const { has_s1_access, has_s2_access } = profile;

    if (has_s1_access && has_s2_access) {
      return json({ error: "You already have access to both semesters." }, 409);
    }
    if (plan === "S1" && has_s1_access) {
      return json({ error: "You already have access to Semester 1." }, 409);
    }
    if (plan === "S2" && has_s2_access) {
      return json({ error: "You already have access to Semester 2." }, 409);
    }
    if (plan === "BOTH" && (has_s1_access || has_s2_access)) {
      const remaining = has_s1_access ? "Semester 2" : "Semester 1";
      return json({ error: `You already have access to one semester — you can only subscribe to ${remaining} now.` }, 409);
    }

    // 4. Pricing + new-student 40% discount — determined server-side only.
    //    The client never gets to say "I get the discount"; eligibility is
    //    recomputed here from the source of truth (has this user_id ever
    //    had an APPROVED subscription_requests row?). Rejected/pending
    //    requests do not disqualify — only a past approved subscription does.
    const BASE_PRICES_DZD: Record<string, number> = { S1: 2000, S2: 2000, BOTH: 3500 };
    const DISCOUNT_RATE = 0.4;

    const { count: approvedCount } = await supabaseAdmin
      .from("subscription_requests")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "approved");

    const isDiscountEligible = (approvedCount ?? 0) === 0;
    const basePrice = BASE_PRICES_DZD[plan];
    const amount_dzd = isDiscountEligible
      ? Math.round(basePrice * (1 - DISCOUNT_RATE))
      : basePrice;

    // 5. Duplicate transaction reference detection
    const { data: dup } = await supabaseAdmin
      .from("subscription_requests")
      .select("id")
      .eq("transaction_ref", transaction_ref)
      .maybeSingle();

    if (dup) {
      return json({ error: "This transaction reference has already been submitted. Contact support if this is an error." }, 409);
    }

    // 6. Insert — identity comes from JWT, not the request body
    const { error: insertError } = await supabaseAdmin
      .from("subscription_requests")
      .insert({
        user_id: user.id,
        user_email: user.email,
        full_name,
        plan,
        transaction_ref,
        is_discounted: isDiscountEligible,
        amount_dzd,
      });

    if (insertError) {
      console.error("insert error:", insertError);
      return json({ error: "Failed to submit request. Please try again." }, 500);
    }

    return json({ success: true, is_discounted: isDiscountEligible, amount_dzd });

  } catch (err) {
    console.error("unhandled error:", err);
    return json({ error: "An unexpected server error occurred." }, 500);
  }
});
