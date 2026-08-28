import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { PanelApiError } from "@/lib/api/client";
import {
  importPanelInstagramComments,
  type PanelImportInstagramCommentsResponse,
} from "@/lib/api/panelImportInstagramComments";

interface ImportHistoricalCommentsVariables {
  mediaId: string;
  after?: string | null;
}

export function useImportHistoricalComments(
  organizationId: string | null,
) {
  return useMutation<
    PanelImportInstagramCommentsResponse,
    Error,
    ImportHistoricalCommentsVariables
  >({
    mutationFn: ({ mediaId, after }) => {
      if (!organizationId) {
        throw new Error("No organization selected");
      }

      return importPanelInstagramComments(
        organizationId,
        mediaId,
        after,
        10,
      );
    },

    onError: (error) => {
      if (!(error instanceof PanelApiError)) {
        toast.error(
          "Não foi possível importar os comentários agora.",
        );
        return;
      }

      if (error.status === 403) {
        toast.error(
          error.code === "admin_required"
            ? "Somente administradores podem importar comentários históricos."
            : "Você não tem acesso a esta organização.",
        );
      } else if (error.status === 404) {
        toast.error(
          "Nenhuma conta ativa do Instagram foi encontrada.",
        );
      } else if (error.status === 409) {
        toast.error(
          "A conta conectada ao Instagram precisa ser revisada antes da importação.",
        );
      } else if (error.status === 502) {
        toast.error(
          "O Instagram não pôde ser consultado com segurança agora.",
        );
      } else if (error.status !== 401) {
        toast.error(
          "Não foi possível importar os comentários agora.",
        );
      }
    },
  });
}
