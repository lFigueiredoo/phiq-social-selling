import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import type { SocialLeadRow } from "@/lib/api/socialCrmTypes";
import { actionLabel, ELIGIBILITY_LABELS, formatDate, percent,
  ROUTE_LABELS, SOURCE_LABELS, stageLabel, STATUS_LABELS } from "@/lib/api/socialCrmPresentation";

export function SocialLeadCard({ lead, compact = false }: { lead: SocialLeadRow; compact?: boolean }) {
  const name = lead.username ? `@${lead.username}` : lead.display_name || "Contato sem username";
  return (
    <article className="panel-surface rounded-xl border p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/social-selling/lead/${lead.id}`} className="font-semibold text-foreground hover:text-primary hover:underline">
            {name}
          </Link>
          {lead.display_name && lead.username && <p className="truncate text-xs text-muted-foreground">{lead.display_name}</p>}
        </div>
        <Badge variant="outline">{STATUS_LABELS[lead.status]}</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge variant="secondary">{lead.route_type ? ROUTE_LABELS[lead.route_type] : "Sem rota"}</Badge>
        {lead.last_source && <Badge variant="outline">{SOURCE_LABELS[lead.last_source]}</Badge>}
        {lead.classification_status === "pending" && <Badge variant="outline">Classificação pendente</Badge>}
        {lead.classification_status === "failed_retryable" && <Badge variant="destructive">Falha temporária</Badge>}
        {lead.classification_status === "failed_terminal" && <Badge variant="destructive">Falha final</Badge>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div><dt className="text-muted-foreground">Etapa</dt><dd className="font-medium">{stageLabel(lead.route_type, lead.central_stage, lead.vertical_stage)}</dd></div>
        <div><dt className="text-muted-foreground">Score · confiança</dt><dd className="font-medium">{lead.lead_score ?? "—"} · {percent(lead.route_confidence)}</dd></div>
        {!compact && <>
          <div><dt className="text-muted-foreground">Responsável</dt><dd className="truncate font-medium">{lead.owner_email ?? "Sem responsável"}</dd></div>
          <div><dt className="text-muted-foreground">Elegibilidade</dt><dd className="font-medium">{ELIGIBILITY_LABELS[lead.contact_eligibility]}</dd></div>
        </>}
      </dl>
      <p className="mt-3 border-t pt-2 text-xs"><span className="text-muted-foreground">Próxima ação:</span> {actionLabel(lead.recommended_next_action)}</p>
      <p className="mt-1 text-xs text-muted-foreground">Última interação: {formatDate(lead.last_interaction_at)}</p>
    </article>
  );
}
