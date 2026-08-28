import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function getAdminKey(): string {
  const modern = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modern) {
    try {
      const keys = JSON.parse(modern);
      if (typeof keys?.default === "string" && keys.default.length > 0) return keys.default;
    } catch {}
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase admin key unavailable");
  return legacy;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeVersion(v: string): string {
  const trimmed = v.trim();
  return /^v\d+\.\d+$/.test(trimmed) ? trimmed : "v26.0";
}

const MAX_PUBLIC_REPLY_AUTHOR_LOOKUPS = 20;
const PUBLIC_REPLY_AUTHOR_CONCURRENCY = 5;

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
    return { replyIds: [...new Set(replyIds)], hasMore: false };
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
    return { replyIds: [...new Set(replyIds)], hasMore: false };
  }

  if (typeof paging.next !== "string" || !paging.next.trim()) {
    return null;
  }

  return { replyIds: [...new Set(replyIds)], hasMore: true };
}

type RepliesLookupResult =
  | { ok: true; replies: VerifiedReplies }
  | { ok: false; reason: "lookup_failed" | "payload_invalid" };

async function fetchVerifiedReplies(
  commentId: string,
  apiVersion: string,
  accessToken: string,
): Promise<RepliesLookupResult> {
  const params = new URLSearchParams({
    fields: "id",
    limit: "50",
  });
  const endpoint =
    `https://graph.instagram.com/${apiVersion}/` +
    `${encodeURIComponent(commentId)}/replies?` +
    params.toString();

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(
      "Meta public reply preflight replies lookup failed",
      err instanceof Error ? err.name : "unknown",
    );
    return { ok: false, reason: "lookup_failed" };
  }

  let raw = "";

  try {
    raw = await response.text();
  } catch (err) {
    console.error(
      "Meta public reply preflight replies lookup body read failed",
      err instanceof Error ? err.name : "unknown",
    );
    return { ok: false, reason: "lookup_failed" };
  }

  let body: unknown = null;

  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // Invalid JSON is treated as unverifiable below.
  }

  if (!response.ok) {
    const providerCode =
      body && typeof body === "object"
        ? (body as { error?: { code?: unknown } }).error?.code ?? "unknown"
        : "unknown";

    console.error(
      "Meta public reply preflight replies lookup rejected",
      response.status,
      providerCode,
    );
    return { ok: false, reason: "lookup_failed" };
  }

  const replies = verifyRepliesPayload(body);

  if (!replies) {
    console.error("Meta public reply preflight replies payload invalid");
    return { ok: false, reason: "payload_invalid" };
  }

  return { ok: true, replies };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });

  const expectedSecret = Deno.env.get("N8N_WORKER_SECRET");
  const suppliedSecret = req.headers.get("x-worker-secret") ?? "";
  if (!expectedSecret || !suppliedSecret || !constantTimeEqual(expectedSecret, suppliedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const actionId = typeof body?.outbound_action_id === "string" ? body.outbound_action_id : "";
  const dispatcherId = typeof body?.dispatcher_id === "string" && body.dispatcher_id.trim()
    ? body.dispatcher_id.trim()
    : "n8n-instagram-dispatcher-01";
  if (!actionId) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const accessToken = Deno.env.get("META_ACCESS_TOKEN");
  const apiVersion = normalizeVersion(Deno.env.get("META_API_VERSION") ?? "v26.0");
  if (!supabaseUrl || !accessToken) {
    return Response.json({ ok: false, error: "server_misconfigured" }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, getAdminKey(), { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: claimData, error: claimError } = await supabase.rpc("claim_outbound_action_for_dispatch", {
    p_action_id: actionId,
    p_dispatcher: dispatcherId,
  });

  if (claimError) {
    console.error("claim_outbound_action_for_dispatch failed", claimError.code);
    return Response.json({ ok: false, error: "dispatch_claim_failed" }, { status: 409 });
  }

  if (!Array.isArray(claimData) || claimData.length === 0) {
    const { data: existing } = await supabase
      .from("outbound_actions")
      .select("id,status,provider_action_id,sent_at,last_error")
      .eq("id", actionId)
      .maybeSingle();
    if (existing?.status === "sent") {
      return Response.json({ ok: true, already_sent: true, result: existing });
    }
    return Response.json({ ok: false, error: "action_not_approved_or_not_dispatchable", state: existing ?? null }, { status: 409 });
  }

  const action = claimData[0];
  const igUserId = action.instagram_account_external_id;
  if (!igUserId) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "instagram_account_external_id_missing",
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "instagram_account_missing" }, { status: 500 });
  }

  /*
   * Última trava antes de uma resposta pública.
   *
   * O importador histórico já evita criar ações para comentários que a conta
   * respondeu anteriormente. Esta checagem cobre a janela entre importação,
   * aprovação humana e dispatch.
   *
   * A API não expõe o autor das replies de forma confiável na expansão
   * aninhada. Portanto:
   *
   * 1. lê os IDs das replies do comentário;
   * 2. lê cada reply individualmente com fields=id,from;
   * 3. compara from.id com instagram_account.external_id;
   * 4. cancela a ação se encontrar uma reply da própria conta;
   * 5. falha fechado se não puder verificar todas as replies.
   */
  if (action.action_type === "public_reply") {
    const preflightParams = new URLSearchParams({
      fields: "id,replies.limit(50){id}",
    });

    const preflightUrl =
      `https://graph.instagram.com/${apiVersion}/` +
      `${encodeURIComponent(action.target_comment_id)}?` +
      preflightParams.toString();

    let preflightResponse: Response;

    try {
      preflightResponse = await fetch(preflightUrl, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      await supabase.rpc("mark_outbound_action_dispatch_error", {
        p_action_id: actionId,
        p_error:
          `public_reply_preflight_network_or_timeout:` +
          `${err instanceof Error ? err.name : "unknown"}`,
        p_uncertain: false,
      });

      return Response.json(
        {
          ok: false,
          error: "public_reply_preflight_failed",
          reason: "network_or_timeout",
        },
        { status: 502 },
      );
    }

    const preflightRaw = await preflightResponse.text();

    let preflightBody: any = null;
    try {
      preflightBody = preflightRaw
        ? JSON.parse(preflightRaw)
        : null;
    } catch {
      preflightBody = {
        raw: preflightRaw.slice(0, 500),
      };
    }

    if (!preflightResponse.ok) {
      const providerMessage =
        typeof preflightBody?.error?.message === "string"
          ? preflightBody.error.message
          : `http_${preflightResponse.status}`;

      const providerCode =
        preflightBody?.error?.code ?? null;

      await supabase.rpc("mark_outbound_action_dispatch_error", {
        p_action_id: actionId,
        p_error:
          `public_reply_preflight_meta_rejected:` +
          `${providerCode ?? "unknown"}:` +
          `${providerMessage}`,
        p_uncertain: false,
      });

      return Response.json(
        {
          ok: false,
          error: "public_reply_preflight_failed",
          reason: "meta_rejected",
          provider_status: preflightResponse.status,
          provider_code: providerCode,
        },
        { status: 502 },
      );
    }

    if (
      String(preflightBody?.id ?? "") !==
      String(action.target_comment_id)
    ) {
      await supabase.rpc("mark_outbound_action_dispatch_error", {
        p_action_id: actionId,
        p_error: "public_reply_preflight_comment_identity_mismatch",
        p_uncertain: false,
      });

      return Response.json(
        {
          ok: false,
          error: "public_reply_preflight_failed",
          reason: "comment_identity_mismatch",
        },
        { status: 502 },
      );
    }

    let verifiedReplies = verifyRepliesPayload(
      preflightBody?.replies,
    );

    if (!verifiedReplies) {
      const repliesLookup = await fetchVerifiedReplies(
        action.target_comment_id,
        apiVersion,
        accessToken,
      );

      if (!repliesLookup.ok) {
        await supabase.rpc("mark_outbound_action_dispatch_error", {
          p_action_id: actionId,
          p_error:
            repliesLookup.reason === "payload_invalid"
              ? "public_reply_preflight_replies_payload_invalid"
              : "public_reply_preflight_replies_lookup_failed",
          p_uncertain: false,
        });

        return Response.json(
          {
            ok: false,
            error: "public_reply_preflight_failed",
            reason: repliesLookup.reason,
          },
          { status: 502 },
        );
      }

      verifiedReplies = repliesLookup.replies;
    }

    const { replyIds, hasMore: repliesHaveMore } = verifiedReplies;

    /*
     * Não tentamos paginar /replies aqui porque a API apresentou
     * comportamento de cursor não confiável nesse endpoint durante os testes.
     * Se há mais replies que as 50 expandidas, não enviamos.
     */
    if (repliesHaveMore) {
      await supabase.rpc("mark_outbound_action_dispatch_error", {
        p_action_id: actionId,
        p_error: "public_reply_preflight_replies_truncated",
        p_uncertain: false,
      });

      return Response.json(
        {
          ok: false,
          error: "public_reply_preflight_failed",
          reason: "replies_truncated",
        },
        { status: 502 },
      );
    }

    if (replyIds.length > MAX_PUBLIC_REPLY_AUTHOR_LOOKUPS) {
      await supabase.rpc("mark_outbound_action_dispatch_error", {
        p_action_id: actionId,
        p_error: "public_reply_preflight_reply_lookup_limit_exceeded",
        p_uncertain: false,
      });

      return Response.json(
        {
          ok: false,
          error: "public_reply_preflight_failed",
          reason: "reply_lookup_limit_exceeded",
        },
        { status: 502 },
      );
    }

    let ownReplyFound = false;
    let replyAuthorLookups = 0;

    for (
      let offset = 0;
      offset < replyIds.length;
      offset += PUBLIC_REPLY_AUTHOR_CONCURRENCY
    ) {
      const batch = replyIds.slice(
        offset,
        offset + PUBLIC_REPLY_AUTHOR_CONCURRENCY,
      );

      const batchResults = await Promise.all(
        batch.map(async (replyId: string) => {
          replyAuthorLookups++;

          const replyParams = new URLSearchParams({
            fields: "id,from",
          });

          const replyUrl =
            `https://graph.instagram.com/${apiVersion}/` +
            `${encodeURIComponent(replyId)}?` +
            replyParams.toString();

          let replyResponse: Response;

          try {
            replyResponse = await fetch(replyUrl, {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
              },
              signal: AbortSignal.timeout(10000),
            });
          } catch (err) {
            return {
              verified: false,
              own: false,
              reason:
                `network_or_timeout:` +
                `${err instanceof Error ? err.name : "unknown"}`,
            };
          }

          const replyRaw = await replyResponse.text();

          let replyBody: any = null;
          try {
            replyBody = replyRaw
              ? JSON.parse(replyRaw)
              : null;
          } catch {
            replyBody = null;
          }

          if (!replyResponse.ok) {
            const providerCode =
              replyBody?.error?.code ?? "unknown";

            return {
              verified: false,
              own: false,
              reason:
                `meta_rejected:` +
                `${replyResponse.status}:` +
                `${providerCode}`,
            };
          }

          const returnedReplyId =
            typeof replyBody?.id === "string"
              ? replyBody.id
              : "";

          if (returnedReplyId !== replyId) {
            return {
              verified: false,
              own: false,
              reason: "reply_identity_mismatch",
            };
          }

          const replyFromId =
            replyBody?.from?.id != null
              ? String(replyBody.from.id)
              : "";

          /*
           * Ausência de from.id não é interpretada como "terceiro".
           * Sem identidade verificável, falhamos fechado.
           */
          if (!replyFromId) {
            return {
              verified: false,
              own: false,
              reason: "reply_author_missing",
            };
          }

          return {
            verified: true,
            own: replyFromId === String(igUserId),
            reason: "",
          };
        }),
      );

      const unverified = batchResults.find(
        (result) => !result.verified,
      );

      if (unverified) {
        await supabase.rpc("mark_outbound_action_dispatch_error", {
          p_action_id: actionId,
          p_error:
            `public_reply_preflight_reply_author_unverified:` +
            `${unverified.reason}`,
          p_uncertain: false,
        });

        return Response.json(
          {
            ok: false,
            error: "public_reply_preflight_failed",
            reason: "reply_author_unverified",
            reply_author_lookups: replyAuthorLookups,
          },
          { status: 502 },
        );
      }

      if (batchResults.some((result) => result.own)) {
        ownReplyFound = true;
        break;
      }
    }

    if (ownReplyFound) {
      const {
        data: cancelData,
        error: cancelError,
      } = await supabase.rpc(
        "cancel_outbound_public_reply_already_replied",
        {
          p_action_id: actionId,
          p_dispatcher: dispatcherId,
        },
      );

      if (
        cancelError ||
        !Array.isArray(cancelData) ||
        cancelData.length === 0
      ) {
        console.error(
          "cancel_outbound_public_reply_already_replied failed",
          cancelError?.code ?? "empty_result",
        );

        /*
         * Não fazemos POST se a transição de cancelamento não puder
         * ser confirmada.
         */
        await supabase.rpc("mark_outbound_action_dispatch_error", {
          p_action_id: actionId,
          p_error: "public_reply_preflight_cancel_failed",
          p_uncertain: false,
        });

        return Response.json(
          {
            ok: false,
            error: "public_reply_preflight_cancel_failed",
          },
          { status: 500 },
        );
      }

      const cancelledState = cancelData[0];

      if (cancelledState.status !== "cancelled") {
        await supabase.rpc("mark_outbound_action_dispatch_error", {
          p_action_id: actionId,
          p_error: "public_reply_preflight_cancel_state_invalid",
          p_uncertain: false,
        });

        return Response.json(
          {
            ok: false,
            error: "public_reply_preflight_cancel_state_invalid",
            state: cancelledState,
          },
          { status: 409 },
        );
      }

      return Response.json({
        ok: true,
        cancelled: true,
        reason: "public_reply_already_exists_before_dispatch",
        reply_author_lookups: replyAuthorLookups,
        result: {
          outbound_action_id: actionId,
          action_type: action.action_type,
          status: cancelledState.status,
          last_error: cancelledState.last_error,
        },
      });
    }
  }

  let url = "";
  let payload: Record<string, unknown>;
  if (action.action_type === "private_reply") {
    url = `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(igUserId)}/messages`;
    payload = {
      recipient: { comment_id: action.target_comment_id },
      message: { text: action.message_text },
    };
  } else if (action.action_type === "public_reply") {
    url = `https://graph.instagram.com/${apiVersion}/${encodeURIComponent(action.target_comment_id)}/replies`;
    payload = { message: action.message_text };
  } else {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "unsupported_action_type",
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "unsupported_action_type" }, { status: 400 });
  }

  let metaResponse: Response;
  try {
    metaResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: `network_or_timeout:${err instanceof Error ? err.name : "unknown"}`,
      p_uncertain: true,
    });
    return Response.json({ ok: false, error: "dispatch_uncertain" }, { status: 502 });
  }

  const raw = await metaResponse.text();
  let metaBody: any = null;
  try { metaBody = raw ? JSON.parse(raw) : null; } catch { metaBody = { raw: raw.slice(0, 500) }; }

  if (!metaResponse.ok) {
    const providerMessage = typeof metaBody?.error?.message === "string" ? metaBody.error.message : `http_${metaResponse.status}`;
    const providerCode = metaBody?.error?.code ?? null;
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: `meta_rejected:${providerCode ?? "unknown"}:${providerMessage}`,
      p_uncertain: false,
    });
    return Response.json({ ok: false, error: "meta_rejected", provider_status: metaResponse.status, provider_code: providerCode }, { status: 502 });
  }

  const providerActionId = action.action_type === "private_reply"
    ? (metaBody?.message_id ?? null)
    : (metaBody?.id ?? null);

  const { data: sentData, error: sentError } = await supabase.rpc("mark_outbound_action_sent", {
    p_action_id: actionId,
    p_provider_action_id: providerActionId,
  });

  if (sentError || !Array.isArray(sentData) || sentData.length === 0) {
    await supabase.rpc("mark_outbound_action_dispatch_error", {
      p_action_id: actionId,
      p_error: "provider_succeeded_but_finalize_failed",
      p_uncertain: true,
    });
    return Response.json({ ok: false, error: "dispatch_uncertain_after_provider_success" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    result: {
      outbound_action_id: actionId,
      action_type: action.action_type,
      status: sentData[0].status,
      sent_at: sentData[0].sent_at,
      provider_action_id: sentData[0].provider_action_id,
    },
  });
});
