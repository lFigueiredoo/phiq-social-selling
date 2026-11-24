import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const expected = Deno.env.get("N8N_WORKER_SECRET") ?? "";
  const supplied = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !supplied || !equal(expected, supplied)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  const db = createClient(url, adminKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const safeUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("instagram_conversation_messages")
    .select("id,conversation_id,message_text,approved_at,eligible_until")
    .eq("direction", "outbound")
    .eq("status", "approved")
    .gt("eligible_until", safeUntil)
    .order("approved_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("conversation dispatch queue lookup failed", error.code);
    return Response.json({ ok: false, error: "queue_lookup_failed" }, { status: 500 });
  }
  return Response.json({
    ok: true,
    message: data ? {
      message_id: data.id,
      conversation_id: data.conversation_id,
      message_text: data.message_text,
      approved_at: data.approved_at,
      eligible_until: data.eligible_until,
    } : null,
  });
});
