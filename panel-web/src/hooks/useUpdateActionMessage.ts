import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PanelApiError } from "@/lib/api/client";
import type { PanelListActionsResponse } from "@/lib/api/panelListActions";
import { updatePanelActionMessage } from "@/lib/api/panelUpdateActionMessage";

interface UpdateMessageVariables {
  outboundActionId: string;
  messageText: string;
}

function patchCachedMessage(
  data: PanelListActionsResponse | undefined,
  outboundActionId: string,
  messageText: string,
): PanelListActionsResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    actions: data.actions.map((action) =>
      action.outbound_action_id === outboundActionId
        ? { ...action, message_text: messageText }
        : action,
    ),
  };
}

export function useUpdateActionMessage(organizationId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ outboundActionId, messageText }: UpdateMessageVariables) => {
      if (!organizationId) throw new Error("No organization selected");
      return updatePanelActionMessage(outboundActionId, organizationId, messageText);
    },
    onSuccess: (updated, { outboundActionId }) => {
      toast.success("Mensagem atualizada.");
      queryClient.setQueriesData<PanelListActionsResponse>(
        { queryKey: ["panel-actions", organizationId] },
        (data) => patchCachedMessage(data, outboundActionId, updated.message_text),
      );
    },
    onError: (error) => {
      if (!(error instanceof PanelApiError)) {
        toast.error("Não foi possível salvar a edição. Tente novamente.");
        return;
      }
      if (error.status === 404) {
        toast.error("Este item não está mais disponível.");
        void queryClient.invalidateQueries({ queryKey: ["panel-actions", organizationId] });
      } else if (error.status === 409) {
        toast.error("Não é mais possível editar: esta ação já foi processada.");
        void queryClient.invalidateQueries({ queryKey: ["panel-actions", organizationId] });
      } else if (error.status === 403) {
        toast.error("Você não tem mais acesso a esta organização.");
      } else if (error.status !== 401) {
        toast.error("Não foi possível salvar a edição. Tente novamente.");
      }
    },
  });
}
