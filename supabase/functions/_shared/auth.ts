/**
 * Autenticação e autorização compartilhadas pelas Edge Functions panel-*.
 *
 * Diferença fundamental em relação às functions n8n-*: aquelas autenticam
 * por segredo compartilhado (x-worker-secret) e são backend-only. Estas
 * autenticam por JWT de usuário do Supabase Auth e são chamadas pelo
 * navegador. NENHUM segredo de servidor trafega para o cliente.
 *
 * O organization_id enviado pelo navegador NUNCA é aceito como verdade:
 * ele é confrontado com organization_members para o usuário do JWT. Essa
 * verificação também é repetida dentro das RPCs panel_* (defesa em
 * profundidade) — se qualquer uma das camadas for esquecida no futuro, a
 * outra ainda bloqueia acesso cross-tenant.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** Chave administrativa, com o mesmo fallback usado pelas functions n8n-*. */
export function getAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default.length > 0) {
        return keys.default;
      }
    } catch {
      // formato inesperado: cai no legado abaixo
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase admin key unavailable");
  return legacy;
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL unavailable");
  return createClient(url, getAdminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AuthedUser {
  userId: string;
}

/** Erro portador de status HTTP e código estável para o cliente. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Valida o JWT do header Authorization e devolve o id do usuário.
 * Lança HttpError(401) se ausente ou inválido.
 */
export async function requireUser(
  req: Request,
  supabase: SupabaseClient,
): Promise<AuthedUser> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token) throw new HttpError(401, "unauthorized");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) throw new HttpError(401, "unauthorized");

  return { userId: data.user.id };
}

/** Lê e valida um UUID obrigatório de um objeto de entrada. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return value;
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Traduz o SQLSTATE das RPCs panel_* em status HTTP.
 *
 * Convenção definida na migration 20260826120200:
 *   42501 -> 403  membership ausente/suspenso ou papel insuficiente
 *   P0002 -> 404  ação inexistente OU de outro tenant (mesma resposta)
 *   22023 -> 400  parâmetro inválido
 *   P0001 -> 409  conflito de regra de negócio (inclui as exceções
 *                 levantadas por approve_outbound_action: estado errado,
 *                 janela expirada, política não elegível)
 *
 * A mensagem interna do banco NÃO é repassada ao cliente — só um código
 * estável. Detalhes ficam no log do servidor.
 */
export function mapPostgrestError(
  code: string | undefined,
): { status: number; error: string } {
  switch (code) {
    case "42501":
      return { status: 403, error: "forbidden" };
    case "P0002":
      return { status: 404, error: "not_found" };
    case "22023":
      return { status: 400, error: "invalid_request" };
    case "P0001":
      return { status: 409, error: "conflict" };
    default:
      return { status: 500, error: "internal_error" };
  }
}

/** Wrapper padrão de tratamento de erro para os handlers panel-*. */
export function toHttpError(err: unknown): { status: number; error: string } {
  if (err instanceof HttpError) {
    return { status: err.status, error: err.code };
  }
  return { status: 500, error: "internal_error" };
}
