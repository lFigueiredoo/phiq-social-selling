/**
 * panel-import-instagram-comments
 *
 * Importa uma página controlada de comentários históricos de uma mídia
 * do Instagram e os coloca no pipeline já existente.
 *
 * Regras:
 * - exige usuário autenticado;
 * - exige membership ADMIN ativa na organização;
 * - máximo de 25 comentários por chamada;
 * - usa a mesma idempotency_key do webhook oficial;
 * - não duplica webhook_events nem processing_jobs;
 * - ignora comentários da própria conta;
 * - ignora comentários sem texto;
 * - marca payload.source = historical_backfill;
 * - NÃO envia mensagem. Apenas cria jobs para o pipeline existente.
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

// O job é criado atomicamente pela RPC no banco.
const MAX_LIMIT = 25;
const MAX_REPLY_AUTHOR_LOOKUPS = 100;

interface VerifiedReplies {
  replyIds: string[];
  hasMore: boolean;
}

function verifyRepliesPayload(value: unknown): VerifiedReplies | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const replies = value as Record<string, unknown>;

  if (!Array.isArray(replies.data)) {
    return null;
  }

  const replyIds: string[] = [];

  for (const reply of replies.data) {
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
      return null;
    }

    const id = (reply as Record<string, unknown>).id;

    if (typeof id !== "string" || !id.trim()) {
      return null;
    }

    replyIds.push(id.trim());
  }

  if (replies.paging === undefined) {
    return { replyIds, hasMore: false };
  }

  if (
    !replies.paging ||
    typeof replies.paging !== "object" ||
    Array.isArray(replies.paging)
  ) {
    return null;
  }

  const paging = replies.paging as Record<string, unknown>;

  if (!Object.hasOwn(paging, "next")) {
    return { replyIds, hasMore: false };
  }

  if (typeof paging.next !== "string" || !paging.next.trim()) {
    return null;
  }

  return { replyIds, hasMore: true };
}

function normalizeVersion(value: string): string {
  const version = value.trim();
  return /^v\d+\.\d+$/.test(version) ? version : "v26.0";
}

function requireMediaId(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_media_id");
  }

  const id = value.trim();

  if (!/^\d{5,80}$/.test(id)) {
    throw new HttpError(400, "invalid_media_id");
  }

  return id;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 10;
  }

  const n = Number(value);

  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new HttpError(400, "invalid_limit");
  }

  return n;
}

function parseCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_cursor");
  }

  const cursor = value.trim();

  if (!cursor || cursor.length > 4096) {
    throw new HttpError(400, "invalid_cursor");
  }

  return cursor;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(
      req,
      { ok: false, error: "method_not_allowed" },
      405,
    );
  }

  try {
    let body: Record<string, unknown>;

    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "invalid_json");
    }

    const organizationId = requireUuid(
      body.organization_id,
      "organization_id",
    );

    const mediaId = requireMediaId(body.media_id);
    const limit = parseLimit(body.limit);
    const after = parseCursor(body.after);

    const supabase = adminClient();
    const { userId } = await requireUser(req, supabase);

    /*
     * Confirma tenant e exige ADMIN.
     * Importação histórica cria carga de processamento e por isso não fica
     * disponível para reviewer.
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
      Array.isArray(memberships)
        ? memberships.find(
            (row: Record<string, unknown>) =>
              row.organization_id === organizationId,
          )
        : null;

    if (!membership) {
      throw new HttpError(403, "forbidden");
    }

    if (membership.role !== "admin") {
      throw new HttpError(403, "admin_required");
    }

    /*
     * A conta Instagram nunca é escolhida arbitrariamente pelo browser.
     */
    const {
      data: accounts,
      error: accountError,
    } = await supabase
      .from("instagram_accounts")
      .select("id, organization_id, external_id, username, status, created_at")
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

    if (!account?.id || !account?.external_id || !account?.username) {
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

    /*
     * Validação forte de identidade e ownership.
     *
     * Não usamos instagram_accounts.external_id para comparar ownership,
     * porque a própria Meta demonstrou que /me.id e o ID usado pelo webhook
     * podem pertencer a namespaces/escopos diferentes.
     *
     * A mídia só pode ser importada quando:
     * - o token representa o username configurado para a organização;
     * - media.owner.id é exatamente o /me.id do token;
     * - media.username também corresponde à conta conectada.
     */
    const identityEndpoint =
      `https://graph.instagram.com/${apiVersion}/me` +
      "?fields=id,username";

    const mediaEndpoint =
      `https://graph.instagram.com/${apiVersion}/` +
      `${encodeURIComponent(mediaId)}` +
      "?fields=id,owner,username,permalink";

    let identityResponse: Response;
    let mediaResponse: Response;

    try {
      [identityResponse, mediaResponse] = await Promise.all([
        fetch(identityEndpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(15000),
        }),
        fetch(mediaEndpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: AbortSignal.timeout(15000),
        }),
      ]);
    } catch (err) {
      console.error(
        "Meta ownership validation failed",
        err instanceof Error ? err.name : "unknown",
      );

      return json(
        req,
        { ok: false, error: "meta_unreachable" },
        502,
      );
    }

    let identityBody: any = null;
    let mediaBody: any = null;

    try {
      identityBody = await identityResponse.json();
    } catch {
      // tratado abaixo
    }

    try {
      mediaBody = await mediaResponse.json();
    } catch {
      // tratado abaixo
    }

    if (!identityResponse.ok) {
      console.error(
        "Meta identity request rejected",
        identityResponse.status,
        identityBody?.error?.code ?? "unknown",
      );

      return json(
        req,
        {
          ok: false,
          error: "meta_identity_request_failed",
          provider_status: identityResponse.status,
          provider_code: identityBody?.error?.code ?? null,
        },
        502,
      );
    }

    if (!mediaResponse.ok) {
      console.error(
        "Meta media ownership request rejected",
        mediaResponse.status,
        mediaBody?.error?.code ?? "unknown",
      );

      return json(
        req,
        {
          ok: false,
          error: "media_not_owned_by_connected_account",
        },
        403,
      );
    }

    const tokenUserId =
      identityBody?.id != null
        ? String(identityBody.id).trim()
        : "";

    const tokenUsername =
      typeof identityBody?.username === "string"
        ? identityBody.username.trim()
        : "";

    const mediaOwnerId =
      mediaBody?.owner?.id != null
        ? String(mediaBody.owner.id).trim()
        : "";

    const mediaUsername =
      typeof mediaBody?.username === "string"
        ? mediaBody.username.trim()
        : "";

    const configuredUsername =
      String(account.username).trim();

    if (!tokenUserId || !tokenUsername) {
      console.error("Meta token identity is incomplete");

      return json(
        req,
        { ok: false, error: "meta_identity_invalid" },
        502,
      );
    }

    if (
      tokenUsername.toLowerCase() !==
      configuredUsername.toLowerCase()
    ) {
      console.error(
        "Connected Instagram account does not match META_ACCESS_TOKEN",
      );

      return json(
        req,
        {
          ok: false,
          error: "instagram_account_token_mismatch",
        },
        409,
      );
    }

    const ownedByToken =
      mediaOwnerId !== "" &&
      mediaOwnerId === tokenUserId;

    const mediaUsernameMatches =
      mediaUsername !== "" &&
      mediaUsername.toLowerCase() ===
        tokenUsername.toLowerCase();

    if (!ownedByToken || !mediaUsernameMatches) {
      console.error(
        "Instagram media ownership validation rejected",
      );

      return json(
        req,
        {
          ok: false,
          error: "media_not_owned_by_connected_account",
        },
        403,
      );
    }

    const params = new URLSearchParams({
      fields: "from,text,timestamp,replies.limit(50){id}",
      limit: String(limit),
    });

    if (after) {
      params.set("after", after);
    }

    const endpoint =
      `https://graph.instagram.com/${apiVersion}/` +
      `${encodeURIComponent(mediaId)}/comments?` +
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
        "Meta comments request failed",
        err instanceof Error ? err.name : "unknown",
      );

      return json(
        req,
        { ok: false, error: "meta_unreachable" },
        502,
      );
    }

    let metaBody: any = null;

    try {
      metaBody = await metaResponse.json();
    } catch {
      // tratado abaixo
    }

    if (!metaResponse.ok) {
      console.error(
        "Meta comments request rejected",
        metaResponse.status,
        metaBody?.error?.code ?? "unknown",
      );

      return json(
        req,
        {
          ok: false,
          error: "meta_request_failed",
          provider_status: metaResponse.status,
          provider_code: metaBody?.error?.code ?? null,
        },
        502,
      );
    }

    const comments = Array.isArray(metaBody?.data)
      ? metaBody.data
      : [];

    let imported = 0;
    let alreadyExists = 0;
    let skippedOwn = 0;
    let skippedEmpty = 0;
    let skippedInvalid = 0;
    let skippedAlreadyReplied = 0;
    let skippedReplyUnverified = 0;
    let replyAuthorLookups = 0;

    for (const comment of comments) {
      const commentId =
        comment?.id != null
          ? String(comment.id).trim()
          : "";

      if (!commentId) {
        skippedInvalid++;
        continue;
      }

      const text =
        typeof comment?.text === "string"
          ? comment.text.trim()
          : "";

      if (!text) {
        skippedEmpty++;
        continue;
      }

      const commenterId =
        comment?.from?.id != null
          ? String(comment.from.id)
          : null;

      const commenterUsername =
        typeof comment?.from?.username === "string"
          ? comment.from.username.trim()
          : null;

      const ownById =
        commenterId !== null &&
        commenterId === tokenUserId;

      const ownByUsername =
        commenterUsername &&
        commenterUsername.toLowerCase() ===
          tokenUsername.toLowerCase();

      if (ownById || ownByUsername) {
        skippedOwn++;
        continue;
      }

      /*
       * Proteção contra resposta duplicada.
       *
       * A expansão de replies devolve os IDs, porém não o autor.
       * Quando existem replies, consultamos cada objeto individualmente
       * até encontrar uma resposta da própria conta.
       *
       * Se houver mais de 50 replies, a expansão informa paging.next.
       * Nesse caso não conseguimos provar que todas foram verificadas e
       * portanto falhamos fechado para este comentário.
       */
      const verifiedReplies = verifyRepliesPayload(comment?.replies);

      if (!verifiedReplies) {
        skippedReplyUnverified++;
        continue;
      }

      const { replyIds, hasMore: repliesHaveMore } = verifiedReplies;

      if (repliesHaveMore) {
        skippedReplyUnverified++;
        continue;
      }

      let alreadyRepliedByAccount = false;
      let replyVerificationFailed = false;

      for (const replyId of replyIds) {
        if (
          replyAuthorLookups >=
          MAX_REPLY_AUTHOR_LOOKUPS
        ) {
          console.error(
            "historical reply verification lookup limit reached",
          );

          replyVerificationFailed = true;
          break;
        }

        replyAuthorLookups++;

        const replyEndpoint =
          `https://graph.instagram.com/${apiVersion}/` +
          `${encodeURIComponent(replyId)}` +
          "?fields=id,from";

        let replyResponse: Response;

        try {
          replyResponse = await fetch(replyEndpoint, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            signal: AbortSignal.timeout(15000),
          });
        } catch (err) {
          console.error(
            "Meta reply author request failed",
            err instanceof Error ? err.name : "unknown",
          );

          replyVerificationFailed = true;
          break;
        }

        let replyBody: any = null;

        try {
          replyBody = await replyResponse.json();
        } catch {
          // tratado abaixo
        }

        if (!replyResponse.ok) {
          console.error(
            "Meta reply author request rejected",
            replyResponse.status,
            replyBody?.error?.code ?? "unknown",
          );

          replyVerificationFailed = true;
          break;
        }

        const replyFromId =
          replyBody?.from?.id != null
            ? String(replyBody.from.id).trim()
            : "";

        const replyFromUsername =
          typeof replyBody?.from?.username === "string"
            ? replyBody.from.username.trim()
            : "";

        /*
         * Nos testes reais da API:
         * - /me.id usa o ID escopado do token;
         * - reply.from.id da própria PHIQ usa o external_id conhecido
         *   pelo webhook.
         *
         * Por isso a identificação de reply própria usa external_id e
         * username, ambos observados diretamente na API.
         */
        const ownReplyById =
          replyFromId !== "" &&
          replyFromId === String(account.external_id);

        const ownReplyByUsername =
          replyFromUsername !== "" &&
          replyFromUsername.toLowerCase() ===
            tokenUsername.toLowerCase();

        if (ownReplyById || ownReplyByUsername) {
          alreadyRepliedByAccount = true;
          break;
        }

        /*
         * Se a Meta devolver a reply sem nenhuma identidade, não temos
         * evidência suficiente para importar com segurança.
         */
        if (!replyFromId && !replyFromUsername) {
          replyVerificationFailed = true;
          break;
        }
      }

      if (replyVerificationFailed) {
        skippedReplyUnverified++;
        continue;
      }

      if (alreadyRepliedByAccount) {
        skippedAlreadyReplied++;
        continue;
      }

      /*
       * Mantém exatamente o formato que n8n-claim-instagram-job já sabe
       * interpretar: entry[].changes[].field/value.
       *
       * A marca source no nível raiz é usada pelo Decision Engine para
       * impedir Private Reply em comentários históricos.
       */
      const historicalPayload = {
        source: "historical_backfill",
        imported_at: new Date().toISOString(),
        object: "instagram",
        entry: [
          {
            id: String(account.external_id),
            time: Math.floor(Date.now() / 1000),
            changes: [
              {
                field: "comments",
                value: {
                  id: commentId,
                  from: {
                    id: commenterId,
                    username: commenterUsername,
                  },
                  text,
                  timestamp:
                    typeof comment?.timestamp === "string"
                      ? comment.timestamp
                      : null,
                  media: {
                    id: mediaId,
                    media_product_type: null,
                  },
                },
              },
            ],
          },
        ],
      };

      /*
       * MESMA chave usada pelo webhook em tempo real.
       * Se o comentário já passou pelo webhook, o backfill não o duplica.
       */
      const idempotencyKey =
        `meta:instagram:comments:` +
        `${account.external_id}:${commentId}`;

      /*
       * A persistência do evento e a criação do processing_job acontecem
       * atomicamente dentro do Postgres.
       *
       * A RPC também repete a validação de admin + tenant como defense in
       * depth e mantém o comportamento de não ressuscitar eventos existentes.
       */
      const {
        data: importRows,
        error: importError,
      } = await supabase.rpc(
        "panel_import_historical_instagram_comment",
        {
          p_user_id: userId,
          p_organization_id: organizationId,
          p_instagram_account_id: account.id,
          p_comment_id: commentId,
          p_idempotency_key: idempotencyKey,
          p_payload: historicalPayload,
        },
      );

      if (importError) {
        console.error(
          "historical atomic import failed",
          importError.code,
        );

        const mapped =
          mapPostgrestError(importError.code);

        return json(
          req,
          { ok: false, error: mapped.error },
          mapped.status,
        );
      }

      const importRow =
        Array.isArray(importRows) &&
        importRows.length > 0
          ? importRows[0]
          : null;

      const importResult =
        typeof importRow?.result === "string"
          ? importRow.result
          : null;

      if (importResult === "already_exists") {
        alreadyExists++;
        continue;
      }

      if (importResult === "imported") {
        imported++;
        continue;
      }

      console.error(
        "historical atomic import returned invalid result",
      );

      return json(
        req,
        { ok: false, error: "persistence_error" },
        500,
      );
    }

    const paging =
      metaBody?.paging &&
      typeof metaBody.paging === "object"
        ? metaBody.paging
        : null;

    const nextCursor =
      typeof paging?.cursors?.after === "string"
        ? paging.cursors.after
        : null;

    /*
     * Auditoria do ato humano de importar a página.
     * Nenhum token ou payload bruto da Meta é armazenado aqui.
     */
    const {
      error: auditError,
    } = await supabase
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        actor_type: "user",
        actor_id: userId,
        action: "historical_comments_imported",
        entity_type: "instagram_media",
        entity_id: mediaId,
        metadata: {
          requested_limit: limit,
          fetched: comments.length,
          imported,
          already_exists: alreadyExists,
          skipped_own: skippedOwn,
          skipped_empty: skippedEmpty,
          skipped_invalid: skippedInvalid,
          skipped_already_replied: skippedAlreadyReplied,
          skipped_reply_unverified: skippedReplyUnverified,
          reply_author_lookups: replyAuthorLookups,
          has_more: Boolean(nextCursor),
        },
      });

    if (auditError) {
      /*
       * Importação já ocorreu. Não fazemos rollback parcial aqui porque uma
       * nova tentativa é idempotente. Registramos o problema no servidor.
       */
      console.error(
        "historical import audit failed",
        auditError.code,
      );
    }

    return json(req, {
      ok: true,
      media_id: mediaId,
      summary: {
        fetched: comments.length,
        imported,
        already_exists: alreadyExists,
        skipped_own: skippedOwn,
        skipped_empty: skippedEmpty,
        skipped_invalid: skippedInvalid,
        skipped_already_replied: skippedAlreadyReplied,
        skipped_reply_unverified: skippedReplyUnverified,
        reply_author_lookups: replyAuthorLookups,
      },
      pagination: {
        after: nextCursor,
        has_more: Boolean(nextCursor),
      },
    });
  } catch (err) {
    const mapped = toHttpError(err);

    if (mapped.status === 500) {
      console.error(
        "panel-import-instagram-comments unexpected error",
      );
    }

    return json(
      req,
      { ok: false, error: mapped.error },
      mapped.status,
    );
  }
});
