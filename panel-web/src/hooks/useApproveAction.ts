import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PanelApiError } from "@/lib/api/client";
import type { PanelListActionsResponse } from "@/lib/api/panelListActions";
import { approvePanelAction } from "@/lib/api/panelApproveAction";

function removeFromCachedQueue(
  data: PanelListActionsResponse | undefined,
  outboundActionId: string,
): PanelListActionsResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    actions: data.actions.filter((action) => action.outbound_action_id !== outboundActionId),
    pagination: { ...data.pagination, total: Math.max(0, data.pagination.total - 1) },
  };
}

export function useApproveAction(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (outboundActionId: string) => {
      if (!organizationId) throw new Error("No organization selected");
      return approvePanelAction(outboundActionId, organizationId);
    },
    onSuccess: (approval, outboundActionId) => {
      if (!approval.already_approved) {
        toast.success("Ação aprovada para envio. Removida da fila de revisão.");
      }
      queryClient.setQueriesData<PanelListActionsResponse>(
        { queryKey: ["panel-actions", organizationId] },
        (data) => removeFromCachedQueue(data, outboundActionId),
      );
    },
    onError: (error) => {
      if (!(error instanceof PanelApiError)) {
        toast.error("Não foi possível aprovar agora. Tente novamente.");
        return;
      }
      if (error.status === 404) {
        toast.error("Este item não está mais disponível.");
      } else if (error.status === 409) {
        toast.error(
          "Não foi possível aprovar: esta ação já não está mais disponível para aprovação (pode ter expirado ou mudado de estado).",
        );
      } else if (error.status === 403) {
        toast.error("Você não tem mais acesso a esta organização.");
      } else if (error.status !== 401) {
        toast.error("Não foi possível aprovar agora. Tente novamente.");
      }
      void queryClient.invalidateQueries({ queryKey: ["panel-actions", organizationId] });
    },
  });
}
