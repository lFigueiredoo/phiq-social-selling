/**
 * panel-update-action-message — edição da resposta sugerida.
 *
 * Permitida EXCLUSIVAMENTE enquanto a ação está em 'proposed'. Depois de
 * aprovada, a mensagem é imutável por este caminho: isso impede que o texto
 * seja alterado silenciosamente entre a aprovação e o envio, o que
 * invalidaria o que o revisor de fato aprovou.
 *
 * A regra é imposta pela RPC panel_update_outbound_action_message, com
 * FOR UPDATE, e não apenas aqui — a checagem no banco é a que vale sob
 * concorrência.
 *
 * O diff (previous_message_text / new_message_text) é gravado em
 * audit_logs na MESMA transação da alteração.
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

    const raw = body?.message_text;
    if (typeof raw !== "string") throw new HttpError(400, "invalid_message_text");
    const messageText = raw.trim();
    if (!messageText) throw new HttpError(400, "invalid_message_text");
    if (messageText.length > 2000) throw new HttpError(400, "message_text_too_long");

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    const { data, error } = await supabase.rpc(
      "panel_update_outbound_action_message",
      {
        p_action_id: actionId,
        p_organization_id: organizationId,
        p_user_id: userId,
        p_message_text: messageText,
      },
    );

    if (error) {
      // 409 cobre a tentativa de editar uma ação que já saiu de 'proposed'
      // (aprovada por outro revisor, bloqueada por política, etc.).
      console.error("panel_update_outbound_action_message failed", error.code);
      const mapped = mapPostgrestError(error.code);
      return json(req, { ok: false, error: mapped.error }, mapped.status);
    }

    if (!Array.isArray(data) || data.length === 0) {
      return json(req, { ok: false, error: "not_found" }, 404);
    }

    return json(req, { ok: true, action: data[0] });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) {
      console.error("panel-update-action-message unexpected error");
    }
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
