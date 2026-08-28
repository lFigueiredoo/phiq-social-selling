import {
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useImportHistoricalComments } from "@/hooks/useImportHistoricalComments";
import { useInstagramMedia } from "@/hooks/useInstagramMedia";
import type {
  PanelHistoricalImportSummary,
  PanelInstagramMedia,
} from "@/lib/api/types";

interface HistoricalMediaListProps {
  organizationId: string;
}

interface ImportProgress {
  after: string | null;
  hasMore: boolean;
  batches: number;
  summary: PanelHistoricalImportSummary;
}

const EMPTY_SUMMARY: PanelHistoricalImportSummary = {
  fetched: 0,
  imported: 0,
  already_exists: 0,
  skipped_own: 0,
  skipped_empty: 0,
  skipped_invalid: 0,
  skipped_already_replied: 0,
  skipped_reply_unverified: 0,
  reply_author_lookups: 0,
};

function addSummary(
  previous: PanelHistoricalImportSummary,
  next: PanelHistoricalImportSummary,
): PanelHistoricalImportSummary {
  return {
    fetched: previous.fetched + next.fetched,
    imported: previous.imported + next.imported,
    already_exists: previous.already_exists + next.already_exists,
    skipped_own: previous.skipped_own + next.skipped_own,
    skipped_empty: previous.skipped_empty + next.skipped_empty,
    skipped_invalid: previous.skipped_invalid + next.skipped_invalid,
    skipped_already_replied:
      previous.skipped_already_replied + next.skipped_already_replied,
    skipped_reply_unverified:
      previous.skipped_reply_unverified + next.skipped_reply_unverified,
    reply_author_lookups:
      previous.reply_author_lookups + next.reply_author_lookups,
  };
}

function formatDate(value: string | null): string {
  if (!value) return "Data não informada";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data não informada";

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function mediaLabel(media: PanelInstagramMedia): string {
  const productType = media.media_product_type?.toUpperCase();

  if (productType === "REELS") return "Reel";
  if (productType === "FEED") return "Feed";

  const type = media.media_type?.toUpperCase();

  if (type === "CAROUSEL_ALBUM") return "Carrossel";
  if (type === "VIDEO") return "Vídeo";
  if (type === "IMAGE") return "Imagem";

  return media.media_product_type ?? media.media_type ?? "Publicação";
}

function captionPreview(caption: string | null): string {
  if (!caption?.trim()) return "Publicação sem legenda.";

  const normalized = caption.trim();

  return normalized.length > 220
    ? `${normalized.slice(0, 220)}…`
    : normalized;
}

export function HistoricalMediaList({
  organizationId,
}: HistoricalMediaListProps) {
  const mediaQuery = useInstagramMedia(organizationId);
  const importMutation = useImportHistoricalComments(organizationId);

  const [progress, setProgress] = useState<
    Record<string, ImportProgress>
  >({});

  const pages = mediaQuery.data?.pages ?? [];
  const media = pages.flatMap((page) => page.media);
  const username =
    pages[0]?.instagram_account.username ?? null;

  const importingMediaId =
    importMutation.isPending
      ? importMutation.variables?.mediaId ?? null
      : null;

  function handleImport(item: PanelInstagramMedia) {
    const current = progress[item.id];

    const confirmed = window.confirm(
      current
        ? "Importar o próximo lote cria eventos e jobs reais no backend. Nenhuma resposta é enviada automaticamente. Deseja continuar?"
        : "Importar comentários históricos cria eventos e jobs reais no backend. Nenhuma resposta é enviada automaticamente. Deseja continuar?",
    );

    if (!confirmed) return;

    importMutation.mutate(
      {
        mediaId: item.id,
        after: current?.after ?? null,
      },
      {
        onSuccess: (result) => {
          setProgress((previous) => {
            const existing = previous[item.id];

            return {
              ...previous,
              [item.id]: {
                after: result.pagination.after,
                hasMore: result.pagination.has_more,
                batches: (existing?.batches ?? 0) + 1,
                summary: addSummary(
                  existing?.summary ?? EMPTY_SUMMARY,
                  result.summary,
                ),
              },
            };
          });
        },
      },
    );
  }

  if (mediaQuery.isPending) {
    return (
      <div className="panel-surface flex min-h-48 items-center justify-center rounded-2xl">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Carregando publicações do Instagram…
        </div>
      </div>
    );
  }

  if (mediaQuery.isError) {
    return (
      <div className="panel-surface rounded-2xl p-5">
        <p className="font-medium">
          Não foi possível carregar as publicações.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Confira a conexão da conta do Instagram e tente novamente.
        </p>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => void mediaQuery.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {username && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Conta conectada:</span>
          <Badge variant="secondary">@{username}</Badge>
        </div>
      )}

      {media.length === 0 && (
        <div className="panel-surface rounded-2xl p-6 text-center">
          <p className="font-medium">Nenhuma publicação encontrada.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A API oficial não retornou mídias elegíveis para esta conta.
          </p>
        </div>
      )}

      {media.map((item) => {
        const itemProgress = progress[item.id];
        const hasComments = item.comments_count !== 0;
        const isImporting = importingMediaId === item.id;
        const completed =
          Boolean(itemProgress) && !itemProgress.hasMore;

        return (
          <article
            key={item.id}
            className="panel-surface rounded-2xl p-4 sm:p-5"
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {mediaLabel(item)}
                    </Badge>

                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <MessageCircle className="size-3.5" />
                      {item.comments_count == null
                        ? "Quantidade não informada"
                        : `${item.comments_count} comentários`}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {formatDate(item.timestamp)}
                    </span>
                  </div>

                  <p className="mt-3 whitespace-pre-line text-sm leading-6 text-foreground/90">
                    {captionPreview(item.caption)}
                  </p>

                  {item.permalink && (
                    <a
                      href={item.permalink}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      Abrir no Instagram
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>

                <div className="shrink-0">
                  <Button
                    type="button"
                    variant={itemProgress ? "outline" : "default"}
                    disabled={
                      !hasComments ||
                      isImporting ||
                      completed ||
                      importMutation.isPending
                    }
                    onClick={() => handleImport(item)}
                  >
                    {isImporting ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        Importando…
                      </>
                    ) : completed ? (
                      "Importação concluída"
                    ) : itemProgress ? (
                      <>
                        Importar próximos
                        <ChevronDown className="size-4" />
                      </>
                    ) : (
                      "Importar comentários"
                    )}
                  </Button>
                </div>
              </div>

              {itemProgress && (
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Resultado da importação
                    </p>

                    <span className="text-xs text-muted-foreground">
                      {itemProgress.batches}{" "}
                      {itemProgress.batches === 1
                        ? "lote processado"
                        : "lotes processados"}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    <div>
                      <p className="text-lg font-semibold">
                        {itemProgress.summary.imported}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Importados
                      </p>
                    </div>

                    <div>
                      <p className="text-lg font-semibold">
                        {itemProgress.summary.already_exists}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Já existentes
                      </p>
                    </div>

                    <div>
                      <p className="text-lg font-semibold">
                        {itemProgress.summary.skipped_already_replied}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Já respondidos
                      </p>
                    </div>

                    <div>
                      <p className="text-lg font-semibold">
                        {itemProgress.summary.skipped_own}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Da própria PHIQ
                      </p>
                    </div>

                    <div>
                      <p className="text-lg font-semibold">
                        {itemProgress.summary.skipped_reply_unverified}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Não verificáveis
                      </p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    {itemProgress.hasMore
                      ? "Ainda existem comentários disponíveis nesta publicação."
                      : "A página final disponível para esta publicação foi alcançada."}
                  </p>
                </div>
              )}
            </div>
          </article>
        );
      })}

      {mediaQuery.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            disabled={mediaQuery.isFetchingNextPage}
            onClick={() => void mediaQuery.fetchNextPage()}
          >
            {mediaQuery.isFetchingNextPage ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Carregando…
              </>
            ) : (
              "Carregar mais publicações"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
