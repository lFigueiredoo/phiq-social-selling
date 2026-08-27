import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthProvider";
import { fetchPanelMe } from "@/lib/api/panelMe";

export function useMemberships() {
  const { session } = useAuth();

  return useQuery({
    queryKey: ["panel-me"],
    queryFn: fetchPanelMe,
    enabled: Boolean(session),
    staleTime: 60_000,
  });
}
