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

function configuredValues(...names: string[]): string[] {
  return [...new Set(
    names
      .map((name) => Deno.env.get(name)?.trim() ?? "")
      .filter(Boolean),
  )];
}

async function resolveInstagramAccount(
  supabase: any,
  webhookEntryId: string,
): Promise<{
  account: { id: string; organization_id: string; external_id: string } | null;
  error: string | null;
}> {
  const { data: alias, error: aliasError } = await supabase
    .from("instagram_account_identifiers")
    .select("instagram_account_id, organization_id")
    .eq("identifier_type", "webhook_entry_id")
    .eq("external_id", webhookEntryId)
    .eq("status", "active")
    .maybeSingle();

  if (aliasError) {
    return { account: null, error: aliasError.code ?? "alias_lookup_failed" };
  }

  if (alias?.instagram_account_id) {
    const { data: account, error: accountError } = await supabase
      .from("instagram_accounts")
      .select("id, organization_id, external_id")
      .eq("id", alias.instagram_account_id)
      .eq("organization_id", alias.organization_id)
      .maybeSingle();

    if (accountError) {
      return { account: null, error: accountError.code ?? "account_lookup_failed" };
    }

    return { account: account ?? null, error: null };
  }

  // Compatibilidade durante deploy/rollback: a coluna canônica antiga
  // continua sendo uma fonte válida para o fluxo Instagram Login.
  const { data: account, error: accountError } = await supabase
    .from("instagram_accounts")
    .select("id, organization_id, external_id")
    .eq("external_id", webhookEntryId)
    .maybeSingle();

  if (accountError) {
    return { account: null, error: accountError.code ?? "account_lookup_failed" };
  }

  return { account: account ?? null, error: null };
}

Deno.serve(async (req: Request) => {
  const verifyTokens = configuredValues(
    "META_VERIFY_TOKEN",
    "META_UNIFIED_VERIFY_TOKEN",
  );
  const appSecrets = configuredValues(
    "META_APP_SECRET",
    "META_UNIFIED_APP_SECRET",
  );

  if (req.method === "GET") {
    if (verifyTokens.length === 0) {
      return new Response("Webhook verify token not configured", { status: 503 });
    }

    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token && verifyTokens.includes(token) && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  if (appSecrets.length === 0) {
    return new Response("Webhook app secret not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const signatureChecks = await Promise.all(
    appSecrets.map((secret) => verifyMetaSignature(rawBody, signature, secret)),
  );
  const authentic = signatureChecks.some(Boolean);
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

    const { account, error: accountError } = await resolveInstagramAccount(
      supabase,
      igExternalId,
    );

    if (accountError) {
      console.error("Instagram account identifier lookup failed", accountError);
      return new Response("Temporary persistence error", { status: 500 });
    }

    for (const change of normalizedChanges(entry)) {
      if (change.field !== "comments" && change.field !== "live_comments") continue;

      const commentId = change?.value?.id != null ? String(change.value.id) : null;
      if (!commentId) {
        console.warn("Ignoring comment webhook without comment id");
        continue;
      }

      // Uma vez mapeado, usa o ID canônico legado para manter a mesma chave
      // do importador histórico e deduplicar eventos recebidos pelos dois
      // modos de autenticação durante o canário do Unified Login.
      const canonicalAccountId = account?.external_id ?? igExternalId;
      const idempotencyKey =
        `meta:instagram:${change.field}:${canonicalAccountId}:${commentId}`;

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
          status: account ? "received" : "dead_letter",
          last_error: account ? null : "instagram_account_mapping_missing",
        })
        .select("id, status")
        .single();

      if (insertError?.code === "23505") {
        const { data: existingEvent, error: lookupError } = await supabase
          .from("webhook_events")
          .select("id, status, organization_id, instagram_account_id")
          .eq("idempotency_key", idempotencyKey)
          .single();

        if (lookupError || !existingEvent) {
          console.error("webhook_events duplicate lookup failed", lookupError?.code);
          return new Response("Temporary persistence error", { status: 500 });
        }

        eventId = existingEvent.id;
        eventStatus = existingEvent.status;

        // Um retry posterior pode reparar um evento que chegou antes do
        // cadastro do alias. A atualização é segura porque a chave continua
        // idempotente e a FK composta protege o tenant.
        if (
          account &&
          (!existingEvent.organization_id || !existingEvent.instagram_account_id)
        ) {
          const { error: repairError } = await supabase
            .from("webhook_events")
            .update({
              organization_id: account.organization_id,
              instagram_account_id: account.id,
              status: "received",
              last_error: null,
            })
            .eq("id", eventId)
            .eq("status", "dead_letter");

          if (repairError) {
            console.error("webhook_events mapping repair failed", repairError.code);
            return new Response("Temporary persistence error", { status: 500 });
          }

          eventStatus = "received";
        }
      } else if (insertError) {
        console.error("webhook_events insert failed", insertError.code);
        return new Response("Temporary persistence error", { status: 500 });
      } else {
        eventId = insertedEvent.id;
        eventStatus = insertedEvent.status;
      }

      if (!account || !eventId) {
        console.warn(
          "Webhook event moved to dead letter: Instagram account mapping missing",
          igExternalId,
        );
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

      // Both ingestion paths use one backend CRM service. The RPC is idempotent,
      // so a Meta retry can repair a previous failure without duplicating data.
      const { error: crmError } = await supabase.rpc("ingest_social_comment_event", {
        p_webhook_event_id: eventId,
      });
      if (crmError) {
        console.error("social CRM ingestion failed", crmError.code);
        return new Response("Temporary CRM error", { status: 500 });
      }
    }
  }

  return new Response("EVENT_RECEIVED", { status: 200, headers: { "Content-Type": "text/plain" } });
});
