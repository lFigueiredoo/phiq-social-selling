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

    // Fail closed, exatamente como o dispatcher: somente o valor literal
    // "false" libera envio. O painel recebe apenas o estado operacional;
    // nenhum segredo ou valor de configuração é exposto ao navegador.
    const dispatchDryRun =
      (Deno.env.get("INSTAGRAM_DISPATCH_DRY_RUN") ?? "true")
        .trim()
        .toLowerCase() !== "false";

    return json(req, {
      ok: true,
      user: { id: userId },
      memberships: Array.isArray(data) ? data : [],
      dispatch: {
        mode: dispatchDryRun ? "dry_run" : "live",
        automatic_dispatch_enabled: !dispatchDryRun,
      },
    });
  } catch (err) {
    const mapped = toHttpError(err);
    if (mapped.status === 500) console.error("panel-me unexpected error");
    return json(req, { ok: false, error: mapped.error }, mapped.status);
  }
});
