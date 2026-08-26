/**
 * CORS compartilhado pelas Edge Functions panel-*.
 *
 * Sem wildcard: a origem é conferida contra uma allowlist explícita vinda
 * de PANEL_ALLOWED_ORIGINS (lista separada por vírgula). Uma origem
 * desconhecida não recebe cabeçalho de permissão, e o navegador bloqueia a
 * resposta.
 */

function allowedOrigins(): string[] {
  const raw = Deno.env.get("PANEL_ALLOWED_ORIGINS") ?? "";
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = allowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json" },
  });
}
