import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getMetaRuntime, MetaConfigurationError, metaUrl, resolveMetaApiUserId } from "../_shared/meta.ts";

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default) return keys.default;
    } catch {}
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

function liveEnabled(): boolean {
  const dryRun = (Deno.env.get("INSTAGRAM_DISPATCH_DRY_RUN") ?? "true").trim().toLowerCase() !== "false";
  const conversationEnabled = (Deno.env.get("INSTAGRAM_CONVERSATION_DISPATCH_ENABLED") ?? "false").trim().toLowerCase() === "true";
  return !dryRun && conversationEnabled;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const expected = Deno.env.get("N8N_WORKER_SECRET") ?? "";
  const supplied = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !supplied || !equal(expected, supplied)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!liveEnabled()) {
    return Response.json({ ok: false, error: "conversation_dispatch_not_enabled" }, { status: 423 });
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid_json" }, { status: 400 }); }
  const requestedMessageId = typeof body.message_id === "string" ? body.message_id : "";
  if (!requestedMessageId) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  const db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: requested, error: requestedError } = await db
    .from("instagram_conversation_messages")
    .select("id,organization_id")
    .eq("id", requestedMessageId)
    .eq("status", "approved")
    .maybeSingle();
  if (requestedError || !requested) return Response.json({ ok: false, error: "message_not_dispatchable" }, { status: 409 });
  const { data: settings } = await db.from("social_selling_settings")
    .select("conversation_daily_limit").eq("organization_id", requested.organization_id).maybeSingle();
  const limit = Number(settings?.conversation_daily_limit ?? 100);
  const { data: claim, error: claimError } = await db.rpc("claim_instagram_conversation_message", {
    p_message_id: requestedMessageId,
    p_dispatcher: typeof body.dispatcher_id === "string" ? body.dispatcher_id : "n8n-conversation-dispatcher-01",
    p_account_daily_limit: Number.isInteger(limit) ? limit : 100,
  });
  if (claimError) {
    console.error("claim_instagram_conversation_message failed", claimError.code);
    return Response.json({ ok: false, error: "claim_failed" }, { status: 409 });
  }
  if (!Array.isArray(claim) || !claim[0] || claim[0].message_id !== requestedMessageId) {
    return Response.json({ ok: false, error: "message_not_claimed" }, { status: 409 });
  }
  const message = claim[0];
  let meta;
  try { meta = getMetaRuntime(); }
  catch (error) {
    const code = error instanceof MetaConfigurationError ? error.code : "meta_configuration_error";
    await db.rpc("mark_instagram_conversation_message_error", {
      p_message_id: requestedMessageId, p_error: code, p_uncertain: false,
    });
    return Response.json({ ok: false, error: code }, { status: 503 });
  }
  let igUserId: string;
  try {
    igUserId = await resolveMetaApiUserId(db, meta, { external_id: message.instagram_account_external_id });
  } catch (error) {
    const code = error instanceof MetaConfigurationError ? error.code : "meta_configuration_error";
    await db.rpc("mark_instagram_conversation_message_error", {
      p_message_id: requestedMessageId, p_error: code, p_uncertain: false,
    });
    return Response.json({ ok: false, error: code }, { status: 503 });
  }
  let response: Response;
  try {
    response = await fetch(metaUrl(meta, `${encodeURIComponent(igUserId)}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${meta.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: message.external_user_id },
        message: { text: message.message_text },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    await db.rpc("mark_instagram_conversation_message_error", {
      p_message_id: requestedMessageId,
      p_error: `network_or_timeout:${error instanceof Error ? error.name : "unknown"}`,
      p_uncertain: true,
    });
    return Response.json({ ok: false, error: "dispatch_uncertain" }, { status: 502 });
  }
  const raw = await response.text();
  let provider: any = null;
  try { provider = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    await db.rpc("mark_instagram_conversation_message_error", {
      p_message_id: requestedMessageId,
      p_error: `meta_rejected:${provider?.error?.code ?? response.status}`,
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "meta_rejected", provider_status: response.status }, { status: 502 });
  }
  const { data: sent, error: sentError } = await db.rpc("mark_instagram_conversation_message_sent", {
    p_message_id: requestedMessageId,
    p_provider_message_id: provider?.message_id ?? "",
  });
  if (sentError || !sent) return Response.json({ ok: false, error: "sent_reconciliation_failed" }, { status: 500 });
  return Response.json({ ok: true, message_id: requestedMessageId, provider_message_id: provider?.message_id ?? null });
});
