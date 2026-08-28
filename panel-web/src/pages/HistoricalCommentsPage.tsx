import { History } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { HistoricalMediaList } from "@/components/historical/HistoricalMediaList";
import { useOrganization } from "@/context/OrganizationProvider";

export function HistoricalCommentsPage() {
  const { organizationId } = useOrganization();

  if (!organizationId) return null;

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-primary">
              <History className="size-4" />
              <span className="text-xs font-semibold uppercase tracking-[0.14em]">
                Importação controlada
              </span>
            </div>

            <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Comentários históricos
            </h1>

            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Selecione publicações próprias da conta conectada e importe
              comentários antigos para o mesmo pipeline de análise usado
              pelos eventos em tempo real.
            </p>
          </div>

          <div className="rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground sm:max-w-xs">
            <strong className="font-semibold text-foreground">
              Importar não envia respostas.
            </strong>{" "}
            Os comentários entram no processamento e qualquer ação
            permanece separada da aprovação e do dispatcher.
          </div>
        </section>

        <HistoricalMediaList organizationId={organizationId} />
      </div>
    </AppShell>
  );
}
