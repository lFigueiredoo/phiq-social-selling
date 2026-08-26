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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = typeof body?.action === "string" ? body.action : "";
  const jobId = typeof body?.job_id === "string" ? body.job_id : "";
  const workerId = typeof body?.worker_id === "string" ? body.worker_id : "";
  if (!jobId || !workerId || (action !== "complete" && action !== "fail")) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });

  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (action === "complete") {
    const { data, error } = await supabase.rpc("complete_processing_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
    });
    if (error) {
      console.error("complete_processing_job failed", error.code);
      return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
    }
    if (!Array.isArray(data) || data.length === 0) {
      return Response.json({ ok: false, error: "job_not_claimed_by_worker" }, { status: 409 });
    }
    return Response.json({ ok: true, result: data[0] });
  }

  const errorMessage = typeof body?.error === "string" ? body.error.trim() : "";
  const retryAfterSeconds = Number.isInteger(body?.retry_after_seconds) ? body.retry_after_seconds : 60;
  if (!errorMessage || retryAfterSeconds < 0) {
    return Response.json({ ok: false, error: "invalid_fail_payload" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("fail_processing_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_error: errorMessage,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (error) {
    console.error("fail_processing_job failed", error.code);
    return Response.json({ ok: false, error: "persistence_error" }, { status: 500 });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return Response.json({ ok: false, error: "job_not_claimed_by_worker" }, { status: 409 });
  }
  return Response.json({ ok: true, result: data[0] });
});
