/**
 * panel-approve-action — aprovação humana pelo painel.
 *
 * IMPORTANTE: aprovar NÃO envia nada ao Instagram. Esta função apenas move
 * a ação para 'approved'. O dispatcher continua sendo acionado
 * separadamente pelo n8n, exatamente como já funciona hoje — nenhuma
 * chamada à Graph API acontece aqui.
 *
 * A mutação e a gravação de auditoria acontecem dentro da RPC
 * panel_approve_outbound_action, na MESMA transação PostgreSQL. Se a
 * auditoria falhar, a aprovação sofre rollback.
 */

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

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    const { data, error } = await supabase.rpc(
      "panel_approve_outbound_action",
      {
        p_action_id: actionId,
        p_organization_id: organizationId,
        p_user_id: userId,
      },
    );

    if (error) {
      // 409 aqui cobre tanto "outro revisor já tratou esta ação" quanto
      // janela de elegibilidade expirada e política não elegível — todas
      // levantadas por approve_outbound_action com SQLSTATE P0001.
      console.error("panel_approve_outbound_action failed", error.code);
      const mapped = mapPostgrestError(error.code);
      return json(req, { ok: false, error: mapped.error }, mapped.status);
    }

    if (!Array.isArray(data) || data.length === 0) {
      return json(req, { ok: false, error: "not_found" }, 404);
    }

    return json(req, { ok: true, approval: data[0] });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) {
      console.error("panel-approve-action unexpected error");
    }
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
