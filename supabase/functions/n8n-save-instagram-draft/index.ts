import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  RESPONSE_DRAFT_MODEL,
  RESPONSE_DRAFT_PROMPT_VERSION,
  validateResponseDraftOutput,
} from "../_shared/responseDraft.ts";
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
  if (Number(req.headers.get("content-length") ?? "0") > 16_384) {
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

  let draft;
  try {
    draft = validateResponseDraftOutput(body.draft);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_draft_output";
    return json({ ok: false, error: code }, 400);
  }

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
  const { data: event, error: eventError } = await db
    .from("webhook_events")
    .select("event_type")
    .eq("id", job.webhook_event_id)
    .eq("organization_id", job.organization_id)
    .maybeSingle();
  if (eventError || !event) return json({ ok: false, error: "event_not_found" }, 404);

  if (event.event_type === "messages") {
    const { data, error } = await db.rpc("save_instagram_conversation_draft", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_message_text: draft.message_text,
      p_analysis_summary: draft.analysis_summary,
      p_model_name: RESPONSE_DRAFT_MODEL,
      p_prompt_version: RESPONSE_DRAFT_PROMPT_VERSION,
    });
    if (error) {
      console.error("save_instagram_conversation_draft failed", error.code);
      const invalid = error.code === "22023";
      return json({ ok: false, error: invalid ? "invalid_draft" : "persistence_error" }, invalid ? 400 : 500);
    }
    if (!Array.isArray(data) || data.length === 0) {
      return json({ ok: false, error: "job_not_claimed_by_worker" }, 409);
    }
    return json({ ok: true, draft: data[0], policy: null });
  }

  const { data, error } = await db.rpc("save_instagram_response_draft", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_message_text: draft.message_text,
    p_sentiment: draft.sentiment,
    p_analysis_summary: draft.analysis_summary,
    p_model_name: RESPONSE_DRAFT_MODEL,
    p_prompt_version: RESPONSE_DRAFT_PROMPT_VERSION,
  });
  if (error) {
    console.error("save_instagram_response_draft failed", error.code);
    const invalid = error.code === "22023";
    return json({ ok: false, error: invalid ? "invalid_draft" : "persistence_error" }, invalid ? 400 : 500);
  }
  if (!Array.isArray(data) || data.length === 0) {
    return json({ ok: false, error: "job_not_claimed_by_worker" }, 409);
  }

  let policy: Record<string, unknown> | null = null;
  if (
    data[0].action_type === "private_reply" &&
    data[0].outbound_status === "proposed"
  ) {
    const checked = await checkOutboundPolicy(url, expected, data[0].outbound_action_id);
    if (!checked.ok) {
      return json({ ok: false, error: checked.error ?? "policy_check_failed" }, 502);
    }
    policy = checked.policy ?? null;
  }

  return json({ ok: true, draft: data[0], policy });
});
