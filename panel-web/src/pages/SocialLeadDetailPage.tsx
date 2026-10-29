import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { Link, useParams } from "react-router";
import { SocialActionDialog, type SocialAction } from "@/components/social/SocialActionDialog";
import { SocialLeadCard } from "@/components/social/SocialLeadCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
import { socialCrmApi } from "@/lib/api/socialCrmApi";
import { actionLabel, ELIGIBILITY_LABELS, formatDate, percent,
  ROUTE_LABELS, SOURCE_LABELS, stageLabel, STATUS_LABELS } from "@/lib/api/socialCrmPresentation";
import type { SocialLeadRow, SocialTimelineEvent } from "@/lib/api/socialCrmTypes";
import { SocialLayout } from "./SocialSellingPage";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs font-medium text-muted-foreground">{label}</dt>
    <dd className="mt-1 break-words text-sm font-medium">{value ?? "—"}</dd></div>;
}

function TimelineItem({ event }: { event: SocialTimelineEvent }) {
  const info = event.info;
  let title = "Evento";
  let body: React.ReactNode = null;
  if (event.kind === "interaction") {
    title = `Interação · ${String(info.engagement_type ?? "social")}`;
    body = <><p>{typeof info.text === "string" && info.text ? info.text : "Texto não disponível"}</p>
      <p className="mt-1 text-xs text-muted-foreground">{typeof info.source === "string" ? SOURCE_LABELS[info.source as keyof typeof SOURCE_LABELS] : ""}
        {info.classification_status ? ` · Classificação: ${info.classification_status}` : ""}
        {info.error_code ? ` · ${info.error_code}` : ""}</p>
      {typeof info.media_permalink === "string" && info.media_permalink.startsWith("https://") &&
        <a href={info.media_permalink} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Abrir mídia <ExternalLink className="size-3" /></a>}
    </>;
  } else if (event.kind === "classification") {
    title = "Classificação";
    body = <p>Rota sugerida: {String(info.route_type ?? "—")} · Score: {String(info.lead_score ?? "—")}
      {info.confidence ? ` · Confiança: ${Math.round(Number(info.confidence) * 100)}%` : ""}
      <span className="block text-xs text-muted-foreground">{String(info.reason ?? "")}</span></p>;
  } else {
    title = event.kind === "manual_action" ? "Ação manual" : "Mudança de etapa";
    const details = info.details && typeof info.details === "object" ? info.details as Record<string, unknown> : {};
    body = <><p>{String(info.from_stage ?? "Início")} → {String(info.to_stage ?? "—")}</p>
      {info.from_status !== info.to_status && <p className="text-xs text-muted-foreground">Status: {String(info.from_status ?? "—")} → {String(info.to_status ?? "—")}</p>}
      {details.field === "owner_user_id" && <p className="text-xs text-muted-foreground">Responsável: {String(details.from ?? "Nenhum")} → {String(details.to ?? "Nenhum")}</p>}
      <p className="mt-1 text-xs text-muted-foreground">Motivo: {String(info.reason ?? "—")} · Origem: {String(info.source ?? "—")}</p></>;
  }
  return <li className="relative border-l-2 border-border pb-5 pl-5 last:pb-0">
    <span className="absolute -left-[5px] top-1 size-2 rounded-full bg-primary" />
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3>
      <time className="text-xs text-muted-foreground">{formatDate(event.at)}</time></div>
    <div className="mt-1 text-sm text-foreground">{body}</div>
  </li>;
}

export function SocialLeadDetailPage() {
  const { id } = useParams();
  const { organizationId } = useOrganization();
  const { data: memberships } = useMemberships();
  const [action, setAction] = useState<SocialAction | null>(null);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const leadQuery = useQuery({ queryKey: ["social-crm", organizationId, "lead", id],
    queryFn: () => socialCrmApi.getLead(organizationId!, id!), enabled: !!organizationId && !!id });
  const timelineQuery = useQuery({ queryKey: ["social-crm", organizationId, "timeline", id, timelineOffset],
    queryFn: () => socialCrmApi.getTimeline(organizationId!, id!, timelineOffset), enabled: !!organizationId && !!id });
  const membersQuery = useQuery({ queryKey: ["social-crm", organizationId, "members"],
    queryFn: () => socialCrmApi.getMembers(organizationId!), enabled: !!organizationId });
  const isAdmin = memberships?.memberships.some((item) => item.organization_id === organizationId && item.role === "admin") ?? false;
  const lead = leadQuery.data;
  return <SocialLayout title="Detalhe do lead" description="Identidade, qualificação, decisões comerciais e histórico em uma linha do tempo.">
    <Link to="/social-selling/leads" className="inline-flex items-center gap-2 text-sm text-primary hover:underline"><ArrowLeft className="size-4" /> Voltar aos leads</Link>
    {leadQuery.isPending ? <div className="panel-surface rounded-xl p-8 text-sm">Carregando lead…</div>
      : leadQuery.isError || !lead ? <div role="alert" className="panel-surface rounded-xl p-8 text-sm">
        Não foi possível carregar este lead. Confira sua permissão ou tente novamente.
        <Button variant="outline" className="ml-3" onClick={() => void leadQuery.refetch()}><RefreshCw className="size-4" /> Repetir</Button>
      </div> : <>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card><CardHeader><CardTitle>Identidade</CardTitle></CardHeader><CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Username" value={lead.username ? `@${lead.username}` : "—"} />
                <Field label="Nome" value={lead.display_name} />
                <Field label="ID externo" value={lead.external_user_id} />
                <Field label="Interações" value={lead.engagement_count} />
                <Field label="Primeira interação" value={formatDate(lead.first_seen_at)} />
                <Field label="Última interação" value={formatDate(lead.last_seen_at)} />
                <Field label="Origem recente" value={lead.last_source ? SOURCE_LABELS[lead.last_source] : "—"} />
                <Field label="Perfil" value={lead.profile_url?.startsWith("https://instagram.com/") || lead.profile_url?.startsWith("https://www.instagram.com/")
                  ? <a href={lead.profile_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Abrir Instagram</a> : "—"} />
              </dl>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Comercial</CardTitle></CardHeader><CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Funil central" value={lead.central_stage} />
                <Field label="Rota" value={lead.route_type ? ROUTE_LABELS[lead.route_type] : "Sem rota"} />
                <Field label="Etapa" value={stageLabel(lead.route_type, lead.central_stage, lead.vertical_stage)} />
                <Field label="Status" value={STATUS_LABELS[lead.status]} />
                <Field label="Score" value={lead.lead_score ?? "—"} />
                <Field label="Confiança" value={percent(lead.route_confidence)} />
                <Field label="Potencial" value={lead.commercial_potential ?? "—"} />
                <Field label="Intenção" value={lead.intent ?? "—"} />
                <Field label="Responsável" value={lead.owner_email ?? "Sem responsável"} />
                <Field label="Próxima ação" value={actionLabel(lead.recommended_next_action)} />
              </dl>
              {lead.route_type === "no_profile" && <p className="mt-4 rounded-lg bg-muted p-3 text-sm">Sem perfil comercial · aguardando novo sinal. Este lead não está perdido.</p>}
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Qualificação e classificação</CardTitle></CardHeader><CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Motivo da qualificação" value={lead.qualification_reason} />
                <Field label="Motivo da rota" value={lead.route_reason} />
                <Field label="Mais sinais" value={lead.needs_more_signal ? "Necessários" : "Não"} />
                <Field label="Classificador" value={lead.classifier_source ?? "—"} />
                <Field label="Versão do prompt" value={lead.prompt_version ?? "—"} />
                <Field label="Status recente" value={lead.classification_status ?? "—"} />
                <Field label="Erro seguro" value={lead.pipeline_error_code ?? "—"} />
                <Field label="Último processamento" value={formatDate(lead.pipeline_processed_at)} />
              </dl>
              {lead.classification_status === "failed_retryable" || lead.classification_status === "pending"
                ? <p className="mt-4 rounded-lg bg-muted p-3 text-xs">Pode ser reprocessado com segurança pelo worker. Nenhuma ação comercial é executada aqui.</p>
                : lead.classification_status === "failed_terminal"
                  ? <p className="mt-4 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">Falha final: precisa de revisão operacional.</p> : null}
              <div className="mt-4"><p className="text-xs font-medium text-muted-foreground">Sinais</p>
                <div className="mt-1 flex flex-wrap gap-1.5">{lead.signals.length ? lead.signals.map((signal) => <span key={signal} className="rounded bg-muted px-2 py-1 text-xs">{signal}</span>) : <span className="text-sm">—</span>}</div>
              </div>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Elegibilidade de contato</CardTitle></CardHeader><CardContent>
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Estado" value={ELIGIBILITY_LABELS[lead.contact_eligibility]} />
                <Field label="Motivo" value={lead.eligibility_reason ?? "—"} />
                <Field label="Verificada em" value={formatDate(lead.eligibility_checked_at)} />
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">Elegibilidade é independente de rota, score e ação recomendada.</p>
            </CardContent></Card>
          </div>
          <aside className="space-y-4">
            <SocialLeadCard lead={lead} />
            {isAdmin && <Card><CardHeader><CardTitle>Ações administrativas</CardTitle></CardHeader><CardContent className="grid gap-2">
              {lead.route_type && lead.route_type !== "no_profile" && lead.status === "active" && <>
                <Button variant="outline" onClick={() => setAction("transition")}>Avançar etapa</Button>
                <Button variant="outline" onClick={() => setAction("override")}>Override de etapa</Button>
              </>}
              <Button variant="outline" onClick={() => setAction("assign")}>Atribuir responsável</Button>
              {lead.central_stage === "routing" && lead.status !== "lost" && lead.status !== "cancelled" && lead.status !== "won"
                && <Button variant="outline" onClick={() => setAction("route")}>Reclassificar rota</Button>}
              <Button variant="outline" onClick={() => setAction("central")}>Alterar funil central</Button>
              <Button variant="outline" onClick={() => setAction("eligibility")}>Alterar elegibilidade</Button>
              {lead.status === "active" || lead.status === "awaiting_signal" || lead.status === "won"
                ? <Button variant="destructive" onClick={() => setAction("close")}>Encerrar oportunidade</Button>
                : <Button onClick={() => setAction("reopen")}>Reabrir oportunidade</Button>}
            </CardContent></Card>}
            {!isAdmin && <p className="text-xs text-muted-foreground">Sua permissão é de leitura nesta área.</p>}
          </aside>
        </div>
        <Card><CardHeader><CardTitle>Linha do tempo</CardTitle></CardHeader><CardContent>
          {timelineQuery.isPending ? <p className="text-sm text-muted-foreground">Carregando histórico…</p>
            : timelineQuery.isError ? <div role="alert" className="text-sm">Não foi possível carregar o histórico.
              <Button variant="outline" className="ml-2" onClick={() => void timelineQuery.refetch()}>Tentar novamente</Button></div>
            : timelineQuery.data.events.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum evento nesta página.</p>
            : <ol className="ml-2">{timelineQuery.data.events.map((event) => <TimelineItem key={`${event.kind}-${event.id}`} event={event} />)}</ol>}
          {timelineQuery.data && timelineQuery.data.total > 50 && <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>{timelineOffset + 1}–{Math.min(timelineOffset + timelineQuery.data.events.length, timelineQuery.data.total)} de {timelineQuery.data.total}</span>
            <div className="flex gap-2"><Button size="sm" variant="outline" disabled={timelineOffset === 0}
              onClick={() => setTimelineOffset(Math.max(0, timelineOffset - 50))}>Mais recentes</Button>
              <Button size="sm" variant="outline" disabled={timelineOffset + 50 >= timelineQuery.data.total}
                onClick={() => setTimelineOffset(timelineOffset + 50)}>Mais antigos</Button></div>
          </div>}
        </CardContent></Card>
        <SocialActionDialog key={`${lead.id}:${action ?? "closed"}`} open={!!action} action={action} lead={lead} members={membersQuery.data ?? []}
          organizationId={organizationId!} onClose={() => setAction(null)}
          onSaved={(_updated: SocialLeadRow) => { setTimelineOffset(0); void leadQuery.refetch(); void timelineQuery.refetch(); }} />
      </>}
  </SocialLayout>;
}
