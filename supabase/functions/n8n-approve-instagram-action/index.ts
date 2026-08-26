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
  const approver = typeof body?.approver === "string" && body.approver.trim()
    ? body.approver.trim()
    : "n8n-explicit-approval";
  if (!actionId) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  const supabase = createClient(supabaseUrl, getAdminKey(), { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await supabase.rpc("approve_outbound_action", {
    p_action_id: actionId,
    p_approver: approver,
  });
  if (error) {
    console.error("approve_outbound_action failed", error.code);
    return Response.json({ ok: false, error: "approval_rejected" }, { status: 409 });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return Response.json({ ok: false, error: "action_not_found" }, { status: 404 });
  }
  return Response.json({ ok: true, approval: data[0] });
});
