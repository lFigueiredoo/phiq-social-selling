import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PanelApiError } from "@/lib/api/client";
import type { PanelListActionsResponse } from "@/lib/api/panelListActions";
import { rejectPanelAction } from "@/lib/api/panelRejectAction";

interface RejectVariables {
  outboundActionId: string;
  reason?: string | null;
}

function removeFromCachedQueue(
  data: InfiniteData<PanelListActionsResponse> | undefined,
  outboundActionId: string,
): InfiniteData<PanelListActionsResponse> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      actions: page.actions.filter((action) => action.outbound_action_id !== outboundActionId),
      pagination: { ...page.pagination, total: Math.max(0, page.pagination.total - 1) },
    })),
  };
}

export function useRejectAction(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ outboundActionId, reason }: RejectVariables) => {
      if (!organizationId) throw new Error("No organization selected");
      return rejectPanelAction(outboundActionId, organizationId, reason);
    },
    onSuccess: (rejection, { outboundActionId }) => {
      if (!rejection.already_rejected) {
        toast.success("Ação rejeitada.");
      }
      queryClient.setQueriesData<InfiniteData<PanelListActionsResponse>>(
        { queryKey: ["panel-actions", organizationId] },
        (data) => removeFromCachedQueue(data, outboundActionId),
      );
      void queryClient.invalidateQueries({ queryKey: ["panel-actions", organizationId] });
    },
    onError: (error) => {
      if (!(error instanceof PanelApiError)) {
        toast.error("Não foi possível rejeitar agora. Tente novamente.");
        return;
      }
      if (error.status === 404) {
        toast.error("Este item não está mais disponível.");
      } else if (error.status === 409) {
        toast.error("Não foi possível rejeitar: este item já foi processado.");
      } else if (error.status === 403) {
        toast.error("Você não tem mais acesso a esta organização.");
      } else if (error.status !== 401) {
        toast.error("Não foi possível rejeitar agora. Tente novamente.");
      }
      void queryClient.invalidateQueries({ queryKey: ["panel-actions", organizationId] });
    },
  });
}
