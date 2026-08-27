import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionCard } from "@/components/queue/ActionCard";
import { useActionsQueue } from "@/hooks/useActionsQueue";
import type { PanelListActionsFilters } from "@/lib/api/types";

interface ActionQueueListProps {
  organizationId: string;
  filters: PanelListActionsFilters;
  onLoadMore: () => void;
}

export function ActionQueueList({
  organizationId,
  filters,
  onLoadMore,
}: ActionQueueListProps) {
  const { data, isLoading, isError, refetch } = useActionsQueue(organizationId, filters);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Não foi possível carregar a fila de revisão.
        </p>
        <Button variant="outline" onClick={() => refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const actions = data?.actions ?? [];

  if (actions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-12 text-center">
        <p className="text-sm font-medium">Nenhuma ação pendente de revisão no momento.</p>
        <p className="text-sm text-muted-foreground">
          Novas sugestões aparecem aqui automaticamente.
        </p>
      </div>
    );
  }

  const hasMore = data ? data.pagination.offset + actions.length < data.pagination.total : false;

  return (
    <div className="flex flex-col gap-3">
      {actions.map((action) => (
        <ActionCard key={action.outbound_action_id} action={action} organizationId={organizationId} />
      ))}
      {hasMore && (
        <Button variant="outline" onClick={onLoadMore}>
          Carregar mais
        </Button>
      )}
    </div>
  );
}
