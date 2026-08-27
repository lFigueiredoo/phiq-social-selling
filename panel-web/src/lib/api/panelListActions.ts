import { callPanelFunction } from "@/lib/api/client";
import type {
  PanelAction,
  PanelListActionsFilters,
  PanelPagination,
} from "@/lib/api/types";

export interface PanelListActionsResponse {
  ok: true;
  pagination: PanelPagination;
  actions: PanelAction[];
}

export async function fetchPanelActions(
  organizationId: string,
  filters: PanelListActionsFilters = {},
): Promise<PanelListActionsResponse> {
  return callPanelFunction<PanelListActionsResponse>("panel-list-actions", {
    method: "GET",
    query: {
      organization_id: organizationId,
      intent: filters.intent,
      commercial_potential: filters.commercial_potential,
      action_type: filters.action_type,
      limit: filters.limit,
      offset: filters.offset,
    },
  });
}
