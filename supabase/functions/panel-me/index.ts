/**
 * panel-me — bootstrap do painel.
 *
 * Devolve o usuário autenticado e TODAS as suas memberships ativas. Um
 * usuário pode pertencer a várias organizações; a escolha da organização
 * ativa é do frontend, e toda operação subsequente informa explicitamente
 * qual organization_id está sendo usada (sempre revalidada no backend).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { preflight, json } from "../_shared/cors.ts";
import {
  adminClient,
  mapPostgrestError,
  requireUser,
  toHttpError,
} from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "GET") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    const { data, error } = await supabase.rpc("panel_list_memberships", {
      p_user_id: userId,
    });

    if (error) {
      console.error("panel_list_memberships failed", error.code);
      const mapped = mapPostgrestError(error.code);
      return json(req, { ok: false, error: mapped.error }, mapped.status);
    }

    return json(req, {
      ok: true,
      user: { id: userId },
      memberships: Array.isArray(data) ? data : [],
    });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) console.error("panel-me unexpected error");
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
