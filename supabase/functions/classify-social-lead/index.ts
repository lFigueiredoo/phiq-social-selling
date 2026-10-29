import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifySocialLeadContext, type RecentInteraction } from "../_shared/socialClassifier.ts";
import { createOpenAIClassifier } from "../_shared/openaiSocialClassifier.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default) return keys.default;
    } catch { /* legacy fallback */ }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("admin_key_unavailable");
  return legacy;
}

function eventText(event: any): string {
  const entries = Array.isArray(event?.payload?.entry) ? event.payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const change = changes.find((item: any) =>
      String(item?.value?.id ?? "") === String(event.external_object_id ?? "") &&
      (item?.field === "comments" || item?.field === "live_comments"));
    if (typeof change?.value?.text === "string") return change.value.text.slice(0, 2000);
    const messages = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const message = messages.find((item: any) =>
      String(item?.message?.mid ?? "") === String(event.external_object_id ?? ""));
    if (typeof message?.message?.text === "string") return message.message.text.slice(0, 2000);
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const expected = Deno.env.get("N8N_WORKER_SECRET");
  if (!expected) return json({ ok: false, error: "worker_secret_not_configured" }, 503);
  if (!equal(req.headers.get("x-worker-secret") ?? "", expected)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const orgId = typeof body.organization_id === "string" ? body.organization_id : "";
  const leadId = typeof body.lead_id === "string" ? body.lead_id : "";
  const engagementId = typeof body.engagement_id === "string" ? body.engagement_id : "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![orgId, leadId, engagementId].every((v) => uuid.test(v))) {
    return json({ ok: false, error: "invalid_identifiers" }, 400);
  }
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return json({ ok: false, error: "server_misconfigured" }, 503);
  const db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: lead, error: leadError }, { data: target, error: targetError }] = await Promise.all([
    db.from("social_leads").select("id,organization_id,contact_id,central_stage,route_type,lead_score")
      .eq("id", leadId).eq("organization_id", orgId).maybeSingle(),
    db.from("social_engagements").select("id,organization_id,contact_id,webhook_event_id,external_engagement_id,engagement_type,source,occurred_at,metadata")
      .eq("id", engagementId).eq("organization_id", orgId).maybeSingle(),
  ]);
  if (leadError || targetError) return json({ ok: false, error: "lookup_failed" }, 500);
  if (!lead || !target || lead.contact_id !== target.contact_id) {
    return json({ ok: false, error: "lead_or_engagement_not_found" }, 404);
  }
  const { data: previous } = await db.from("social_classifications")
    .select("id,apply_result").eq("engagement_id", engagementId).eq("organization_id", orgId).maybeSingle();
  if (previous) return json({ ok: true, already_exists: true, classification_id: previous.id, apply_result: previous.apply_result });

  const { data: engagements, error: listError } = await db.from("social_engagements")
    .select("id,webhook_event_id,external_engagement_id,engagement_type,source,occurred_at,metadata")
    .eq("contact_id", lead.contact_id).eq("organization_id", orgId)
    .order("occurred_at", { ascending: false }).limit(12);
  if (listError) return json({ ok: false, error: "context_lookup_failed" }, 500);
  const selected = [target, ...(engagements ?? []).filter((item: any) => item.id !== target.id)].slice(0, 9);
  const eventIds = selected.map((item: any) => item.webhook_event_id).filter(Boolean);
  const { data: events, error: eventError } = eventIds.length
    ? await db.from("webhook_events").select("id,external_object_id,payload")
      .eq("organization_id", orgId).in("id", eventIds)
    : { data: [], error: null };
  if (eventError) return json({ ok: false, error: "event_lookup_failed" }, 500);
  const byId = new Map((events ?? []).map((event: any) => [event.id, event]));
  const recent: RecentInteraction[] = selected.map((item: any) => ({
    text: item.webhook_event_id ? eventText(byId.get(item.webhook_event_id))
      : typeof item.metadata?.text === "string" ? item.metadata.text.slice(0, 2000) : "",
    occurredAt: item.occurred_at,
    type: item.engagement_type,
    source: item.source,
  }));
  const currentText = recent[0]?.text ?? "";
  const mediaContext = typeof target.metadata?.post_context === "string"
    ? target.metadata.post_context.slice(0, 500) : "";
  const { data: analyses } = eventIds.length
    ? await db.from("comment_analyses").select("analysis_summary,created_at")
      .eq("organization_id", orgId).in("webhook_event_id", eventIds)
      .order("created_at", { ascending: false }).limit(1)
    : { data: [] };
  const context = {
    currentText,
    mediaContext,
    recentInteractions: recent.slice(1),
    priorSummary: typeof analyses?.[0]?.analysis_summary === "string" ? analyses[0].analysis_summary : "",
    source: target.source,
    engagementCount: engagements?.length ?? 1,
  };
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("SOCIAL_CLASSIFIER_MODEL") ?? "";
  const reasoningEffort = Deno.env.get("SOCIAL_CLASSIFIER_REASONING_EFFORT") ?? undefined;
  const provider = key && model
    ? createOpenAIClassifier(key, model, globalThis.fetch, { reasoningEffort })
    : undefined;
  const result = await classifySocialLeadContext(context, provider);
  const { data: saved, error: saveError } = await db.rpc("save_social_classification", {
    p_organization_id: orgId,
    p_lead_id: leadId,
    p_engagement_id: engagementId,
    p_classification: result.classification,
    p_classifier_source: result.classifierSource,
    p_prompt_version: result.promptVersion,
  });
  if (saveError) {
    console.error("social classification persistence failed", saveError.code);
    return json({ ok: false, error: "classification_save_failed" }, 500);
  }
  return json({ ok: true, ...saved, classifier_source: result.classifierSource,
    prompt_version: result.promptVersion, classification: result.classification });
});
