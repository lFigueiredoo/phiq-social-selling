import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function getAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default.length > 0) return keys.default;
    } catch {}
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase admin key unavailable");
  return legacy;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const expectedSecret = Deno.env.get("N8N_WORKER_SECRET");
  const suppliedSecret = req.headers.get("x-worker-secret") ?? "";
  if (!expectedSecret || !suppliedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let queue = "proposed";
  try {
    const raw = await req.text();
    if (raw.trim()) {
      const body = JSON.parse(raw);
      if (body?.queue === "approved") queue = "approved";
      else if (body?.queue === "proposed" || body?.queue == null) queue = "proposed";
      else return Response.json({ ok: false, error: "invalid_queue" }, { status: 400 });
    }
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowIso = new Date().toISOString();

  let query = supabase
    .from("outbound_actions")
    .select("id, organization_id, analysis_id, webhook_event_id, action_type, status, policy_check_status, target_comment_id, target_user_id, target_username, message_text, eligible_until, created_at, approved_at, approved_by, sent_at")
    .eq("status", queue)
    .or(
      "and(action_type.eq.private_reply,policy_check_status.eq.eligible)," +
        "and(action_type.eq.public_reply,policy_check_status.in.(not_required,eligible))",
    )
    .is("sent_at", null)
    .or(`eligible_until.is.null,eligible_until.gt.${nowIso}`)
    .order(queue === "approved" ? "approved_at" : "created_at", { ascending: true, nullsFirst: false })
    .limit(1);

  const { data: action, error: actionError } = await query.maybeSingle();

  if (actionError) {
    console.error("outbound action lookup failed", actionError.code);
    return Response.json({ ok: false, error: "queue_lookup_error" }, { status: 500 });
  }

  if (!action) {
    return Response.json({ ok: true, queue, action: null });
  }

  const [{ data: analysis, error: analysisError }, { data: event, error: eventError }] = await Promise.all([
    supabase
      .from("comment_analyses")
      .select("sentiment, intent, commercial_potential, lead_score, requires_human_review, recommended_action, suggested_reply, analysis_summary")
      .eq("id", action.analysis_id)
      .maybeSingle(),
    supabase
      .from("webhook_events")
      .select("payload, external_object_id, received_at")
      .eq("id", action.webhook_event_id)
      .maybeSingle(),
  ]);

  if (analysisError || eventError) {
    console.error("queue context lookup failed", analysisError?.code ?? eventError?.code);
    return Response.json({ ok: false, error: "queue_context_error" }, { status: 500 });
  }

  const commentText = event?.payload?.entry?.[0]?.changes?.[0]?.value?.text ?? null;

  return Response.json({
    ok: true,
    queue,
    action: {
      outbound_action_id: action.id,
      action_type: action.action_type,
      status: action.status,
      policy_check_status: action.policy_check_status,
      target_comment_id: action.target_comment_id,
      target_user_id: action.target_user_id,
      target_username: action.target_username,
      comment_text: commentText,
      message_text: action.message_text,
      eligible_until: action.eligible_until,
      created_at: action.created_at,
      approved_at: action.approved_at,
      approved_by: action.approved_by,
      analysis: analysis ?? null,
    },
  });
});
