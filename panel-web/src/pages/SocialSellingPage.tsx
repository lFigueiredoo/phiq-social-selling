import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Columns3, History, ListFilter, RefreshCw, Users } from "lucide-react";
import { Link, NavLink, useSearchParams } from "react-router";
import { AppShell } from "@/components/layout/AppShell";
import { SocialLeadCard } from "@/components/social/SocialLeadCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
import { socialCrmApi, type SocialFilters, type SocialSort } from "@/lib/api/socialCrmApi";
import { actionLabel, CENTRAL_LABELS, ELIGIBILITY_LABELS, formatDate, percent,
  ROUTE_LABELS, SOURCE_LABELS, stageLabel, STATUS_LABELS } from "@/lib/api/socialCrmPresentation";
import { getVerticalStages, type CentralStage, type CommercialRoute,
  type SocialDashboard, type SocialLeadRow } from "@/lib/api/socialCrmTypes";

const inputClass = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm";

function SocialNav() {
  const { organizationId } = useOrganization();
  const { data } = useMemberships();
  const isAdmin = data?.memberships.some((item) => item.organization_id === organizationId && item.role === "admin");
  const links = [
    ["/social-selling", "Visão geral"], ["/social-selling/leads", "Leads"],
    ["/social-selling/funil", "Funis"],
  ];
  return <nav aria-label="Navegação do Social Selling" className="flex flex-wrap gap-2">
    {links.map(([to, label]) => <NavLink key={to} to={to} end
      className={({ isActive }) => `rounded-lg border px-3 py-2 text-sm font-medium ${isActive
        ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}>
      {label}
    </NavLink>)}
    {isAdmin && <Link to="/historico" className="inline-flex items-center gap-1 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
      <History className="size-4" /> Importar histórico
    </Link>}
  </nav>;
}

export function SocialLayout({ children, title, description }: { children: React.ReactNode; title: string; description: string }) {
  return <AppShell><div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="panel-eyebrow">Operação comercial</p>
        <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p></div>
      <Badge variant="outline">Outbound desativado nesta área</Badge>
    </div>
    <SocialNav />
    {children}
  </div></AppShell>;
}

function LoadState({ error, retry }: { error?: boolean; retry?: () => void }) {
  if (error) return <div role="alert" className="panel-surface rounded-xl p-8 text-center">
    <p className="font-medium">Não foi possível carregar os dados.</p>
    <Button variant="outline" className="mt-3" onClick={retry}><RefreshCw className="size-4" /> Tentar novamente</Button>
  </div>;
  return <div aria-label="Carregando Social Selling" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-28 rounded-xl" />)}
  </div>;
}

const KPI_ITEMS: { key: keyof SocialDashboard["kpis"]; label: string; filter?: string }[] = [
  { key: "active", label: "Leads ativos", filter: "status=active" },
  { key: "new_leads", label: "Novos leads", filter: "central_stage=new_lead" },
  { key: "qualification", label: "Em qualificação", filter: "central_stage=qualification" },
  { key: "routed", label: "Direcionados" },
  { key: "no_profile", label: "Sem perfil", filter: "route=no_profile" },
  { key: "franchise", label: "Franquia", filter: "route=franchise" },
  { key: "q3", label: "Q3", filter: "route=q3" },
  { key: "hotmart", label: "Hotmart", filter: "route=hotmart" },
  { key: "nuy", label: "Nuy", filter: "route=nuy" },
  { key: "won", label: "Ganhos", filter: "status=won" },
  { key: "lost", label: "Perdidos", filter: "status=lost" },
  { key: "awaiting_signal", label: "Aguardando sinal", filter: "status=awaiting_signal" },
];

export function SocialOverviewPage() {
  const { organizationId } = useOrganization();
  const query = useQuery({ queryKey: ["social-crm", organizationId, "dashboard"],
    queryFn: () => socialCrmApi.getDashboard(organizationId!), enabled: !!organizationId });
  return <SocialLayout title="Social Selling" description="Acompanhe contatos, qualificação e oportunidades em todos os funis.">
    {query.isPending ? <LoadState /> : query.isError ? <LoadState error retry={() => void query.refetch()} /> : <>
      <section aria-label="Indicadores" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {KPI_ITEMS.map((item) => <Link key={item.key} to={`/social-selling/leads${item.filter ? `?${item.filter}` : ""}`}
          className="panel-surface rounded-xl border p-4 transition hover:border-primary/50 hover:shadow-sm">
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <p className="mt-2 font-heading text-3xl font-semibold">{query.data.kpis[item.key]}</p>
        </Link>)}
      </section>
      <section className="grid gap-4 lg:grid-cols-3">
        <Card><CardHeader><CardTitle className="text-base">Interações recentes</CardTitle></CardHeader><CardContent className="space-y-3">
          {query.data.recent_interactions.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma interação registrada.</p>
            : query.data.recent_interactions.map((item) => <Link key={item.id} to={`/social-selling/lead/${item.id}`}
              className="block rounded-lg border p-3 text-sm hover:border-primary/40">
              <strong>{item.username ? `@${item.username}` : item.display_name ?? "Contato"}</strong>
              <p className="mt-1 text-xs text-muted-foreground">{item.last_source ? SOURCE_LABELS[item.last_source] : "—"} · {formatDate(item.last_interaction_at)}</p>
            </Link>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Sem responsável · {query.data.kpis.unassigned}</CardTitle></CardHeader><CardContent className="space-y-3">
          {query.data.unassigned_leads.length === 0 ? <p className="text-sm text-muted-foreground">Todos os leads ativos têm responsável.</p>
            : query.data.unassigned_leads.map((item) => <Link key={item.id} to={`/social-selling/lead/${item.id}`}
              className="block rounded-lg border p-3 text-sm hover:border-primary/40">{item.username ? `@${item.username}` : item.display_name ?? "Contato"}
              <span className="ml-2 text-xs text-muted-foreground">{item.route_type ? ROUTE_LABELS[item.route_type] : "Sem rota"}</span></Link>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Classificação pendente · {query.data.kpis.classification_pending}</CardTitle></CardHeader><CardContent className="space-y-3">
          {query.data.pending_leads.length === 0 ? <p className="text-sm text-muted-foreground">Sem classificações pendentes.</p>
            : query.data.pending_leads.map((item) => <Link key={item.id} to={`/social-selling/lead/${item.id}`}
              className="block rounded-lg border p-3 text-sm hover:border-primary/40">
              <strong>{item.username ? `@${item.username}` : item.display_name ?? "Contato"}</strong>
              <p className="mt-1 text-xs text-muted-foreground">{item.classification_status} {item.pipeline_error_code ? `· ${item.pipeline_error_code}` : ""}</p>
            </Link>)}
        </CardContent></Card>
      </section>
      <div className="flex flex-wrap gap-3">
        <Link to="/social-selling/leads?unassigned=true" className="text-sm font-medium text-primary hover:underline">Ver leads sem responsável <ArrowRight className="inline size-4" /></Link>
        <Link to="/social-selling/leads?classification_status=failed_retryable" className="text-sm font-medium text-primary hover:underline">Ver falhas temporárias <ArrowRight className="inline size-4" /></Link>
        <Link to="/social-selling/leads?sort=priority" className="text-sm font-medium text-primary hover:underline">Oportunidades que precisam de ação <ArrowRight className="inline size-4" /></Link>
      </div>
    </>}
  </SocialLayout>;
}

const FILTER_KEYS: (keyof SocialFilters)[] = ["route", "central_stage", "vertical_stage", "status", "owner",
  "source", "eligibility", "classification_status", "score_min", "confidence_min", "needs_more_signal",
  "unassigned", "from", "to", "search"];

function initialFilters(params: URLSearchParams): SocialFilters {
  const filters: SocialFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value === null || value === "") continue;
    if (key === "score_min" || key === "confidence_min") Object.assign(filters, { [key]: Number(value) });
    else if (key === "unassigned" || key === "needs_more_signal") Object.assign(filters, { [key]: value === "true" });
    else Object.assign(filters, { [key]: value });
  }
  return filters;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string;
  options: [string, string][]; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-xs font-medium text-muted-foreground">{label}
    <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Todos</option>{options.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
    </select>
  </label>;
}

export function SocialLeadsPage() {
  const { organizationId } = useOrganization();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<SocialFilters>(() => initialFilters(params));
  const filters = initialFilters(params);
  const sort = (params.get("sort") ?? "recent") as SocialSort;
  const offset = Number(params.get("offset") ?? 0) || 0;
  const query = useQuery({ queryKey: ["social-crm", organizationId, "leads", params.toString()],
    queryFn: () => socialCrmApi.getLeads(organizationId!, filters, sort, offset), enabled: !!organizationId });
  const members = useQuery({ queryKey: ["social-crm", organizationId, "members"],
    queryFn: () => socialCrmApi.getMembers(organizationId!), enabled: !!organizationId });
  function applyFilters() {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value !== "" && value !== undefined && value !== false)
      next.set(key, String(value));
    next.set("sort", sort);
    setParams(next);
  }
  const field = (key: keyof SocialFilters, value: string) => setDraft((old) => ({ ...old, [key]: value || undefined }));
  return <SocialLayout title="Leads" description="Consulte oportunidades reais, aplique filtros no servidor e abra o histórico de cada lead.">
    <section className="panel-surface space-y-4 rounded-xl border p-4" aria-label="Filtros de leads">
      <div className="flex items-center gap-2 text-sm font-semibold"><ListFilter className="size-4" /> Filtros</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Buscar username ou nome
          <Input value={draft.search ?? ""} onChange={(event) => field("search", event.target.value)} placeholder="@contato" />
        </label>
        <FilterSelect label="Rota" value={draft.route ?? ""} options={Object.entries(ROUTE_LABELS)} onChange={(v) => field("route", v)} />
        <FilterSelect label="Etapa central" value={draft.central_stage ?? ""} options={Object.entries(CENTRAL_LABELS)} onChange={(v) => field("central_stage", v)} />
        <FilterSelect label="Status" value={draft.status ?? ""} options={Object.entries(STATUS_LABELS)} onChange={(v) => field("status", v)} />
        <FilterSelect label="Origem" value={draft.source ?? ""} options={Object.entries(SOURCE_LABELS)} onChange={(v) => field("source", v)} />
        <FilterSelect label="Elegibilidade" value={draft.eligibility ?? ""} options={Object.entries(ELIGIBILITY_LABELS)} onChange={(v) => field("eligibility", v)} />
        <FilterSelect label="Classificação" value={draft.classification_status ?? ""} options={[
          ["pending", "Pendente"], ["completed", "Concluída"], ["failed_retryable", "Falha temporária"],
          ["failed_terminal", "Falha final"], ["not_required", "Não necessária"]]}
          onChange={(v) => field("classification_status", v)} />
        <FilterSelect label="Responsável" value={draft.owner ?? ""}
          options={(members.data ?? []).map((item) => [item.user_id, item.email ?? item.user_id])}
          onChange={(v) => field("owner", v)} />
        <FilterSelect label="Etapa vertical" value={draft.vertical_stage ?? ""}
          options={Array.from(new Map(
            (["franchise", "q3", "hotmart", "nuy"] as CommercialRoute[])
              .flatMap((route) => getVerticalStages(route).map((stage) => [stage.stage, stage.label] as [string, string]))
          ).entries())} onChange={(v) => field("vertical_stage", v)} />
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Score mínimo
          <Input type="number" min={0} max={100} value={draft.score_min ?? ""}
            onChange={(event) => setDraft((old) => ({ ...old, score_min: event.target.value === "" ? undefined : Number(event.target.value) }))} />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Confiança mínima (0–1)
          <Input type="number" min={0} max={1} step={0.05} value={draft.confidence_min ?? ""}
            onChange={(event) => setDraft((old) => ({ ...old, confidence_min: event.target.value === "" ? undefined : Number(event.target.value) }))} />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Desde
          <Input type="date" value={draft.from?.slice(0, 10) ?? ""}
            onChange={(event) => field("from", event.target.value ? `${event.target.value}T00:00:00Z` : "")} />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">Até
          <Input type="date" value={draft.to?.slice(0, 10) ?? ""}
            onChange={(event) => field("to", event.target.value ? `${event.target.value}T23:59:59Z` : "")} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!draft.unassigned}
          onChange={(event) => setDraft((old) => ({ ...old, unassigned: event.target.checked }))} /> Sem responsável</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!draft.needs_more_signal}
          onChange={(event) => setDraft((old) => ({ ...old, needs_more_signal: event.target.checked }))} /> Aguardando mais sinais</label>
        <Button size="sm" onClick={applyFilters}>Aplicar filtros</Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft({}); setParams(new URLSearchParams()); }}>Limpar</Button>
      </div>
    </section>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{query.data?.total ?? 0} leads encontrados</p>
      <label className="flex items-center gap-2 text-sm">Ordenar por
        <select className={inputClass} value={sort} onChange={(event) => {
          const next = new URLSearchParams(params); next.set("sort", event.target.value); next.delete("offset"); setParams(next);
        }}>
          <option value="recent">Última interação</option><option value="score">Score</option>
          <option value="confidence">Confiança</option><option value="created">Criação</option>
          <option value="priority">Prioridade</option>
        </select>
      </label>
    </div>
    {query.isPending ? <LoadState /> : query.isError ? <LoadState error retry={() => void query.refetch()} />
      : query.data.leads.length === 0 ? <div className="panel-surface rounded-xl p-10 text-center text-sm text-muted-foreground">Nenhum lead corresponde aos filtros.</div>
      : <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full min-w-[1020px] text-left text-xs">
        <thead className="border-b bg-muted/50 text-muted-foreground"><tr>
          {(["Lead", "Rota / etapa", "Score", "Confiança", "Status", "Responsável", "Origem", "Última interação", "Próxima ação"])
            .map((name) => <th key={name} scope="col" className="px-4 py-3 font-semibold">{name}</th>)}
        </tr></thead><tbody>{query.data.leads.map((lead: SocialLeadRow) => <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/30">
          <td className="px-4 py-3"><Link className="font-medium text-primary hover:underline" to={`/social-selling/lead/${lead.id}`}>
            {lead.username ? `@${lead.username}` : lead.display_name ?? "Contato"}</Link>
            {lead.display_name && lead.username && <span className="block text-muted-foreground">{lead.display_name}</span>}</td>
          <td className="px-4 py-3">{lead.route_type ? ROUTE_LABELS[lead.route_type] : "Sem rota"}<span className="block text-muted-foreground">{stageLabel(lead.route_type, lead.central_stage, lead.vertical_stage)}</span></td>
          <td className="px-4 py-3">{lead.lead_score ?? "—"}</td><td className="px-4 py-3">{percent(lead.route_confidence)}</td>
          <td className="px-4 py-3"><Badge variant="outline">{STATUS_LABELS[lead.status]}</Badge>
            {lead.classification_status === "failed_retryable" && <span className="block text-destructive">Falha temporária</span>}</td>
          <td className="px-4 py-3">{lead.owner_email ?? "Sem responsável"}</td>
          <td className="px-4 py-3">{lead.last_source ? SOURCE_LABELS[lead.last_source] : "—"}</td>
          <td className="px-4 py-3">{formatDate(lead.last_interaction_at)}</td>
          <td className="px-4 py-3">{actionLabel(lead.recommended_next_action)}</td>
        </tr>)}</tbody></table></div>}
    {query.data && query.data.total > 0 && <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>Exibindo {offset + 1}–{Math.min(offset + query.data.leads.length, query.data.total)} de {query.data.total}</span>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => {
        const next = new URLSearchParams(params); next.set("offset", String(Math.max(0, offset - 25))); setParams(next);
      }}>Anterior</Button><Button variant="outline" size="sm" disabled={offset + 25 >= query.data.total} onClick={() => {
        const next = new URLSearchParams(params); next.set("offset", String(offset + 25)); setParams(next);
      }}>Próxima</Button></div>
    </div>}
  </SocialLayout>;
}

export function SocialFunnelPage() {
  const { organizationId } = useOrganization();
  const [params, setParams] = useSearchParams();
  const requestedRoute = params.get("route") ?? "central";
  const route = ["central", "franchise", "q3", "hotmart", "nuy"].includes(requestedRoute)
    ? requestedRoute : "central";
  const commercial = route !== "central" ? route as CommercialRoute : null;
  const query = useQuery({ queryKey: ["social-crm", organizationId, "board", route],
    queryFn: () => socialCrmApi.getLeads(organizationId!, commercial ? { route: commercial } : {}, "recent", 0, 100),
    enabled: !!organizationId });
  const stages = commercial ? getVerticalStages(commercial).map((item) => [item.stage, item.label] as const)
    : Object.entries(CENTRAL_LABELS) as [CentralStage, string][];
  return <SocialLayout title="Funis" description="Visualize as etapas centrais e os quatro caminhos comerciais. Alterações são feitas no detalhe do lead.">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Selecionar funil">
      {["central", "franchise", "q3", "hotmart", "nuy"].map((item) => <Button key={item} size="sm"
        variant={route === item ? "default" : "outline"} onClick={() => setParams(item === "central" ? {} : { route: item })}>
        {item === "central" ? "Funil Central" : ROUTE_LABELS[item as CommercialRoute]}
      </Button>)}
    </div>
    {query.isPending ? <LoadState /> : query.isError ? <LoadState error retry={() => void query.refetch()} /> : <>
      <p className="text-xs text-muted-foreground">Mostrando até 100 leads mais recentes de {query.data.total}. Use a lista para consultar todos os resultados.</p>
      <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Quadro de etapas">
        {stages.map(([stage, label]) => {
          const leads = query.data.leads.filter((lead) => commercial ? lead.vertical_stage === stage : lead.central_stage === stage);
          const target = new URLSearchParams(commercial ? { route: commercial, vertical_stage: stage } : { central_stage: stage });
          return <section key={stage} className="w-72 shrink-0 rounded-xl border bg-muted/35 p-3 sm:w-80" aria-label={label}>
            <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{label}</h2>
              <Badge variant="secondary">{leads.length} exibidos</Badge></div>
            <div className="space-y-3">{leads.length ? leads.map((lead) => <SocialLeadCard key={lead.id} lead={lead} compact />)
              : <p className="rounded-lg border border-dashed bg-card p-4 text-xs text-muted-foreground">Nenhum lead nesta etapa entre os exibidos.</p>}</div>
            <Link to={`/social-selling/leads?${target}`} className="mt-3 block text-xs font-medium text-primary hover:underline">Ver todos nesta etapa →</Link>
          </section>;
        })}
      </div>
    </>}
    <div className="flex gap-4 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Columns3 className="size-4" /> Etapas controladas no banco</span>
      <span className="inline-flex items-center gap-1"><Activity className="size-4" /> Sem arrastar cards</span>
      <span className="inline-flex items-center gap-1"><Users className="size-4" /> Responsáveis no detalhe</span></div>
  </SocialLayout>;
}
