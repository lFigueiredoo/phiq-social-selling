import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchPanelActions } from "@/lib/api/panelListActions";
import type { PanelListActionsFilters } from "@/lib/api/types";

const PAGE_SIZE = 25;

export function useActionsQueue(
  organizationId: string | null,
  filters: PanelListActionsFilters,
) {
  return useInfiniteQuery({
    queryKey: ["panel-actions", organizationId, filters],
    queryFn: ({ pageParam }) =>
      fetchPanelActions(organizationId as string, {
        ...filters,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.pagination.offset + lastPage.pagination.limit;
      return nextOffset < lastPage.pagination.total ? nextOffset : undefined;
    },
    enabled: Boolean(organizationId),
    // Rows can silently drop out of the queue (private_reply expiry, or
    // another reviewer acting on it) with no error — poll so the list
    // stays accurate without the reviewer needing to manually refresh.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}
