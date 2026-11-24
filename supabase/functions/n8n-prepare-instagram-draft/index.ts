import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildResponseDraftRequest } from "../_shared/responseDraft.ts";
import { checkOutboundPolicy } from "../_shared/outboundPolicy.ts";

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default) return keys.default;
    } catch {
      // Use the legacy key below when the modern secret bundle is unavailable.
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("admin_key_unavailable");
  return legacy;
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function engagementText(
  payload: Record<string, unknown>,
  eventType: string,
  externalId: string,
): string {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (eventType === "messages") {
      const messages = Array.isArray(entry?.messaging) ? entry.messaging : [];
      const message = messages.find((item: any) =>
        String(item?.message?.mid ?? "") === externalId &&
        typeof item?.message?.text === "string"
      );
      if (message) return message.message.text.trim().slice(0, 2000);
    }
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const change = changes.find((item: any) =>
      (item?.field === "comments" || item?.field === "live_comments") &&
      String(item?.value?.id ?? "") === externalId &&
      typeof item?.value?.text === "string"
    );
    if (change) return change.value.text.trim().slice(0, 2000);
  }
  return "";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expected = Deno.env.get("N8N_WORKER_SECRET") ?? "";
  const supplied = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !supplied || !equal(expected, supplied)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (Number(req.headers.get("content-length") ?? "0") > 4_096) {
    return json({ ok: false, error: "input_too_large" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const workerId = typeof body.worker_id === "string" ? body.worker_id.trim() : "";
  if (!jobId || !workerId) return json({ ok: false, error: "invalid_request" }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return json({ ok: false, error: "server_misconfigured" }, 503);

  let db: any;
  try {
    db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  } catch {
    return json({ ok: false, error: "server_misconfigured" }, 503);
  }

  const { data: job, error: jobError } = await db
    .from("processing_jobs")
    .select("id,organization_id,webhook_event_id,status,locked_by")
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("locked_by", workerId)
    .maybeSingle();
  if (jobError) return json({ ok: false, error: "persistence_error" }, 500);
  if (!job) return json({ ok: false, error: "job_not_claimed_by_worker" }, 409);

  const { data: existing, error: existingError } = await db
    .from("outbound_actions")
    .select("id,status,action_type,policy_check_status")
    .eq("processing_job_id", job.id)
    .limit(1)
    .maybeSingle();
  if (existingError) return json({ ok: false, error: "persistence_error" }, 500);
  if (existing) {
    if (
      existing.action_type === "private_reply" &&
      existing.status === "proposed" &&
      existing.policy_check_status === "not_checked"
    ) {
      const policy = await checkOutboundPolicy(url, expected, existing.id);
      if (!policy.ok) {
        return json({ ok: false, error: policy.error ?? "policy_check_failed" }, 502);
      }
      return json({
        ok: true,
        draft_required: false,
        reason: "draft_policy_reconciled",
        policy: policy.policy ?? null,
      });
    }
    return json({ ok: true, draft_required: false, reason: "draft_already_exists" });
  }

  const { data: existingConversationDraft, error: existingConversationDraftError } = await db
    .from("instagram_conversation_messages")
    .select("id,status,conversation_id")
    .eq("source_processing_job_id", job.id)
    .limit(1)
    .maybeSingle();
  if (existingConversationDraftError) {
    return json({ ok: false, error: "persistence_error" }, 500);
  }
  if (existingConversationDraft) {
    return json({
      ok: true,
      draft_required: false,
      reason: "conversation_draft_already_exists",
      conversation_message_id: existingConversationDraft.id,
    });
  }

  const { data: event, error: eventError } = await db
    .from("webhook_events")
    .select("id,event_type,external_object_id,payload")
    .eq("id", job.webhook_event_id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (eventError || !event) return json({ ok: false, error: "event_not_found" }, 404);
  if (!["comments", "live_comments", "messages"].includes(event.event_type)) {
    return json({ ok: true, draft_required: false, reason: "unsupported_event_type" });
  }

  const { data: engagement, error: engagementError } = await db
    .from("social_engagements")
    .select("id,source,engagement_type,classification_status")
    .eq("webhook_event_id", event.id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (engagementError) return json({ ok: false, error: "persistence_error" }, 500);
  if (!engagement || engagement.classification_status !== "completed") {
    return json({ ok: true, draft_required: false, reason: "classification_not_completed" });
  }

  const { data: classified, error: classificationError } = await db
    .from("social_classifications")
    .select("classification")
    .eq("engagement_id", engagement.id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (classificationError) return json({ ok: false, error: "persistence_error" }, 500);
  if (!classified?.classification) {
    return json({ ok: true, draft_required: false, reason: "classification_missing" });
  }

  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const text = engagementText(
    payload,
    event.event_type,
    String(event.external_object_id ?? ""),
  );
  if (!text) return json({ ok: true, draft_required: false, reason: "engagement_text_missing" });

  const source = payload.source === "historical_backfill" || engagement.source === "historical_backfill"
    ? "historical_backfill"
    : "realtime";
  let offers: Array<Record<string, unknown>> = [];
  let conversationHistory: Array<Record<string, unknown>> = [];
  if (event.event_type === "messages") {
    const { data: inbound, error: inboundError } = await db
      .from("instagram_conversation_messages")
      .select("conversation_id")
      .eq("webhook_event_id", event.id)
      .eq("direction", "inbound")
      .maybeSingle();
    if (inboundError || !inbound) {
      return json({ ok: false, error: "conversation_not_found" }, 404);
    }
    const { data: conversation, error: conversationError } = await db
      .from("instagram_conversations")
      .select("lead_id,status,opted_out,reply_window_until")
      .eq("id", inbound.conversation_id)
      .eq("organization_id", job.organization_id)
      .maybeSingle();
    if (conversationError || !conversation) {
      return json({ ok: false, error: "conversation_not_found" }, 404);
    }
    const { data: historyRows, error: historyError } = await db
      .from("instagram_conversation_messages")
      .select("direction,message_text,created_at")
      .eq("conversation_id", inbound.conversation_id)
      .eq("organization_id", job.organization_id)
      .order("created_at", { ascending: false })
      .limit(12);
    if (historyError) return json({ ok: false, error: "conversation_history_lookup_failed" }, 500);
    conversationHistory = Array.isArray(historyRows) ? historyRows.reverse() : [];
    const windowSafe = conversation.reply_window_until &&
      Date.parse(conversation.reply_window_until) > Date.now() + 10 * 60 * 1000;
    if (conversation.opted_out || conversation.status === "blocked" || !windowSafe) {
      return json({ ok: true, draft_required: false, reason: "conversation_not_replyable" });
    }
    const { data: settings } = await db
      .from("social_selling_settings")
      .select("auto_suggest_enabled")
      .eq("organization_id", job.organization_id)
      .maybeSingle();
    if (settings?.auto_suggest_enabled === false) {
      return json({ ok: true, draft_required: false, reason: "conversation_suggestions_disabled" });
    }
    let routeType: string | null = null;
    if (conversation.lead_id) {
      const { data: lead } = await db
        .from("social_leads")
        .select("route_type")
        .eq("id", conversation.lead_id)
        .maybeSingle();
      routeType = lead?.route_type ?? null;
    }
    let offerQuery = db
      .from("social_catalog_offers")
      .select("name,offer_kind,route_type,summary,audience,price_text,approved_claims,prohibited_claims")
      .eq("organization_id", job.organization_id)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .limit(8);
    if (routeType && routeType !== "no_profile") {
      offerQuery = offerQuery.or(`route_type.is.null,route_type.eq.${routeType}`);
    }
    const { data: offerRows, error: offersError } = await offerQuery;
    if (offersError) return json({ ok: false, error: "catalog_lookup_failed" }, 500);
    offers = Array.isArray(offerRows) ? offerRows : [];
  }

  return json({
    ok: true,
    draft_required: true,
    draft_request: buildResponseDraftRequest({
      commentText: text,
      source,
      eventType: event.event_type,
      classification: classified.classification,
      offers,
      conversationHistory,
    }),
  });
});
