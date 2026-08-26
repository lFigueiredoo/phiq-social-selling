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

const sentiments = new Set(["positive", "neutral", "negative", "mixed", "unknown"]);
const intents = new Set([
  "engagement", "question", "purchase_interest", "product_interest", "support",
  "complaint", "partnership", "spam", "other",
]);
const potentials = new Set(["low", "medium", "high", "unknown"]);
const actions = new Set(["none", "public_reply", "private_reply_candidate", "human_review"]);

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const jobId = typeof body?.job_id === "string" ? body.job_id : "";
  const workerId = typeof body?.worker_id === "string" ? body.worker_id.trim() : "";
  const analysis = body?.analysis;

  if (!jobId || !workerId || !analysis || typeof analysis !== "object") {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const sentiment = analysis.sentiment;
  const intent = analysis.intent;
  const commercialPotential = analysis.commercial_potential;
  const leadScore = analysis.lead_score;
  const requiresHumanReview = analysis.requires_human_review;
  const recommendedAction = analysis.recommended_action;
  const modelName = analysis.model_name;
  const promptVersion = analysis.prompt_version;

  if (
    typeof sentiment !== "string" || !sentiments.has(sentiment) ||
    typeof intent !== "string" || !intents.has(intent) ||
    typeof commercialPotential !== "string" || !potentials.has(commercialPotential) ||
    !Number.isInteger(leadScore) || leadScore < 0 || leadScore > 100 ||
    typeof requiresHumanReview !== "boolean" ||
    typeof recommendedAction !== "string" || !actions.has(recommendedAction) ||
    typeof modelName !== "string" || !modelName.trim() ||
    typeof promptVersion !== "string" || !promptVersion.trim()
  ) {
    return Response.json({ ok: false, error: "invalid_analysis" }, { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });

  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc("save_comment_analysis", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_sentiment: sentiment,
    p_intent: intent,
    p_commercial_potential: commercialPotential,
    p_lead_score: leadScore,
    p_requires_human_review: requiresHumanReview,
    p_recommended_action: recommendedAction,
    p_suggested_reply: optionalString(analysis.suggested_reply),
    p_analysis_summary: optionalString(analysis.analysis_summary),
    p_model_name: modelName.trim(),
    p_prompt_version: promptVersion.trim(),
    p_provider_response_id: optionalString(analysis.provider_response_id),
  });

  if (error) {
    console.error("save_comment_analysis failed", error.code);
    return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
  }

  if (!Array.isArray(data) || data.length === 0) {
    return Response.json({ ok: false, error: "job_not_claimed_by_worker" }, { status: 409 });
  }

  return Response.json({ ok: true, analysis: data[0] });
});
