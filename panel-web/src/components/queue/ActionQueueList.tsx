import { CheckCircle2, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionCard } from "@/components/queue/ActionCard";
import { useActionsQueue } from "@/hooks/useActionsQueue";
import type { PanelAction, PanelListActionsFilters } from "@/lib/api/types";

interface ActionQueueListProps {
  organizationId: string;
  filters: PanelListActionsFilters;
}

function flattenUniqueActions(pages: { actions: PanelAction[] }[]): PanelAction[] {
  const seen = new Set<string>();
  const actions: PanelAction[] = [];

  for (const page of pages) {
    for (const action of page.actions) {
      if (seen.has(action.outbound_action_id)) continue;
      seen.add(action.outbound_action_id);
      actions.push(action);
    }
  }

  return actions;
}

export function ActionQueueList({ organizationId, filters }: ActionQueueListProps) {
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useActionsQueue(organizationId, filters);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-label="Carregando fila">
        {[0, 1].map((item) => (
          <div key={item} className="panel-surface rounded-2xl p-5">
            <div className="mb-5 flex items-center justify-between gap-4">
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-6 w-28" />
            </div>
            <Skeleton className="mb-3 h-20 w-full" />
            <Skeleton className="mb-5 h-6 w-72 max-w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="panel-surface flex flex-col items-center gap-4 rounded-2xl px-6 py-14 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <RefreshCw className="size-5" />
        </div>
        <div>
          <p className="font-medium">Não foi possível carregar a fila</p>
          <p className="mt-1 text-sm text-muted-foreground">Confira sua conexão e tente novamente.</p>
        </div>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="size-3.5" />
          Tentar novamente
        </Button>
      </div>
    );
  }

  const pages = data?.pages ?? [];
  const actions = flattenUniqueActions(pages);
  const total = pages[0]?.pagination.total ?? actions.length;

  if (actions.length === 0) {
    return (
      <div className="panel-surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center">
        <div className="relative flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary">
          <Inbox className="size-6" />
          <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-card text-emerald-600 shadow-sm ring-1 ring-border">
            <CheckCircle2 className="size-3.5" />
          </span>
        </div>
        <div className="max-w-sm">
          <p className="font-heading text-lg font-semibold">Fila revisada por enquanto</p>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Não há ações pendentes com os filtros atuais. Novas sugestões elegíveis aparecem aqui automaticamente.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground">
          <strong className="font-semibold text-foreground">{total}</strong>{" "}
          {total === 1 ? "ação pendente" : "ações pendentes"}
          {actions.length < total && (
            <span className="ml-1">· {actions.length} carregadas</span>
          )}
        </p>
        <span className="text-xs text-muted-foreground">Atualização automática a cada 30s</span>
      </div>

      {actions.map((action) => (
        <ActionCard key={action.outbound_action_id} action={action} organizationId={organizationId} />
      ))}

      {hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? (
            <>
              <LoaderCircle className="size-3.5 animate-spin" />
              Carregando...
            </>
          ) : (
            "Carregar mais"
          )}
        </Button>
      )}
    </div>
  );
}
