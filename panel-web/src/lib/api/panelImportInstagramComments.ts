import { callPanelFunction } from "@/lib/api/client";
import type {
  PanelHistoricalImportPagination,
  PanelHistoricalImportSummary,
} from "@/lib/api/types";

export interface PanelImportInstagramCommentsResponse {
  ok: true;
  media_id: string;
  summary: PanelHistoricalImportSummary;
  pagination: PanelHistoricalImportPagination;
}

export async function importPanelInstagramComments(
  organizationId: string,
  mediaId: string,
  after?: string | null,
  limit = 10,
): Promise<PanelImportInstagramCommentsResponse> {
  return callPanelFunction<PanelImportInstagramCommentsResponse>(
    "panel-import-instagram-comments",
    {
      method: "POST",
      body: {
        organization_id: organizationId,
        media_id: mediaId,
        limit,
        after: after ?? undefined,
      },
    },
  );
}
