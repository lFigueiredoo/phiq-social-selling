import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { PanelApiError } from "@/lib/api/client";
import { supabase } from "@/lib/supabase";

// A 401 from any panel-* call means the session is gone/invalid — this
// reaction is identical everywhere, so it's handled once, globally.
// Everything else (403/404/409 contextual messaging) is handled locally in
// each hook, where the specific action being performed is known.
function handleGlobalApiError(error: unknown) {
  if (error instanceof PanelApiError && error.status === 401) {
    void supabase.auth.signOut();
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
  queryCache: new QueryCache({ onError: handleGlobalApiError }),
  mutationCache: new MutationCache({ onError: handleGlobalApiError }),
});
