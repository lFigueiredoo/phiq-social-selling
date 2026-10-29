import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { preflight, json } from "../_shared/cors.ts";
import { adminClient, HttpError, mapPostgrestError, requireUser, requireUuid, toHttpError } from "../_shared/auth.ts";

const readModes = {
  dashboard: "panel_social_dashboard",
  leads: "panel_social_leads",
  lead: "panel_social_lead_detail",
  timeline: "panel_social_lead_timeline",
  members: "panel_social_members",
} as const;
type ReadMode = keyof typeof readModes;

function intValue(value: unknown, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, "invalid_pagination");
  return n;
}

function requiredReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500)
    throw new HttpError(400, "reason_required");
  return value.trim();
}

function rpcError(error: { code?: string } | null): never {
  const mapped = mapPostgrestError(error?.code);
  if (error?.code === "23505") throw new HttpError(409, "conflict");
  throw new HttpError(mapped.status, mapped.error);
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "POST")
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  try {
    const db = adminClient();
    const { userId } = await requireUser(req, db);
    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("view") as ReadMode;
      if (!(mode in readModes)) throw new HttpError(400, "invalid_view");
      const organizationId = requireUuid(url.searchParams.get("organization_id"), "organization_id");
      const args: Record<string, unknown> = { p_user_id: userId, p_organization_id: organizationId };
      if (mode === "lead" || mode === "timeline")
        args.p_lead_id = requireUuid(url.searchParams.get("lead_id"), "lead_id");
      if (mode === "leads" || mode === "timeline") {
        args.p_limit = intValue(url.searchParams.get("limit"), 25, 100);
        args.p_offset = intValue(url.searchParams.get("offset"), 0, 1000000);
        if (args.p_limit === 0) throw new HttpError(400, "invalid_pagination");
      }
      if (mode === "leads") {
        args.p_sort = url.searchParams.get("sort") ?? "recent";
        let filters: unknown = {};
        const encoded = url.searchParams.get("filters");
        if (encoded) {
          try { filters = JSON.parse(encoded); } catch { throw new HttpError(400, "invalid_filters"); }
        }
        args.p_filters = filters;
      }
      const { data, error } = await db.rpc(readModes[mode], args);
      if (error) rpcError(error);
      return json(req, { ok: true, data });
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { throw new HttpError(400, "invalid_json"); }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HttpError(400, "invalid_json");
    const organizationId = requireUuid(body.organization_id, "organization_id");
    const leadId = requireUuid(body.lead_id, "lead_id");
    const action = body.action;
    if (typeof action !== "string" || !["transition", "override", "route", "assign", "close", "reopen", "central", "eligibility"].includes(action))
      throw new HttpError(400, "invalid_action");
    const reason = requiredReason(body.reason);
    const { error: memberError } = await db.rpc("panel_assert_membership", {
      p_user_id: userId, p_organization_id: organizationId, p_min_role: "admin",
    });
    if (memberError) rpcError(memberError);
    const operationKey = typeof body.operation_key === "string" && body.operation_key.length <= 120
      ? body.operation_key : crypto.randomUUID();
    let name: string;
    let params: Record<string, unknown>;
    if (action === "transition" || action === "override") {
      name = "panel_social_transition_vertical";
      params = { p_user_id: userId, p_organization_id: organizationId, p_lead_id: leadId,
        p_expected_stage: body.expected_stage, p_to_stage: body.to_stage,
        p_operation_key: operationKey, p_reason: reason, p_override: action === "override" };
    } else if (action === "route" || action === "central") {
      if (action === "route") {
        name = "panel_social_reclassify_route";
        const route = body.route_type;
        if (typeof route !== "string" || !["franchise", "q3", "hotmart", "nuy", "no_profile"].includes(route))
          throw new HttpError(400, "invalid_route");
        params = { p_user_id: userId, p_organization_id: organizationId, p_lead_id: leadId,
          p_route_type: route, p_operation_key: operationKey, p_reason: reason };
      } else {
        name = "manual_override_social_lead";
        const stage = body.central_stage;
        if (typeof stage !== "string" || !["new_lead", "first_contact", "qualification", "routing"].includes(stage))
          throw new HttpError(400, "invalid_stage");
        params = { p_organization_id: organizationId, p_lead_id: leadId, p_actor_user_id: userId,
          p_reason: reason, p_changes: { central_stage: stage } };
      }
    } else if (action === "assign") {
      name = "assign_social_lead_owner";
      params = { p_organization_id: organizationId, p_lead_id: leadId, p_actor_user_id: userId,
        p_owner_user_id: body.owner_user_id === null ? null : requireUuid(body.owner_user_id, "owner_user_id"),
        p_operation_key: operationKey, p_reason: reason };
    } else if (action === "eligibility") {
      name = "set_social_contact_eligibility";
      if (typeof body.eligibility !== "string" || !["unknown", "eligible", "ineligible", "not_required"].includes(body.eligibility))
        throw new HttpError(400, "invalid_eligibility");
      params = { p_organization_id: organizationId, p_lead_id: leadId, p_actor_user_id: userId,
        p_eligibility: body.eligibility, p_reason: reason };
    } else {
      name = "set_social_lead_status";
      const status = action === "reopen" ? "active" : body.status;
      if (status !== "active" && status !== "lost" && status !== "cancelled")
        throw new HttpError(400, "invalid_status");
      if (action === "close" && status === "active") throw new HttpError(400, "invalid_status");
      params = { p_organization_id: organizationId, p_lead_id: leadId, p_actor_user_id: userId,
        p_to_status: status, p_operation_key: operationKey, p_reason: reason };
    }
    const { data, error } = await db.rpc(name, params);
    if (error) rpcError(error);
    const { data: lead, error: leadError } = await db.rpc("panel_social_lead_detail", {
      p_user_id: userId, p_organization_id: organizationId, p_lead_id: leadId,
    });
    if (leadError) rpcError(leadError);
    return json(req, { ok: true, lead, operation_key: operationKey, result: data });
  } catch (error) {
    const mapped = toHttpError(error);
    if (mapped.status === 500) console.error("panel-social-crm unexpected error");
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
