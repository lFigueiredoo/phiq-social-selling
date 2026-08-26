import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const JOB_TYPE = "process_instagram_comment";

function getAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default.length > 0) return keys.default;
    } catch {
      // Fall back to legacy key below.
    }
  }

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase admin key is unavailable");
  return legacy;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyMetaSignature(rawBody: string, signatureHeader: string, appSecret: string): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const supplied = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return constantTimeEqual(hex(digest), supplied);
}

function normalizedChanges(entry: any): Array<{ field: string; value: any }> {
  if (Array.isArray(entry?.changes)) {
    return entry.changes
      .filter((change: any) => change && typeof change.field === "string")
      .map((change: any) => ({ field: change.field, value: change.value }));
  }

  if (typeof entry?.field === "string") {
    return [{ field: entry.field, value: entry.value }];
  }

  return [];
}

Deno.serve(async (req: Request) => {
  const verifyToken = Deno.env.get("META_VERIFY_TOKEN");
  const appSecret = Deno.env.get("META_APP_SECRET");

  if (req.method === "GET") {
    if (!verifyToken) return new Response("Webhook verify token not configured", { status: 503 });

    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  if (!appSecret) return new Response("Webhook app secret not configured", { status: 503 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const authentic = await verifyMetaSignature(rawBody, signature, appSecret);
  if (!authentic) return new Response("Invalid signature", { status: 401 });

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body?.object !== "instagram" || !Array.isArray(body?.entry)) {
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return new Response("Supabase URL unavailable", { status: 503 });

  const supabase = createClient(supabaseUrl, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const entry of body.entry) {
    const igExternalId = entry?.id != null ? String(entry.id) : null;
    if (!igExternalId) continue;

    const { data: account, error: accountError } = await supabase
      .from("instagram_accounts")
      .select("id, organization_id")
      .eq("external_id", igExternalId)
      .maybeSingle();

    if (accountError) {
      console.error("instagram_accounts lookup failed", accountError.code);
      return new Response("Temporary persistence error", { status: 500 });
    }

    for (const change of normalizedChanges(entry)) {
      if (change.field !== "comments" && change.field !== "live_comments") continue;

      const commentId = change?.value?.id != null ? String(change.value.id) : null;
      if (!commentId) {
        console.warn("Ignoring comment webhook without comment id");
        continue;
      }

      const idempotencyKey = `meta:instagram:${change.field}:${igExternalId}:${commentId}`;

      let eventId: string | null = null;
      let eventStatus: string | null = null;

      const { data: insertedEvent, error: insertError } = await supabase
        .from("webhook_events")
        .insert({
          organization_id: account?.organization_id ?? null,
          instagram_account_id: account?.id ?? null,
          provider: "meta",
          object_type: "instagram",
          event_type: change.field,
          external_object_id: commentId,
          idempotency_key: idempotencyKey,
          payload: body,
          status: "received",
        })
        .select("id, status")
        .single();

      if (insertError?.code === "23505") {
        const { data: existingEvent, error: lookupError } = await supabase
          .from("webhook_events")
          .select("id, status")
          .eq("idempotency_key", idempotencyKey)
          .single();

        if (lookupError || !existingEvent) {
          console.error("webhook_events duplicate lookup failed", lookupError?.code);
          return new Response("Temporary persistence error", { status: 500 });
        }

        eventId = existingEvent.id;
        eventStatus = existingEvent.status;
      } else if (insertError) {
        console.error("webhook_events insert failed", insertError.code);
        return new Response("Temporary persistence error", { status: 500 });
      } else {
        eventId = insertedEvent.id;
        eventStatus = insertedEvent.status;
      }

      if (!account || !eventId) {
        console.warn("Webhook event persisted without a mapped Instagram account", igExternalId);
        continue;
      }

      const { error: jobError } = await supabase.from("processing_jobs").insert({
        organization_id: account.organization_id,
        webhook_event_id: eventId,
        job_type: JOB_TYPE,
        status: "pending",
        priority: 0,
      });

      if (jobError && jobError.code !== "23505") {
        console.error("processing_jobs insert failed", jobError.code);
        return new Response("Temporary queue error", { status: 500 });
      }

      if (eventStatus === "received") {
        const { error: statusError } = await supabase
          .from("webhook_events")
          .update({ status: "queued" })
          .eq("id", eventId)
          .eq("status", "received");

        if (statusError) {
          console.error("webhook_events status update failed", statusError.code);
          return new Response("Temporary queue error", { status: 500 });
        }
      }
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200, headers: { "Content-Type": "text/plain" } });
});
