import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchPanelInstagramMedia } from "@/lib/api/panelListInstagramMedia";

const MEDIA_PAGE_SIZE = 25;

export function useInstagramMedia(organizationId: string | null) {
  return useInfiniteQuery({
    queryKey: ["panel-instagram-media", organizationId],
    queryFn: ({ pageParam }) =>
      fetchPanelInstagramMedia(
        organizationId as string,
        pageParam,
        MEDIA_PAGE_SIZE,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.has_more
        ? lastPage.pagination.after
        : undefined,
    enabled: Boolean(organizationId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
