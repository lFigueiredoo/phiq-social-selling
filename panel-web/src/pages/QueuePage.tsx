import { History, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { HistoricalTabs } from "@/components/historical/HistoricalTabs";
import { AppShell } from "@/components/layout/AppShell";
import { ActionFilters } from "@/components/queue/ActionFilters";
import { ActionQueueList } from "@/components/queue/ActionQueueList";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
import type { ActionSource, PanelListActionsFilters } from "@/lib/api/types";

interface ApprovalQueuePageProps {
  source: ActionSource;
  historical?: boolean;
}

function ApprovalQueuePage({ source, historical = false }: ApprovalQueuePageProps) {
  const { organizationId } = useOrganization();
  const { data: membershipData } = useMemberships();
  const [filters, setFilters] = useState<PanelListActionsFilters>({ source });
  const automaticDispatchEnabled =
    membershipData?.dispatch?.automatic_dispatch_enabled === true;

  if (!organizationId) return null;

  function updateFilters(next: PanelListActionsFilters) {
    setFilters({
      source,
      intent: next.intent,
      commercial_potential: next.commercial_potential,
      action_type: next.action_type,
    });
  }

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        {historical && <HistoricalTabs />}

        <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-primary">
              {historical ? <History className="size-4" /> : <Sparkles className="size-4" />}
              <span className="text-xs font-semibold uppercase tracking-[0.14em]">
                {historical ? "Revisão do acervo" : "Eventos em tempo real"}
              </span>
            </div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              {historical
                ? "Respostas para comentários históricos"
                : "Comentários novos"}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              {historical
                ? "Revise separadamente as respostas públicas sugeridas para comentários importados. Comentários históricos não iniciam Direct automático."
                : "Revise a sugestão da IA, ajuste o texto quando necessário e decida o que está pronto para seguir ao dispatcher."}
            </p>
          </div>
          <div
            className={automaticDispatchEnabled
              ? "rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100 sm:max-w-xs"
              : "rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100 sm:max-w-xs"}
          >
            <strong className="flex items-center gap-1.5 font-semibold">
              {automaticDispatchEnabled
                ? <ShieldAlert className="size-3.5" />
                : <ShieldCheck className="size-3.5" />}
              {automaticDispatchEnabled ? "Envio automático ativo" : "Modo seguro: envio bloqueado"}
            </strong>
            <span className="mt-1 block">
              {automaticDispatchEnabled
                ? "Aprovar libera o dispatcher, que pode tentar o envio automaticamente em até 1 minuto."
                : "Aprovar registra a decisão, mas o dispatcher não pode chamar o Instagram."}
            </span>
          </div>
        </section>

        <ActionFilters filters={filters} onChange={updateFilters} />
        <ActionQueueList organizationId={organizationId} filters={filters} />
      </div>
    </AppShell>
  );
}

export function QueuePage() {
  return <ApprovalQueuePage source="realtime" />;
}

export function HistoricalQueuePage() {
  return <ApprovalQueuePage source="historical_backfill" historical />;
}
