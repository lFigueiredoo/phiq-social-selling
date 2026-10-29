import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifySocialLeadContext, type ClassifierContext, type RecentInteraction } from "../_shared/socialClassifier.ts";
import { createOpenAIClassifier } from "../_shared/openaiSocialClassifier.ts";

type SnapshotItem = {
  id: string;
  external_engagement_id?: string;
  engagement_type: string;
  source: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
  webhook_payload?: Record<string, unknown>;
};

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

function eventText(item: SnapshotItem): string {
  const entries = Array.isArray(item.webhook_payload?.entry) ? item.webhook_payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const comment = changes.find((change: any) =>
      (change?.field === "comments" || change?.field === "live_comments") &&
      (!item.external_engagement_id || String(change?.value?.id ?? "") === item.external_engagement_id) &&
      typeof change?.value?.text === "string");
    if (comment) return comment.value.text.slice(0, 2000);
    const messages = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const message = messages.find((value: any) =>
      (!item.external_engagement_id || String(value?.message?.mid ?? "") === item.external_engagement_id) &&
      typeof value?.message?.text === "string");
    if (message) return message.message.text.slice(0, 2000);
  }
  return typeof item.metadata?.text === "string" ? item.metadata.text.slice(0, 2000) : "";
}

function failureCode(error: unknown): string {
  const detail = error as { message?: unknown; name?: unknown } | null;
  const message = typeof detail?.message === "string" ? detail.message : "";
  if (message === "classifier_unavailable") return message;
  if (message === "classifier_rate_limited") return message;
  if (message === "invalid_ai_output" || message === "invalid_ai_schema" ||
    message === "classifier_output_missing" || message === "classifier_incomplete") return "classifier_invalid_output";
  if (message === "TimeoutError" || detail?.name === "TimeoutError") return "classifier_timeout";
  return "classifier_provider_error";
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const respond = (value: Record<string, unknown>, status = 200) =>
    Response.json({ ...value, duration_ms: Date.now() - started }, { status });
  if (req.method !== "POST") return respond({ ok: false, result_code: "terminal_error", error_code: "method_not_allowed" }, 405);
  const secret = Deno.env.get("N8N_WORKER_SECRET");
  if (!secret) return respond({ ok: false, result_code: "retryable_error", error_code: "worker_secret_not_configured" }, 503);
  if (!equal(req.headers.get("x-worker-secret") ?? "", secret))
    return respond({ ok: false, result_code: "terminal_error", error_code: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length") ?? "0") > 16_384)
    return respond({ ok: false, result_code: "terminal_error", error_code: "input_too_large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_json");
  } catch { return respond({ ok: false, result_code: "terminal_error", error_code: "invalid_json" }, 400); }
  const input = body.engagement && typeof body.engagement === "object" && !Array.isArray(body.engagement)
    ? body.engagement : body;
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return respond({ ok: false, result_code: "retryable_error", error_code: "server_misconfigured" }, 503);
  let db: any;
  try { db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } }); }
  catch { return respond({ ok: false, result_code: "retryable_error", error_code: "server_misconfigured" }, 503); }

  const { data: prepared, error: prepareError } = await db.rpc("prepare_social_engagement_pipeline", { p_input: input });
  if (prepareError) {
    const terminal = ["22023", "23503", "23505", "P0002"].includes(prepareError.code);
    return respond({ ok: false, result_code: terminal ? "terminal_error" : "retryable_error",
      error_code: terminal ? "invalid_pipeline_input" : "phase_a_failed", retryable: !terminal }, terminal ? 400 : 503);
  }
  const base = {
    created_contact: prepared.created_contact,
    created_engagement: prepared.created_engagement,
    created_lead: prepared.created_lead,
    previous_stage: prepared.central_stage,
    previous_route: prepared.route_type,
  };
  const result = (value: Record<string, unknown>) => {
    const { context_snapshot: _snapshot, ...safe } = value;
    return respond({ ok: safe.result_code !== "retryable_error", ...base, ...safe });
  };
  if (prepared.result_code === "already_processed") return result(prepared);
  if (prepared.result_code === "lead_closed" ||
    (input as Record<string, unknown>).source === "browser_collector" &&
      (input as Record<string, unknown>).engagement_type === "like") {
    const code = prepared.result_code === "lead_closed" ? "lead_closed" : "needs_more_signal";
    const { data, error } = await db.rpc("skip_social_engagement_pipeline", {
      p_organization_id: prepared.organization_id ?? (input as Record<string, unknown>).organization_id,
      p_lead_id: prepared.lead_id, p_engagement_id: prepared.engagement_id, p_result_code: code,
    });
    if (error) return respond({ ok: false, result_code: "retryable_error", error_code: "phase_c_failed", retryable: true }, 503);
    return result(data);
  }

  const snapshot = Array.isArray(prepared.context_snapshot) ? prepared.context_snapshot as SnapshotItem[] : [];
  const recent: RecentInteraction[] = snapshot.map((item) => ({
    text: eventText(item), occurredAt: item.occurred_at, type: item.engagement_type, source: item.source,
  }));
  const context: ClassifierContext = {
    currentText: recent[0]?.text ?? "",
    mediaContext: typeof snapshot[0]?.metadata?.post_context === "string"
      ? snapshot[0].metadata.post_context.slice(0, 500) : "",
    recentInteractions: recent.slice(1), priorSummary: "",
    source: (input as Record<string, unknown>).source as ClassifierContext["source"],
    engagementCount: snapshot.length,
  };
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("SOCIAL_CLASSIFIER_MODEL") ?? "";
  const reasoningEffort = Deno.env.get("SOCIAL_CLASSIFIER_REASONING_EFFORT") ?? undefined;
  const provider = apiKey && model
    ? createOpenAIClassifier(apiKey, model, globalThis.fetch, { reasoningEffort })
    : undefined;
  let classified;
  try { classified = await classifySocialLeadContext(context, provider, { throwOnProviderFailure: true }); }
  catch (error) {
    const { data, error: markError } = await db.rpc("mark_social_engagement_pipeline_failure", {
      p_organization_id: (input as Record<string, unknown>).organization_id,
      p_lead_id: prepared.lead_id, p_engagement_id: prepared.engagement_id,
      p_error_code: failureCode(error),
    });
    if (markError) return respond({ ok: false, result_code: "retryable_error", error_code: "failure_record_failed", retryable: true }, 503);
    return result(data);
  }
  const { data: completed, error: completeError } = await db.rpc("complete_social_engagement_pipeline", {
    p_organization_id: (input as Record<string, unknown>).organization_id,
    p_lead_id: prepared.lead_id, p_engagement_id: prepared.engagement_id,
    p_classification: classified.classification,
    p_classifier_source: classified.classifierSource,
    p_prompt_version: classified.promptVersion,
  });
  if (completeError) return respond({ ok: false, result_code: "retryable_error", error_code: "phase_c_failed", retryable: true }, 503);
  return result({ ...completed, actions_performed: [
    ...(prepared.actions_performed ?? []), ...(completed.actions_performed ?? []),
  ] });
});
