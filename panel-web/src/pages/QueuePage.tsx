import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { ActionFilters } from "@/components/queue/ActionFilters";
import { ActionQueueList } from "@/components/queue/ActionQueueList";
import { useOrganization } from "@/context/OrganizationProvider";
import type { PanelListActionsFilters } from "@/lib/api/types";

const PAGE_SIZE = 25;

export function QueuePage() {
  const { organizationId } = useOrganization();
  const [filters, setFilters] = useState<PanelListActionsFilters>({
    limit: PAGE_SIZE,
    offset: 0,
  });

  if (!organizationId) return null;

  function updateFilters(next: PanelListActionsFilters) {
    setFilters({ ...next, limit: PAGE_SIZE, offset: 0 });
  }

  function loadMore() {
    setFilters((prev) => ({ ...prev, offset: (prev.offset ?? 0) + PAGE_SIZE }));
  }

  return (
    <AppShell>
      <div className="flex flex-col gap-4">
        <ActionFilters filters={filters} onChange={updateFilters} />
        <ActionQueueList
          organizationId={organizationId}
          filters={filters}
          onLoadMore={loadMore}
        />
      </div>
    </AppShell>
  );
}
