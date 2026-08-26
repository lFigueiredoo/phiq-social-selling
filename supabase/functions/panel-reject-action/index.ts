/**
 * panel-reject-action — rejeição humana pelo painel.
 *
 * Move a ação de 'proposed' para 'rejected', estado terminal criado
 * especificamente para decisão humana. Não reutiliza 'cancelled', que
 * permanece reservado a cancelamento sistêmico futuro.
 *
 * Mutação e auditoria na MESMA transação (RPC panel_reject_outbound_action).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { preflight, json } from "../_shared/cors.ts";
import {
  adminClient,
  HttpError,
  mapPostgrestError,
  optionalString,
  requireUser,
  requireUuid,
  toHttpError,
} from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "invalid_json");
    }

    const actionId = requireUuid(body?.outbound_action_id, "outbound_action_id");
    const organizationId = requireUuid(body?.organization_id, "organization_id");
    const reason = optionalString(body?.reason);

    if (reason !== null && reason.length > 500) {
      throw new HttpError(400, "invalid_reason");
    }

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    const { data, error } = await supabase.rpc("panel_reject_outbound_action", {
      p_action_id: actionId,
      p_organization_id: organizationId,
      p_user_id: userId,
      p_reason: reason,
    });

    if (error) {
      console.error("panel_reject_outbound_action failed", error.code);
      const mapped = mapPostgrestError(error.code);
      return json(req, { ok: false, error: mapped.error }, mapped.status);
    }

    if (!Array.isArray(data) || data.length === 0) {
      return json(req, { ok: false, error: "not_found" }, 404);
    }

    return json(req, { ok: true, rejection: data[0] });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) {
      console.error("panel-reject-action unexpected error");
    }
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
