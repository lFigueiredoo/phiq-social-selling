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

async function applyPolicy(
  supabase: any,
  actionId: string,
  status: "eligible" | "ineligible" | "not_required",
  reason: string,
  commentCreatedAt: string | null,
  eligibleUntil: string | null,
  context: Record<string, unknown>,
) {
  const { data, error } = await supabase.rpc("apply_outbound_policy_result", {
    p_outbound_action_id: actionId,
    p_policy_check_status: status,
    p_policy_reason: reason,
    p_comment_created_at: commentCreatedAt,
    p_eligible_until: eligibleUntil,
    p_policy_context: context,
  });
  if (error) throw new Error(`policy_persistence_failed:${error.code}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error("outbound_action_not_found");
  return data[0];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  const expectedSecret = Deno.env.get("N8N_WORKER_SECRET") ?? "";
  const suppliedSecret = req.headers.get("x-worker-secret") ?? "";
  if (!expectedSecret || !suppliedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const actionId = typeof body?.outbound_action_id === "string" ? body.outbound_action_id : "";
  if (!actionId) return Response.json({ ok: false, error: "outbound_action_id_required" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: action, error: actionError } = await supabase
    .from("outbound_actions")
    .select("id,action_type,status,policy_check_status,target_comment_id,provider_action_id,sent_at,webhook_event_id,instagram_account_id")
    .eq("id", actionId)
    .maybeSingle();

  if (actionError) return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
  if (!action) return Response.json({ ok: false, error: "outbound_action_not_found" }, { status: 404 });

  if (action.status === "sent" || action.sent_at || action.provider_action_id) {
    return Response.json({
      ok: true,
      policy: {
        outbound_action_id: action.id,
        action_type: action.action_type,
        status: action.status,
        policy_check_status: action.policy_check_status,
        reason: "already_dispatched",
      },
    });
  }

  if (action.action_type === "public_reply") {
    try {
      const result = await applyPolicy(
        supabase,
        action.id,
        "not_required",
        "Public comment replies do not use the private-reply seven-day window.",
        null,
        null,
        { source: "local_policy", rule_version: "ig-meta-policy-v1" },
      );
      return Response.json({ ok: true, policy: result });
    } catch (e) {
      console.error(String(e));
      return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
    }
  }

  const { data: event, error: eventError } = await supabase
    .from("webhook_events")
    .select("event_type,payload,received_at")
    .eq("id", action.webhook_event_id)
    .maybeSingle();
  if (eventError || !event) return Response.json({ ok: false, error: "event_not_found" }, { status: 500 });

  if (event.event_type === "live_comments") {
    try {
      const result = await applyPolicy(
        supabase,
        action.id,
        "ineligible",
        "Instagram Live private replies are only allowed during the live broadcast; automated Live dispatch is not enabled in this version.",
        null,
        null,
        { source: "local_policy", rule_version: "ig-meta-policy-v1", event_type: event.event_type },
      );
      return Response.json({ ok: true, policy: result });
    } catch (e) {
      console.error(String(e));
      return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
    }
  }

  const accessToken = Deno.env.get("META_ACCESS_TOKEN");
  if (!accessToken) {
    return Response.json({ ok: false, error: "meta_access_token_missing" }, { status: 503 });
  }

  const apiVersion = (Deno.env.get("META_API_VERSION") || "v26.0").trim();
  const url = `https://graph.instagram.com/${encodeURIComponent(apiVersion)}/${encodeURIComponent(action.target_comment_id)}?fields=id,timestamp`;

  let metaResponse: Response;
  try {
    metaResponse = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    console.error("meta policy fetch failed", String(e));
    return Response.json({ ok: false, error: "meta_unreachable" }, { status: 502 });
  }

  let metaBody: any = null;
  try { metaBody = await metaResponse.json(); } catch {}
  if (!metaResponse.ok) {
    console.error("meta policy validation failed", metaResponse.status, metaBody?.error?.code ?? "unknown");
    return Response.json({ ok: false, error: "meta_validation_failed", meta_status: metaResponse.status }, { status: 502 });
  }

  const timestamp = typeof metaBody?.timestamp === "string" ? metaBody.timestamp : null;
  if (!timestamp) {
    return Response.json({ ok: false, error: "comment_timestamp_unavailable" }, { status: 502 });
  }

  const createdMs = Date.parse(timestamp);
  if (!Number.isFinite(createdMs)) {
    return Response.json({ ok: false, error: "invalid_comment_timestamp" }, { status: 502 });
  }

  const eligibleUntilMs = createdMs + 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const eligible = nowMs < eligibleUntilMs;
  const commentCreatedAt = new Date(createdMs).toISOString();
  const eligibleUntil = new Date(eligibleUntilMs).toISOString();
  const reason = eligible
    ? "Private reply is within Meta's seven-day window and no prior dispatch is recorded."
    : "Private reply window expired: more than seven days have elapsed since the comment was created.";

  try {
    const result = await applyPolicy(
      supabase,
      action.id,
      eligible ? "eligible" : "ineligible",
      reason,
      commentCreatedAt,
      eligibleUntil,
      {
        source: "meta_comment_lookup",
        rule_version: "ig-meta-policy-v1",
        api_version: apiVersion,
        comment_id: action.target_comment_id,
        checked_at: new Date(nowMs).toISOString(),
      },
    );
    return Response.json({ ok: true, policy: result });
  } catch (e) {
    console.error(String(e));
    return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
  }
});
