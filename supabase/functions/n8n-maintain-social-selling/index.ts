import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function adminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try { const keys = JSON.parse(modern); if (typeof keys?.default === "string" && keys.default) return keys.default; } catch {}
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const expected = Deno.env.get("N8N_WORKER_SECRET") ?? "";
  const supplied = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !supplied || !equal(expected, supplied)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  const db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: organizations, error: organizationsError } = await db.from("organizations").select("id").eq("status", "active");
  if (organizationsError) return Response.json({ ok: false, error: "organization_lookup_failed" }, { status: 500 });
  const now = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (const organization of organizations ?? []) {
    const organizationId = organization.id;
    const [dead, failed, overdue, token, lastWebhook, modelErrors] = await Promise.all([
      db.from("processing_jobs").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).eq("status", "dead_letter")
        .gte("updated_at", new Date(now - 24 * 3600_000).toISOString()),
      db.from("outbound_actions").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).eq("status", "failed")
        .gte("updated_at", new Date(now - 24 * 3600_000).toISOString()),
      db.from("instagram_conversations").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).in("status", ["open", "pending"])
        .lt("sla_due_at", new Date().toISOString()),
      db.from("instagram_accounts").select("token_expires_at")
        .eq("organization_id", organizationId).eq("status", "active"),
      db.from("webhook_events").select("received_at")
        .eq("organization_id", organizationId).order("received_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("processing_jobs").select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).in("status", ["failed", "dead_letter"])
        .or("last_error.ilike.%classifier%,last_error.ilike.%draft%")
        .gte("updated_at", new Date(now - 24 * 3600_000).toISOString()),
    ]);
    if ([dead, failed, overdue, token, lastWebhook, modelErrors].some((query) => query.error)) {
      console.error("social monitoring query failed", organizationId);
      return Response.json({ ok: false, error: "monitoring_query_failed" }, { status: 500 });
    }
    const expiring = (token.data ?? []).filter((row: any) => !row.token_expires_at ||
      Date.parse(row.token_expires_at) < now + 14 * 24 * 3600_000).length;
    const noWebhook = !lastWebhook.data?.received_at || Date.parse(lastWebhook.data.received_at) < now - 24 * 3600_000;
    const signals = [
      { key: "dead_letter_24h", count: dead.count ?? 0, severity: "critical", title: "Jobs em dead letter nas últimas 24 horas" },
      { key: "failed_outbound", count: failed.count ?? 0, severity: "critical", title: "Envios externos com falha" },
      { key: "sla_overdue", count: overdue.count ?? 0, severity: "warning", title: "Conversas fora do SLA" },
      { key: "token_expiring", count: expiring, severity: "critical", title: "Token Meta próximo do vencimento" },
      { key: "webhook_silence", count: noWebhook ? 1 : 0, severity: "warning", title: "Nenhum webhook recebido nas últimas 24 horas" },
      { key: "model_errors_24h", count: modelErrors.count ?? 0, severity: "warning", title: "Falhas de modelo ou rascunho nas últimas 24 horas" },
    ];
    for (const signal of signals) {
      const dedup = `monitor:${signal.key}`;
      if (signal.count > 0) {
        const { data: existing, error: existingError } = await db.from("social_operational_alerts")
          .select("id,status").eq("organization_id", organizationId).eq("dedup_key", dedup).maybeSingle();
        if (existingError) return Response.json({ ok: false, error: "alert_lookup_failed" }, { status: 500 });
        if (existing) {
          const { error } = await db.from("social_operational_alerts").update({
            severity: signal.severity,
            status: existing.status === "resolved" ? "open" : existing.status,
            title: signal.title,
            details: { count: signal.count },
            last_seen_at: new Date().toISOString(),
            resolved_at: null,
          }).eq("id", existing.id);
          if (error) return Response.json({ ok: false, error: "alert_update_failed" }, { status: 500 });
        } else {
          const { error } = await db.from("social_operational_alerts").insert({
            organization_id: organizationId, dedup_key: dedup, alert_type: signal.key,
            severity: signal.severity, status: "open", title: signal.title,
            details: { count: signal.count }, last_seen_at: new Date().toISOString(),
          });
          if (error) return Response.json({ ok: false, error: "alert_insert_failed" }, { status: 500 });
        }
      } else {
        const { error } = await db.from("social_operational_alerts").update({
          status: "resolved", resolved_at: new Date().toISOString(),
        }).eq("organization_id", organizationId).eq("dedup_key", dedup).neq("status", "resolved");
        if (error) return Response.json({ ok: false, error: "alert_resolution_failed" }, { status: 500 });
      }
    }
    results.push({ organization_id: organizationId, alerts_checked: signals.length });
  }
  let retention: unknown = null;
  try {
    const body = await req.json();
    if (body?.run_retention === true) {
      const response = await db.rpc("run_social_retention", { p_organization_id: null });
      if (response.error) throw response.error;
      retention = response.data;
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Empty body is valid for monitor-only runs.
    } else {
      console.error("social retention failed");
      return Response.json({ ok: false, error: "retention_failed", monitoring: results }, { status: 500 });
    }
  }
  return Response.json({ ok: true, monitoring: results, retention });
});
