import { callPanelFunction } from "@/lib/api/client";
import type {
  PanelInstagramMedia,
  PanelInstagramMediaPagination,
} from "@/lib/api/types";

export interface PanelListInstagramMediaResponse {
  ok: true;
  instagram_account: {
    username: string | null;
  };
  pagination: PanelInstagramMediaPagination;
  media: PanelInstagramMedia[];
}

export async function fetchPanelInstagramMedia(
  organizationId: string,
  after?: string | null,
  limit = 25,
): Promise<PanelListInstagramMediaResponse> {
  return callPanelFunction<PanelListInstagramMediaResponse>(
    "panel-list-instagram-media",
    {
      method: "GET",
      query: {
        organization_id: organizationId,
        limit,
        after: after ?? undefined,
      },
    },
  );
}
