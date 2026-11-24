import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Bot, CheckCircle2, Database, Plus, Save, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/context/OrganizationProvider";
import type { CatalogOffer } from "@/lib/api/conversationsApi";
import { socialOperationsApi, type SocialSettings } from "@/lib/api/socialOperationsApi";

const defaultSettings: SocialSettings = {
  response_sla_minutes: 30,
  retention_days: 180,
  retention_enabled: false,
  auto_assign_enabled: true,
  auto_suggest_enabled: true,
  conversation_daily_limit: 100,
};

const emptyOffer: Partial<CatalogOffer> & Pick<CatalogOffer, "name" | "offer_kind"> = {
  name: "", offer_kind: "service", route_type: null, summary: "", audience: "", price_text: null, public_url: null,
  approved_claims: [], prohibited_claims: [], active: true,
};

export function SocialOperationsPage() {
  const { organizationId } = useOrganization();
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ["social-operations", organizationId],
    queryFn: () => socialOperationsApi.get(organizationId!),
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
  });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ["social-operations", organizationId] });

  if (!organizationId) return null;
  return <AppShell><div className="space-y-8">
    <header><p className="panel-eyebrow">Governança e crescimento</p><h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">Operação do Social Selling</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Acompanhe conversas, SLA, qualidade do Gemini, catálogo comercial e regras de privacidade em um único lugar.</p></header>
    {summary.isLoading && <p className="text-sm text-muted-foreground">Carregando indicadores…</p>}
    {summary.isError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">Não foi possível carregar a operação.</p>}
    {summary.data && <>
      <Metrics data={summary.data.metrics} feedback={summary.data.feedback} />
      <Alerts alerts={summary.data.alerts} organizationId={organizationId} onSaved={refresh} />
      <div className="grid gap-6 xl:grid-cols-2"><Settings initial={summary.data.settings ?? defaultSettings} organizationId={organizationId} onSaved={refresh} /><Catalog offers={summary.data.offers} organizationId={organizationId} onSaved={refresh} /></div>
      <Privacy organizationId={organizationId} onSaved={refresh} />
    </>}
  </div></AppShell>;
}

function Metrics({ data, feedback }: { data: Record<string, number>; feedback: { total: number; edited: number; rejected: number } }) {
  const cards = [
    ["Conversas abertas", data.open_conversations, UsersRound], ["Não lidas", data.unread_conversations, Activity],
    ["Fora do SLA", data.sla_overdue, AlertTriangle], ["Entradas em 24h", data.inbound_24h, Database],
    ["Directs enviados em 24h", data.outbound_sent_24h, CheckCircle2], ["Leads ganhos", data.won_leads, ShieldCheck],
    ["Aceitação do Gemini", `${data.model_acceptance_rate}%`, Bot], ["Feedbacks avaliados", feedback.total, Save],
  ] as const;
  return <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value, Icon]) => <Card key={label} size="sm"><CardHeader><CardDescription className="flex items-center gap-1.5"><Icon className="size-3.5" />{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader></Card>)}</section>;
}

function Alerts({ alerts, organizationId, onSaved }: { alerts: Array<{ id: string; title: string; severity: string; details: Record<string, unknown>; last_seen_at: string }>; organizationId: string; onSaved: () => Promise<unknown> }) {
  const mutation = useMutation({ mutationFn: ({ id, resolve }: { id: string; resolve: boolean }) => socialOperationsApi.acknowledgeAlert(organizationId, id, resolve), onSuccess: async () => { toast.success("Alerta atualizado"); await onSaved(); } });
  if (!alerts.length) return <Card className="border-emerald-300 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20"><CardContent className="flex items-center gap-3 py-2"><CheckCircle2 className="size-5 text-emerald-700" /><div><strong>Operação sem alertas abertos</strong><p className="text-xs text-muted-foreground">O monitor seguirá verificando filas, webhooks, tokens, SLA e modelos.</p></div></CardContent></Card>;
  return <Card><CardHeader><CardTitle>Alertas operacionais</CardTitle><CardDescription>Gerados pelo monitor periódico; reconhecer não oculta a causa.</CardDescription></CardHeader><CardContent className="space-y-3">{alerts.map((alert) => <div key={alert.id} className="flex flex-col justify-between gap-3 rounded-xl border p-3 sm:flex-row sm:items-center"><div><div className="flex items-center gap-2"><Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>{alert.severity}</Badge><strong>{alert.title}</strong></div><p className="mt-1 text-xs text-muted-foreground">Ocorrências: {String(alert.details.count ?? "—")} · verificado em {new Date(alert.last_seen_at).toLocaleString("pt-BR")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: alert.id, resolve: false })}>Reconhecer</Button><Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: alert.id, resolve: true })}>Resolver</Button></div></div>)}</CardContent></Card>;
}

function Settings({ initial, organizationId, onSaved }: { initial: SocialSettings; organizationId: string; onSaved: () => Promise<unknown> }) {
  const [settings, setSettings] = useState(initial);
  const mutation = useMutation({ mutationFn: () => socialOperationsApi.updateSettings(organizationId, settings), onSuccess: async () => { toast.success("Políticas atualizadas"); await onSaved(); }, onError: () => toast.error("Não foi possível salvar as políticas") });
  const number = (key: keyof SocialSettings) => (event: React.ChangeEvent<HTMLInputElement>) => setSettings((current) => ({ ...current, [key]: Number(event.target.value) }));
  const toggle = (key: keyof SocialSettings) => (event: React.ChangeEvent<HTMLInputElement>) => setSettings((current) => ({ ...current, [key]: event.target.checked }));
  return <Card><CardHeader><CardTitle>Políticas operacionais</CardTitle><CardDescription>Configuração segura para atendimento, atribuição e retenção.</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3"><Field label="SLA (min)"><Input type="number" min={5} max={1440} value={settings.response_sla_minutes} onChange={number("response_sla_minutes")} /></Field><Field label="Limite Direct/24h"><Input type="number" min={1} max={500} value={settings.conversation_daily_limit} onChange={number("conversation_daily_limit")} /></Field><Field label="Retenção (dias)"><Input type="number" min={30} max={730} value={settings.retention_days} onChange={number("retention_days")} /></Field></div>
    <div className="grid gap-2 text-sm sm:grid-cols-2">{[["auto_assign_enabled", "Distribuir leads automaticamente"], ["auto_suggest_enabled", "Gerar sugestões com Gemini"], ["retention_enabled", "Aplicar anonimização por retenção"]].map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-lg border p-3"><input type="checkbox" checked={Boolean(settings[key as keyof SocialSettings])} onChange={toggle(key as keyof SocialSettings)} /><span>{label}</span></label>)}</div>
    {settings.retention_enabled && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">Ao salvar, o job diário poderá anonimizar mensagens e payloads mais antigos que {settings.retention_days} dias. A ação não é reversível.</p>}
    <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}><Save /> Salvar políticas</Button>
  </CardContent></Card>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }

function Catalog({ offers, organizationId, onSaved }: { offers: CatalogOffer[]; organizationId: string; onSaved: () => Promise<unknown> }) {
  const [offer, setOffer] = useState(emptyOffer);
  const mutation = useMutation({ mutationFn: () => socialOperationsApi.saveOffer(organizationId, offer), onSuccess: async () => { toast.success("Oferta salva no catálogo aprovado"); setOffer(emptyOffer); await onSaved(); }, onError: () => toast.error("Não foi possível salvar a oferta") });
  const edit = (value: CatalogOffer) => setOffer({ ...value });
  return <Card><CardHeader><CardTitle>Catálogo comercial aprovado</CardTitle><CardDescription>O Gemini só pode usar fatos registrados aqui. Preços e links não são inventados.</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="max-h-44 space-y-2 overflow-y-auto">{offers.map((item) => <button key={item.id} type="button" onClick={() => edit(item)} className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-muted"><span><strong className="block text-sm">{item.name}</strong><span className="text-xs text-muted-foreground">{item.route_type ?? "todas as rotas"} · {item.offer_kind}</span></span><Badge variant={item.active === false ? "outline" : "secondary"}>{item.active === false ? "inativa" : "ativa"}</Badge></button>)}</div>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Nome"><Input value={offer.name} maxLength={160} onChange={(event) => setOffer({ ...offer, name: event.target.value })} /></Field><Field label="Tipo"><select className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={offer.offer_kind} onChange={(event) => setOffer({ ...offer, offer_kind: event.target.value as CatalogOffer["offer_kind"] })}><option value="franchise">Franquia</option><option value="course">Curso</option><option value="product">Produto</option><option value="service">Serviço</option></select></Field><Field label="Rota"><select className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={offer.route_type ?? ""} onChange={(event) => setOffer({ ...offer, route_type: event.target.value || null })}><option value="">Todas</option><option value="franchise">Franquia</option><option value="q3">Q3</option><option value="hotmart">Cursos</option><option value="nuy">NUY</option></select></Field><Field label="Preço aprovado"><Input value={offer.price_text ?? ""} onChange={(event) => setOffer({ ...offer, price_text: event.target.value || null })} placeholder="Ex.: Sob consulta" /></Field></div>
    <Field label="Resumo factual"><Textarea maxLength={1000} value={offer.summary ?? ""} onChange={(event) => setOffer({ ...offer, summary: event.target.value })} /></Field><Field label="Público indicado"><Textarea maxLength={500} value={offer.audience ?? ""} onChange={(event) => setOffer({ ...offer, audience: event.target.value })} /></Field><Field label="URL pública aprovada"><Input type="url" value={offer.public_url ?? ""} onChange={(event) => setOffer({ ...offer, public_url: event.target.value || null })} /></Field>
    <div className="flex flex-wrap gap-2"><Button disabled={!offer.name.trim() || mutation.isPending} onClick={() => mutation.mutate()}><Save /> Salvar oferta</Button><Button variant="outline" onClick={() => setOffer(emptyOffer)}><Plus /> Nova</Button>{offer.id && <Button variant="destructive" onClick={() => { setOffer({ ...offer, active: false }); toast.info("Clique em Salvar oferta para desativar"); }}><Trash2 /> Desativar</Button>}</div>
  </CardContent></Card>;
}

function Privacy({ organizationId, onSaved }: { organizationId: string; onSaved: () => Promise<unknown> }) {
  const [contactId, setContactId] = useState(""); const [reason, setReason] = useState("");
  const mutation = useMutation({ mutationFn: () => socialOperationsApi.eraseContact(organizationId, contactId, reason), onSuccess: async () => { toast.success("Contato anonimizado e bloqueado para novos contatos"); setContactId(""); setReason(""); await onSaved(); }, onError: () => toast.error("Não foi possível processar a solicitação") });
  const submit = () => { if (contactId && reason && window.confirm("Confirmar anonimização permanente deste contato?")) mutation.mutate(); };
  return <Card><CardHeader><CardTitle>Privacidade e LGPD</CardTitle><CardDescription>Opt-out bloqueia mensagens futuras. A anonimização apaga o conteúdo pessoal e grava somente uma identidade irreversível de supressão.</CardDescription></CardHeader><CardContent className="grid gap-3 lg:grid-cols-[1fr_2fr_auto] lg:items-end"><Field label="ID do contato"><Input value={contactId} onChange={(event) => setContactId(event.target.value)} placeholder="UUID do contato" /></Field><Field label="Motivo documentado"><Input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Solicitação do titular, protocolo…" /></Field><Button variant="destructive" disabled={!contactId || !reason || mutation.isPending} onClick={submit}><ShieldCheck /> Anonimizar</Button></CardContent></Card>;
}

