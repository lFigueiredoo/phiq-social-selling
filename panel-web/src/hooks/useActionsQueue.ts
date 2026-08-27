import { useQuery } from "@tanstack/react-query";
import { fetchPanelActions } from "@/lib/api/panelListActions";
import type { PanelListActionsFilters } from "@/lib/api/types";

export function useActionsQueue(
  organizationId: string | null,
  filters: PanelListActionsFilters,
) {
  return useQuery({
    queryKey: ["panel-actions", organizationId, filters],
    queryFn: () => fetchPanelActions(organizationId as string, filters),
    enabled: Boolean(organizationId),
    // Rows can silently drop out of the queue (private_reply expiry, or
    // another reviewer acting on it) with no error — poll so the list
    // stays accurate without the reviewer needing to manually refresh.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}
