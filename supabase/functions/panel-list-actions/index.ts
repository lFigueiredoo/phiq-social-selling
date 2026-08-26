/**
 * panel-list-actions — fila paginada de revisão.
 *
 * O filtro base vive na RPC panel_list_outbound_actions e espelha
 * exatamente as regras de approve_outbound_action: a fila mostra o que é de
 * fato aprovável (public_reply com not_required|eligible, private_reply com
 * eligible). Duplicar esse filtro aqui criaria uma segunda fonte de verdade.
 *
 * A RPC projeta apenas comment_text do payload — o JSON bruto de
 * webhook_events nunca chega ao navegador.
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

const INTENTS = new Set([
  "engagement",
  "question",
  "purchase_interest",
  "product_interest",
  "support",
  "complaint",
  "partnership",
  "spam",
  "other",
]);
const POTENTIALS = new Set(["low", "medium", "high", "unknown"]);
const ACTION_TYPES = new Set(["public_reply", "private_reply"]);

function enumParam(
  value: string | null,
  allowed: Set<string>,
  field: string,
): string | null {
  if (value === null || value === "") return null;
  if (!allowed.has(value)) throw new HttpError(400, `invalid_${field}`);
  return value;
}

function intParam(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new HttpError(400, "invalid_pagination");
  return n;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "GET") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const url = new URL(req.url);
    const organizationId = requireUuid(
      url.searchParams.get("organization_id"),
      "organization_id",
    );
    const intent = enumParam(url.searchParams.get("intent"), INTENTS, "intent");
    const potential = enumParam(
      url.searchParams.get("commercial_potential"),
      POTENTIALS,
      "commercial_potential",
    );
    const actionType = enumParam(
      url.searchParams.get("action_type"),
      ACTION_TYPES,
      "action_type",
    );
    const limit = intParam(url.searchParams.get("limit"), 25);
    const offset = intParam(url.searchParams.get("offset"), 0);

    if (limit < 1 || limit > 100) throw new HttpError(400, "invalid_pagination");
    if (offset < 0) throw new HttpError(400, "invalid_pagination");

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    const { data, error } = await supabase.rpc("panel_list_outbound_actions", {
      p_organization_id: organizationId,
      p_user_id: userId,
      p_intent: intent,
      p_commercial_potential: potential,
      p_action_type: actionType,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.error("panel_list_outbound_actions failed", error.code);
      const mapped = mapPostgrestError(error.code);
      return json(req, { ok: false, error: mapped.error }, mapped.status);
    }

    const rows = Array.isArray(data) ? data : [];
    // total_count é repetido em cada linha pela RPC (cross join); a fila
    // vazia legitimamente não traz nenhuma linha, logo total 0.
    const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

    return json(req, {
      ok: true,
      pagination: { limit, offset, total },
      actions: rows.map((r: Record<string, unknown>) => ({
        outbound_action_id: r.outbound_action_id,
        action_type: r.action_type,
        status: r.status,
        policy_check_status: r.policy_check_status,
        target_username: r.target_username,
        target_user_id: r.target_user_id,
        target_comment_id: r.target_comment_id,
        comment_text: r.comment_text,
        message_text: r.message_text,
        eligible_until: r.eligible_until,
        comment_created_at: r.comment_created_at,
        created_at: r.created_at,
        analysis: {
          sentiment: r.sentiment,
          intent: r.intent,
          commercial_potential: r.commercial_potential,
          lead_score: r.lead_score,
          analysis_summary: r.analysis_summary,
        },
      })),
    });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) {
      console.error("panel-list-actions unexpected error");
    }
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
