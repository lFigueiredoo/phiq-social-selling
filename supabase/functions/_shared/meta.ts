export type MetaAuthMode = "instagram_login" | "unified_login";

export interface MetaRuntime {
  authMode: MetaAuthMode;
  accessToken: string;
  apiVersion: string;
  graphBaseUrl: "https://graph.instagram.com" | "https://graph.facebook.com";
}

export class MetaConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function normalizeMetaVersion(value: string): string {
  const version = value.trim();
  return /^v\d+\.\d+$/.test(version) ? version : "v26.0";
}

export function getMetaRuntime(): MetaRuntime {
  const rawMode = (Deno.env.get("META_AUTH_MODE") ?? "instagram_login").trim();

  if (rawMode !== "instagram_login" && rawMode !== "unified_login") {
    throw new MetaConfigurationError("meta_auth_mode_invalid");
  }

  const authMode: MetaAuthMode = rawMode;
  const tokenVariable = authMode === "unified_login"
    ? "META_UNIFIED_ACCESS_TOKEN"
    : "META_ACCESS_TOKEN";
  const accessToken = Deno.env.get(tokenVariable)?.trim() ?? "";

  if (!accessToken) {
    throw new MetaConfigurationError(
      authMode === "unified_login"
        ? "meta_unified_access_token_missing"
        : "meta_access_token_missing",
    );
  }

  const apiVersion = normalizeMetaVersion(
    Deno.env.get(
      authMode === "unified_login"
        ? "META_UNIFIED_API_VERSION"
        : "META_API_VERSION",
    ) ?? Deno.env.get("META_API_VERSION") ?? "v26.0",
  );

  return {
    authMode,
    accessToken,
    apiVersion,
    graphBaseUrl: authMode === "unified_login"
      ? "https://graph.facebook.com"
      : "https://graph.instagram.com",
  };
}

export function metaUrl(
  runtime: MetaRuntime,
  path: string,
  params?: URLSearchParams,
): string {
  const normalizedPath = path.replace(/^\/+/, "");
  const query = params?.toString();
  return `${runtime.graphBaseUrl}/${runtime.apiVersion}/${normalizedPath}${
    query ? `?${query}` : ""
  }`;
}

interface MetaAccountReference {
  id?: string | null;
  organization_id?: string | null;
  external_id: string;
}

/**
 * Resolve o ID que deve ser usado nas chamadas Graph para a conta.
 *
 * No modo legado, external_id continua sendo o fallback seguro para permitir
 * rollback sem depender da nova tabela. No Unified Login o alias é obrigatório:
 * nunca enviamos uma chamada usando, por acidente, um ID do namespace antigo.
 */
export async function resolveMetaApiUserId(
  supabase: any,
  runtime: MetaRuntime,
  account: MetaAccountReference,
): Promise<string> {
  let accountId = account.id ?? null;
  let organizationId = account.organization_id ?? null;

  if (!accountId) {
    const { data: storedAccount, error: accountError } = await supabase
      .from("instagram_accounts")
      .select("id, organization_id")
      .eq("external_id", account.external_id)
      .maybeSingle();

    if (accountError) {
      throw new MetaConfigurationError("meta_account_lookup_failed");
    }

    accountId = storedAccount?.id ?? null;
    organizationId = storedAccount?.organization_id ?? null;
  }

  if (accountId) {
    let query = supabase
      .from("instagram_account_identifiers")
      .select("external_id")
      .eq("instagram_account_id", accountId)
      .eq("auth_mode", runtime.authMode)
      .eq("identifier_type", "api_user_id")
      .eq("status", "active")
      .eq("is_primary", true);

    if (organizationId) {
      query = query.eq("organization_id", organizationId);
    }

    const { data: identifier, error: identifierError } = await query.maybeSingle();

    if (identifierError) {
      if (runtime.authMode === "unified_login") {
        throw new MetaConfigurationError("meta_account_identifier_lookup_failed");
      }
    } else if (identifier?.external_id) {
      return String(identifier.external_id);
    }
  }

  if (runtime.authMode === "instagram_login") {
    return String(account.external_id);
  }

  throw new MetaConfigurationError("meta_unified_api_user_id_missing");
}
