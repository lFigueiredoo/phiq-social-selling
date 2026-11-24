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

function intValue(value: unknown, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new HttpError(400, "invalid_pagination");
  }
  return parsed;
}

function rpcFailure(error: { code?: string } | null): never {
  const mapped = mapPostgrestError(error?.code);
  throw new HttpError(mapped.status, mapped.error);
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
      const view = url.searchParams.get("view") ?? "list";
      if (view === "list") {
        const limit = intValue(url.searchParams.get("limit"), 25, 100);
        const offset = intValue(url.searchParams.get("offset"), 0, 1_000_000);
        if (limit === 0) throw new HttpError(400, "invalid_pagination");
        const owner = url.searchParams.get("owner");
        const { data, error } = await db.rpc("panel_social_inbox", {
          p_user_id: userId,
          p_organization_id: organizationId,
          p_status: url.searchParams.get("status") || null,
          p_owner: owner ? requireUuid(owner, "owner") : null,
          p_search: url.searchParams.get("search") || null,
          p_limit: limit,
          p_offset: offset,
        });
        if (error) rpcFailure(error);
        return json(req, { ok: true, data });
      }
      if (view === "detail") {
        const conversationId = requireUuid(url.searchParams.get("conversation_id"), "conversation_id");
        const { data, error } = await db.rpc("panel_social_conversation_detail", {
          p_user_id: userId,
          p_organization_id: organizationId,
          p_conversation_id: conversationId,
        });
        if (error) rpcFailure(error);
        return json(req, { ok: true, data });
      }
      throw new HttpError(400, "invalid_view");
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

    if (action === "create_reply") {
      const message = typeof body.message_text === "string" ? body.message_text.trim() : "";
      if (!message || message.length > 1000 || new TextEncoder().encode(message).length > 1000) {
        throw new HttpError(400, "invalid_message_text");
      }
      ({ data, error } = await db.rpc("panel_create_instagram_conversation_reply", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_conversation_id: requireUuid(body.conversation_id, "conversation_id"),
        p_message_text: message,
        p_operation_key: typeof body.operation_key === "string" && body.operation_key.length <= 120
          ? body.operation_key
          : crypto.randomUUID(),
      }));
    } else if (action === "approve_reply") {
      ({ data, error } = await db.rpc("panel_approve_instagram_conversation_reply", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_message_id: requireUuid(body.message_id, "message_id"),
      }));
    } else if (action === "manage") {
      const manageAction = typeof body.manage_action === "string" ? body.manage_action : "";
      if (!["mark_read", "assign", "priority", "status", "opt_out"].includes(manageAction)) {
        throw new HttpError(400, "invalid_conversation_action");
      }
      ({ data, error } = await db.rpc("panel_manage_instagram_conversation", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_conversation_id: requireUuid(body.conversation_id, "conversation_id"),
        p_action: manageAction,
        p_value: typeof body.value === "string" ? body.value : null,
      }));
    } else if (action === "feedback") {
      ({ data, error } = await db.rpc("panel_submit_social_model_feedback", {
        p_user_id: userId,
        p_organization_id: organizationId,
        p_message_id: requireUuid(body.message_id, "message_id"),
        p_rating: body.rating,
        p_tags: Array.isArray(body.tags) ? body.tags : [],
        p_corrected_text: typeof body.corrected_text === "string" ? body.corrected_text : null,
        p_notes: typeof body.notes === "string" ? body.notes : null,
      }));
    } else {
      throw new HttpError(400, "invalid_action");
    }
    if (error) rpcFailure(error);
    return json(req, { ok: true, data });
  } catch (caught) {
    const mapped = toHttpError(caught);
    if (mapped.status === 500) console.error("panel-conversations unexpected error");
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
