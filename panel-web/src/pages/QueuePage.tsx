import { Sparkles } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { ActionFilters } from "@/components/queue/ActionFilters";
import { ActionQueueList } from "@/components/queue/ActionQueueList";
import { useOrganization } from "@/context/OrganizationProvider";
import type { PanelListActionsFilters } from "@/lib/api/types";

export function QueuePage() {
  const { organizationId } = useOrganization();
  const [filters, setFilters] = useState<PanelListActionsFilters>({});

  if (!organizationId) return null;

  function updateFilters(next: PanelListActionsFilters) {
    setFilters({
      intent: next.intent,
      commercial_potential: next.commercial_potential,
      action_type: next.action_type,
    });
  }

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Sparkles className="size-4" />
              <span className="text-xs font-semibold uppercase tracking-[0.14em]">
                Revisão humana
              </span>
            </div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Fila de respostas do Instagram
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Revise a sugestão da IA, ajuste o texto quando necessário e decida o que está pronto para seguir ao dispatcher.
            </p>
          </div>
          <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground sm:max-w-xs">
            <strong className="font-semibold text-foreground">Aprovar não envia imediatamente.</strong>{" "}
            O envio continua separado e controlado pelo dispatcher.
          </div>
        </section>

        <ActionFilters filters={filters} onChange={updateFilters} />
        <ActionQueueList organizationId={organizationId} filters={filters} />
      </div>
    </AppShell>
  );
}
