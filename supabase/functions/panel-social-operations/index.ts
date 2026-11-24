import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { preflight, json } from "../_shared/cors.ts";
import {
  adminClient,
  HttpError,
  mapPostgrestError,
  requireUser,
  requireUuid,
  toHttpError,
} from "../_shared/auth.ts";

function rpcFailure(error: { code?: string } | null): never {
  const mapped = mapPostgrestError(error?.code);
  throw new HttpError(mapped.status, mapped.error);
}

function intRange(value: unknown, min: number, max: number, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return number;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }
  try {
    const db = adminClient();
    const { userId } = await requireUser(req, db);
    if (req.method === "GET") {
      const url = new URL(req.url);
      const organizationId = requireUuid(url.searchParams.get("organization_id"), "organization_id");
      const { data, error } = await db.rpc("panel_social_operations_summary", {
        p_user_id: userId,
        p_organization_id: organizationId,
      });
      if (error) rpcFailure(error);
      return json(req, { ok: true, data });
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    const organizationId = requireUuid(body.organization_id, "organization_id");
    const action = typeof body.action === "string" ? body.action : "";
    let data: unknown;
    let error: { code?: string } | null = null;
    if (action === "update_settings") {
      ({ data, error } = await db.rpc("panel_update_social_selling_settings", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_response_sla_minutes: intRange(body.response_sla_minutes, 5, 1440, "response_sla_minutes"),
        p_retention_days: intRange(body.retention_days, 30, 730, "retention_days"),
        p_retention_enabled: body.retention_enabled === true,
        p_auto_assign_enabled: body.auto_assign_enabled !== false,
        p_auto_suggest_enabled: body.auto_suggest_enabled !== false,
        p_conversation_daily_limit: intRange(body.conversation_daily_limit, 1, 500, "conversation_daily_limit"),
      }));
    } else if (action === "upsert_offer") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 160) throw new HttpError(400, "invalid_offer");
      ({ data, error } = await db.rpc("panel_upsert_social_catalog_offer", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_offer_id: body.offer_id ? requireUuid(body.offer_id, "offer_id") : null,
        p_route_type: typeof body.route_type === "string" && body.route_type ? body.route_type : null,
        p_offer_kind: body.offer_kind,
        p_name: name,
        p_summary: typeof body.summary === "string" ? body.summary : "",
        p_audience: typeof body.audience === "string" ? body.audience : "",
        p_approved_claims: Array.isArray(body.approved_claims) ? body.approved_claims : [],
        p_prohibited_claims: Array.isArray(body.prohibited_claims) ? body.prohibited_claims : [],
        p_price_text: typeof body.price_text === "string" ? body.price_text : null,
        p_public_url: typeof body.public_url === "string" ? body.public_url : null,
        p_active: body.active !== false,
      }));
    } else if (action === "ack_alert" || action === "resolve_alert") {
      ({ data, error } = await db.rpc("panel_acknowledge_social_alert", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_alert_id: requireUuid(body.alert_id, "alert_id"),
        p_resolve: action === "resolve_alert",
      }));
    } else if (action === "erase_contact") {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason || reason.length > 500) throw new HttpError(400, "reason_required");
      ({ data, error } = await db.rpc("panel_request_social_contact_erasure", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_contact_id: requireUuid(body.contact_id, "contact_id"),
        p_reason: reason,
      }));
    } else {
      throw new HttpError(400, "invalid_action");
    }
    if (error) rpcFailure(error);
    return json(req, { ok: true, data });
  } catch (caught) {
    const mapped = toHttpError(caught);
    if (mapped.status === 500) console.error("panel-social-operations unexpected error");
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
