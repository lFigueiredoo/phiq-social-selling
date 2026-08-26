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

function normalizeVersion(v: string): string {
  const trimmed = v.trim();
  return /^v\d+\.\d+$/.test(trimmed) ? trimmed : "v26.0";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });

  const expectedSecret = Deno.env.get("N8N_WORKER_SECRET");
  const suppliedSecret = req.headers.get("x-worker-secret") ?? "";
  if (!expectedSecret || !suppliedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const actionId = typeof body?.outbound_action_id === "string" ? body.outbound_action_id : "";
  const dispatcherId = typeof body?.dispatcher_id === "string" && body.dispatcher_id.trim()
    ? body.dispatcher_id.trim()
    : "n8n-instagram-dispatcher-01";
  if (!actionId) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const accessToken = Deno.env.get("META_ACCESS_TOKEN");
  const apiVersion = normalizeVersion(Deno.env.get("META_API_VERSION") ?? "v26.0");
  if (!supabaseUrl || !accessToken) {
    return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, getAdminKey(), { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: claimData, error: claimError } = await supabase.rpc("claim_outbound_action_for_dispatch", {
    p_action_id: actionId,
    p_dispatcher: dispatcherId,
  });

  if (claimError) {
    console.error("claim_outbound_action_for_dispatch failed", claimError.code);
    return Response.json({ ok: false, error: "dispatch_claim_failed" }, { status: 409 });
  }

  if (!Array.isArray(claimData) || claimData.length === 0) {
    const { data: existing } = await supabase
      .from("outbound_actions")
      .select("id,status,provider_action_id,sent_at,last_error")
      .eq("id", actionId)
      .maybeSingle();
    if (existing?.status === "sent") {
      return Response.json({ ok: true, already_sent: true, result: existing });
    }
    return Response.json({ ok: false, error: "action_not_approved_or_not_dispatchable", state: existing ?? null }, { status: 409 });
  }

  const action = claimData[0];
  const igUserId = action.instagram_account_external_id;
  if (!igUserId) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "instagram_account_external_id_missing",
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "instagram_account_missing" }, { status: 500 });
  }

  let url = "";
  let payload: Record<string, unknown>;
  if (action.action_type === "private_reply") {
    url = `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(igUserId)}/messages`;
    payload = {
      recipient: { comment_id: action.target_comment_id },
      message: { text: action.message_text },
    };
  } else if (action.action_type === "public_reply") {
    url = `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(action.target_comment_id)}/replies`;
    payload = { message: action.message_text };
  } else {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "unsupported_action_type",
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "unsupported_action_type" }, { status: 400 });
  }

  let metaResponse: Response;
  try {
    metaResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: `network_or_timeout:${err instanceof Error ? err.name : "unknown"}`,
      p_uncertain: true,
    });
    return Response.json({ ok: false, error: "dispatch_uncertain" }, { status: 502 });
  }

  const raw = await metaResponse.text();
  let metaBody: any = null;
  try { metaBody = raw ? JSON.parse(raw) : null; } catch { metaBody = { raw: raw.slice(0, 500) }; }

  if (!metaResponse.ok) {
    const providerMessage = typeof metaBody?.error?.message === "string" ? metaBody.error.message : `http_${metaResponse.status}`;
    const providerCode = metaBody?.error?.code ?? null;
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: `meta_rejected:${providerCode ?? "unknown"}:${providerMessage}`,
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "meta_rejected", provider_status: metaResponse.status, provider_code: providerCode }, { status: 502 });
  }

  const providerActionId = action.action_type === "private_reply"
    ? (metaBody?.message_id ?? null)
    : (metaBody?.id ?? null);

  const { data: sentData, error: sentError } = await supabase.rpc("mark_outbound_action_sent", {
    p_action_id: actionId,
    p_provider_action_id: providerActionId,
  });

  if (sentError || !Array.isArray(sentData) || sentData.length === 0) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "provider_succeeded_but_finalize_failed",
      p_uncertain: true,
    });
    return Response.json({ ok: false, error: "dispatch_uncertain_after_provider_success" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    result: {
      outbound_action_id: actionId,
      action_type: action.action_type,
      status: sentData[0].status,
      sent_at: sentData[0].sent_at,
      provider_action_id: sentData[0].provider_action_id,
    },
  });
});
