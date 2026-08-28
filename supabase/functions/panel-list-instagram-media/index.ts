/**
 * panel-list-instagram-media
 *
 * Lista mídias publicadas da conta profissional do Instagram associada
 * à organização autenticada.
 *
 * Segurança:
 * - exige JWT de usuário;
 * - revalida membership ativa;
 * - nunca expõe META_ACCESS_TOKEN;
 * - nunca devolve a URL "next" da Meta, pois ela pode conter parâmetros
 *   que não devem chegar ao navegador;
 * - devolve apenas o cursor opaco de paginação.
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

function normalizeVersion(value: string): string {
  const version = value.trim();
  return /^v\d+\.\d+$/.test(version) ? version : "v26.0";
}

function parseLimit(value: string | null): number {
  if (!value) return 25;

  const n = Number(value);

  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new HttpError(400, "invalid_limit");
  }

  return n;
}

function parseCursor(value: string | null): string | null {
  if (!value) return null;

  const cursor = value.trim();

  if (!cursor || cursor.length > 4096) {
    throw new HttpError(400, "invalid_cursor");
  }

  return cursor;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "GET") {
    return json(
      req,
      { ok: false, error: "method_not_allowed" },
      405,
    );
  }

  try {
    const url = new URL(req.url);

    const organizationId = requireUuid(
      url.searchParams.get("organization_id"),
      "organization_id",
    );

    const limit = parseLimit(url.searchParams.get("limit"));
    const after = parseCursor(url.searchParams.get("after"));

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    /*
     * Fonte de verdade para acesso ao tenant.
     * A RPC considera somente memberships e organizações ativas.
     */
    const {
      data: memberships,
      error: membershipError,
    } = await supabase.rpc("panel_list_memberships", {
      p_user_id: userId,
    });

    if (membershipError) {
      console.error(
        "panel_list_memberships failed",
        membershipError.code,
      );

      const mapped = mapPostgrestError(membershipError.code);

      return json(
        req,
        { ok: false, error: mapped.error },
        mapped.status,
      );
    }

    const membership =
      Array.isArray(memberships) &&
      memberships.find(
        (membership: Record<string, unknown>) =>
          membership.organization_id === organizationId,
      );

    if (!membership) {
      throw new HttpError(403, "forbidden");
    }

    if (membership.role !== "admin") {
      throw new HttpError(403, "admin_required");
    }

    /*
     * MVP: uma conta Instagram ativa por organização.
     * Não aceitamos instagram_account_id arbitrário vindo do browser.
     */
    const {
      data: accounts,
      error: accountError,
    } = await supabase
      .from("instagram_accounts")
      .select("id, external_id, username, status, created_at")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1);

    if (accountError) {
      console.error(
        "instagram_accounts lookup failed",
        accountError.code,
      );

      return json(
        req,
        { ok: false, error: "internal_error" },
        500,
      );
    }

    const account =
      Array.isArray(accounts) && accounts.length > 0
        ? accounts[0]
        : null;

    if (!account?.external_id) {
      return json(
        req,
        { ok: false, error: "instagram_account_not_found" },
        404,
      );
    }

    const accessToken = Deno.env.get("META_ACCESS_TOKEN");

    if (!accessToken) {
      return json(
        req,
        { ok: false, error: "meta_access_token_missing" },
        503,
      );
    }

    const apiVersion = normalizeVersion(
      Deno.env.get("META_API_VERSION") ?? "v26.0",
    );

    const params = new URLSearchParams({
      fields: [
        "id",
        "caption",
        "media_type",
        "media_product_type",
        "permalink",
        "timestamp",
        "comments_count",
        "is_comment_enabled",
      ].join(","),
      limit: String(limit),
    });

    if (after) {
      params.set("after", after);
    }

    const endpoint =
      `https://graph.instagram.com/${apiVersion}/` +
      `${encodeURIComponent(String(account.external_id))}/media?` +
      params.toString();

    let metaResponse: Response;

    try {
      metaResponse = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      console.error(
        "Meta media request failed",
        err instanceof Error ? err.name : "unknown",
      );

      return json(
        req,
        { ok: false, error: "meta_unreachable" },
        502,
      );
    }

    let metaBody: Record<string, unknown> = {};

    try {
      metaBody = await metaResponse.json();
    } catch {
      // resposta inválida será tratada abaixo
    }

    if (!metaResponse.ok) {
      const providerError =
        typeof metaBody.error === "object" &&
        metaBody.error !== null
          ? metaBody.error as Record<string, unknown>
          : null;

      console.error(
        "Meta media request rejected",
        metaResponse.status,
        providerError?.code ?? "unknown",
      );

      return json(
        req,
        {
          ok: false,
          error: "meta_request_failed",
          provider_status: metaResponse.status,
          provider_code: providerError?.code ?? null,
        },
        502,
      );
    }

    const rawMedia = Array.isArray(metaBody.data)
      ? metaBody.data
      : [];

    /*
     * Stories não têm utilidade no módulo de comentários históricos.
     * O endpoint continua focado em Feed/Reels/carrosséis publicados.
     */
    const media = rawMedia
      .filter((item: Record<string, unknown>) =>
        item.media_product_type !== "STORY"
      )
      .map((item: Record<string, unknown>) => ({
        id: item.id ?? null,
        caption:
          typeof item.caption === "string"
            ? item.caption
            : null,
        media_type: item.media_type ?? null,
        media_product_type:
          item.media_product_type ?? null,
        permalink:
          typeof item.permalink === "string"
            ? item.permalink
            : null,
        timestamp:
          typeof item.timestamp === "string"
            ? item.timestamp
            : null,
        comments_count:
          typeof item.comments_count === "number"
            ? item.comments_count
            : null,
        is_comment_enabled:
          typeof item.is_comment_enabled === "boolean"
            ? item.is_comment_enabled
            : null,
      }));

    const paging =
      typeof metaBody.paging === "object" &&
      metaBody.paging !== null
        ? metaBody.paging as Record<string, unknown>
        : null;

    const cursors =
      paging &&
      typeof paging.cursors === "object" &&
      paging.cursors !== null
        ? paging.cursors as Record<string, unknown>
        : null;

    const nextCursor =
      typeof cursors?.after === "string"
        ? cursors.after
        : null;

    return json(req, {
      ok: true,
      instagram_account: {
        username: account.username ?? null,
      },
      pagination: {
        limit,
        after: nextCursor,
        has_more: Boolean(nextCursor),
      },
      media,
    });
  } catch (err) {
    const mapped = toHttpError(err);

    if (mapped.status === 500) {
      console.error(
        "panel-list-instagram-media unexpected error",
      );
    }

    return json(
      req,
      { ok: false, error: mapped.error },
      mapped.status,
    );
  }
});
