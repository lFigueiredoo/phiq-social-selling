import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function getAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default.length > 0) return keys.default;
    } catch {
      // Fall back below.
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase admin key unavailable");
  return legacy;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expectedSecret = Deno.env.get("N8N_WORKER_SECRET");
  if (!expectedSecret) return json({ ok: false, error: "worker_secret_not_configured" }, 503);

  const suppliedSecret = req.headers.get("x-worker-secret") ?? "";
  if (!timingSafeEqual(suppliedSecret, expectedSecret)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is allowed; defaults are applied below.
  }

  const workerIdRaw = typeof body.worker_id === "string" ? body.worker_id.trim() : "";
  const workerId = workerIdRaw || "n8n-social-selling";
  if (workerId.length > 120) return json({ ok: false, error: "invalid_worker_id" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return json({ ok: false, error: "supabase_url_unavailable" }, 503);

  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: claimed, error: claimError } = await supabase.rpc("claim_processing_job", {
    p_worker_id: workerId,
    p_job_type: "process_instagram_comment",
  });

  if (claimError) {
    console.error("claim_processing_job failed", claimError.code);
    return json({ ok: false, error: "claim_failed" }, 500);
  }

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return json({ ok: true, job: null });
  }

  const job = claimed[0];
  const { data: event, error: eventError } = await supabase
    .from("webhook_events")
    .select("id, organization_id, instagram_account_id, event_type, external_object_id, payload, received_at")
    .eq("id", job.webhook_event_id)
    .single();

  if (eventError || !event) {
    console.error("webhook event fetch failed", eventError?.code ?? "not_found");
    await supabase
      .from("processing_jobs")
      .update({
        status: "pending",
        locked_at: null,
        locked_by: null,
        available_at: new Date(Date.now() + 30_000).toISOString(),
        last_error: "claim_gateway_event_fetch_failed",
      })
      .eq("id", job.id)
      .eq("status", "processing")
      .eq("locked_by", workerId);
    return json({ ok: false, error: "event_fetch_failed" }, 500);
  }

  const payload = event.payload as any;
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  let entry: any = null;
  let change: any = null;

  for (const candidateEntry of entries) {
    const changes = Array.isArray(candidateEntry?.changes) ? candidateEntry.changes : [];
    const candidateChange = changes.find((c: any) =>
      c?.field === "comments" && String(c?.value?.id ?? "") === String(event.external_object_id ?? "")
    );
    if (candidateChange) {
      entry = candidateEntry;
      change = candidateChange;
      break;
    }
  }

  if (!change) {
    return json({
      ok: true,
      job: {
        id: job.id,
        type: job.job_type,
        status: job.status,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        locked_at: job.locked_at,
        locked_by: job.locked_by,
      },
      event: {
        id: event.id,
        type: event.event_type,
        received_at: event.received_at,
        comment_id: event.external_object_id,
        parse_status: "comment_change_not_found",
      },
    });
  }

  return json({
    ok: true,
    job: {
      id: job.id,
      type: job.job_type,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      locked_at: job.locked_at,
      locked_by: job.locked_by,
    },
    event: {
      id: event.id,
      type: event.event_type,
      received_at: event.received_at,
      instagram_user_id: entry?.id != null ? String(entry.id) : null,
      comment_id: change?.value?.id != null ? String(change.value.id) : null,
      comment_text: typeof change?.value?.text === "string" ? change.value.text : null,
      commenter: {
        id: change?.value?.from?.id != null ? String(change.value.from.id) : null,
        username: typeof change?.value?.from?.username === "string" ? change.value.from.username : null,
      },
      media: {
        id: change?.value?.media?.id != null ? String(change.value.media.id) : null,
        media_product_type: typeof change?.value?.media?.media_product_type === "string"
          ? change.value.media.media_product_type
          : null,
      },
    },
  });
});
