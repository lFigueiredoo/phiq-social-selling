import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Check, Clock3, MessageCircle, Search, Send, ShieldBan, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/context/OrganizationProvider";
import { useMemberships } from "@/hooks/useMemberships";
import { conversationsApi, type ConversationDetail, type ConversationListItem } from "@/lib/api/conversationsApi";
import { cn } from "@/lib/utils";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function relativeWindow(value: string | null, now: number) {
  if (!value) return "Janela indisponível";
  const minutes = Math.floor((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return "Janela encerrada";
  if (minutes < 60) return `${minutes} min restantes`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}min restantes`;
}

function ContactLabel({ item }: { item: ConversationListItem }) {
  return <>{item.username ? `@${item.username}` : `Contato ${item.external_user_id.slice(-6)}`}</>;
}

export function ConversationsPage() {
  const { organizationId } = useOrganization();
  const { data: membershipData } = useMemberships();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");

  const list = useQuery({
    queryKey: ["social-conversations", organizationId, status, search],
    queryFn: () => conversationsApi.list(organizationId!, { status: status || undefined, search: search || undefined }),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });
  const activeId = selectedId ?? list.data?.items[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["social-conversations", organizationId, activeId],
    queryFn: () => conversationsApi.detail(organizationId!, activeId!),
    enabled: Boolean(organizationId && activeId),
    refetchInterval: 20_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["social-conversations", organizationId] });
  };
  const action = useMutation({
    mutationFn: async (input: { type: string; messageId?: string; value?: string }) => {
      if (!organizationId || !activeId) throw new Error("conversation_not_selected");
      if (input.type === "reply") return conversationsApi.createReply(organizationId, activeId, draft);
      if (input.type === "approve") return conversationsApi.approveReply(organizationId, input.messageId!);
      if (input.type === "feedback") return conversationsApi.feedback(organizationId, input.messageId!, input.value as "accepted" | "rejected" | "unsafe");
      return conversationsApi.manage(organizationId, activeId, input.type, input.value);
    },
    onSuccess: async (_, input) => {
      if (input.type === "reply") setDraft("");
      toast.success(input.type === "approve" ? "Resposta aprovada para envio" : "Conversa atualizada");
      await refresh();
    },
    onError: () => toast.error("Não foi possível concluir a ação. Verifique a janela e tente novamente."),
  });

  const selected = detail.data;
  const replyable = Boolean(selected && !selected.conversation.opted_out && selected.conversation.status !== "blocked" &&
    selected.conversation.reply_window_until && Date.parse(selected.conversation.reply_window_until) > detail.dataUpdatedAt + 10 * 60_000);

  return <AppShell><div className="space-y-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><p className="panel-eyebrow">Instagram Direct</p>
        <h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">Conversas e oportunidades</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Atenda mensagens recebidas, revise sugestões do Gemini e aprove cada envio. Nenhuma conversa é iniciada sem uma mensagem real do contato.</p>
      </div>
      <div className="flex flex-wrap gap-2"><Badge variant="outline" className="h-7"><MessageCircle /> {list.data?.total ?? 0} conversas</Badge><Badge variant={membershipData?.dispatch.conversation_dispatch_enabled ? "secondary" : "destructive"} className="h-7">{membershipData?.dispatch.conversation_dispatch_enabled ? "Dispatcher de Direct ativo" : "Envio de Direct bloqueado"}</Badge></div>
    </header>

    <section className="grid min-h-[38rem] overflow-hidden rounded-2xl border bg-card shadow-sm lg:grid-cols-[22rem_1fr]">
      <aside className="border-b lg:border-r lg:border-b-0">
        <div className="space-y-3 border-b p-4">
          <div className="relative"><Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input aria-label="Buscar conversa" className="pl-8" placeholder="Buscar contato" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <select aria-label="Filtrar por status" className="h-8 w-full rounded-lg border bg-background px-2 text-sm" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todas as conversas</option><option value="open">Abertas</option><option value="pending">Pendentes</option><option value="waiting_customer">Aguardando contato</option><option value="resolved">Resolvidas</option><option value="blocked">Bloqueadas</option>
          </select>
        </div>
        <div className="max-h-[34rem] overflow-y-auto">
          {list.isLoading && <p className="p-6 text-sm text-muted-foreground">Carregando conversas…</p>}
          {list.isError && <p role="alert" className="p-6 text-sm text-destructive">Não foi possível carregar o Direct.</p>}
          {list.data?.items.map((item) => <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={cn("w-full border-b p-4 text-left transition hover:bg-muted/60", activeId === item.id && "bg-secondary/70")}>
            <div className="flex items-center justify-between gap-2"><strong className="truncate text-sm"><ContactLabel item={item} /></strong><span className="text-[0.68rem] text-muted-foreground">{dateTime.format(new Date(item.last_message_at))}</span></div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.latest_message || "Sem prévia"}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">{item.unread_count > 0 && <Badge>{item.unread_count} nova(s)</Badge>}<Badge variant="outline">{item.priority}</Badge>{item.sla_due_at && Date.parse(item.sla_due_at) < list.dataUpdatedAt && item.status !== "resolved" && <Badge variant="destructive">SLA</Badge>}</div>
          </button>)}
          {!list.isLoading && list.data?.items.length === 0 && <p className="p-6 text-sm text-muted-foreground">Nenhuma conversa encontrada.</p>}
        </div>
      </aside>

      <main className="flex min-w-0 flex-col">
        {!activeId && <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">Selecione uma conversa.</div>}
        {activeId && detail.isLoading && <div className="p-8 text-sm text-muted-foreground">Abrindo conversa…</div>}
        {selected && <ConversationView detail={selected} now={detail.dataUpdatedAt} draft={draft} setDraft={setDraft} replyable={replyable} busy={action.isPending} run={(input) => action.mutate(input)} />}
      </main>
    </section>
  </div></AppShell>;
}

function ConversationView({ detail, now, draft, setDraft, replyable, busy, run }: {
  detail: ConversationDetail; now: number; draft: string; setDraft: (value: string) => void; replyable: boolean; busy: boolean;
  run: (input: { type: string; messageId?: string; value?: string }) => void;
}) {
  const c = detail.conversation;
  const latestProposed = useMemo(() => [...detail.messages].reverse().find((message) => message.direction === "outbound" && message.status === "proposed"), [detail.messages]);
  return <>
    <header className="border-b p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-heading text-lg font-semibold"><ContactLabel item={c} /></h2><p className="mt-1 text-xs text-muted-foreground">{c.route_type ?? "rota em análise"} · score {c.lead_score ?? "—"} · {c.owner_email ?? "sem responsável"}</p></div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Prioridade" className="h-8 rounded-lg border bg-background px-2 text-xs" value={c.priority} onChange={(event) => run({ type: "priority", value: event.target.value })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select>
          <select aria-label="Responsável" className="h-8 max-w-48 rounded-lg border bg-background px-2 text-xs" value={c.owner_user_id ?? ""} onChange={(event) => run({ type: "assign", value: event.target.value })}><option value="">Sem responsável</option>{detail.members.map((member) => <option key={member.user_id} value={member.user_id}>{member.email ?? member.user_id.slice(0, 8)}</option>)}</select>
          <select aria-label="Status" className="h-8 rounded-lg border bg-background px-2 text-xs" value={c.status === "blocked" ? "open" : c.status} disabled={c.status === "blocked"} onChange={(event) => run({ type: "status", value: event.target.value })}><option value="open">Aberta</option><option value="pending">Pendente</option><option value="waiting_customer">Aguardando</option><option value="resolved">Resolvida</option></select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><Badge variant={replyable ? "secondary" : "destructive"}><Clock3 /> {relativeWindow(c.reply_window_until, now)}</Badge>{c.opted_out && <Badge variant="destructive"><ShieldBan /> Opt-out</Badge>}{c.sla_due_at && <span className="text-muted-foreground">SLA: {dateTime.format(new Date(c.sla_due_at))}</span>}</div>
    </header>

    <div className="flex-1 space-y-3 overflow-y-auto bg-muted/25 p-4 sm:p-6">
      {detail.messages.map((message) => <article key={message.id} className={cn("max-w-[88%] rounded-2xl border px-4 py-3 shadow-sm", message.direction === "outbound" ? "ml-auto bg-primary text-primary-foreground" : "bg-card")}>
        <div className="mb-1 flex items-center justify-between gap-3 text-[0.68rem] opacity-75"><span className="flex items-center gap-1">{message.model_name ? <Bot className="size-3" /> : message.direction === "inbound" ? <UserRound className="size-3" /> : <Send className="size-3" />}{message.direction === "inbound" ? "Contato" : message.model_name ? "Sugestão Gemini" : "Equipe"}</span><span>{dateTime.format(new Date(message.created_at))}</span></div>
        <p className="whitespace-pre-wrap text-sm leading-6">{message.message_text}</p>
        {message.analysis_summary && <p className="mt-2 border-t border-current/15 pt-2 text-xs opacity-80">{message.analysis_summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge variant={message.direction === "outbound" ? "secondary" : "outline"}>{message.status}</Badge>{message.last_error && <span className="flex items-center gap-1 text-xs"><AlertTriangle className="size-3" />{message.last_error}</span>}
          {message.status === "proposed" && <><Button size="xs" variant="secondary" disabled={!replyable || busy} onClick={() => run({ type: "approve", messageId: message.id })}><Check /> Aprovar envio</Button>{message.model_name && <><Button size="xs" variant="ghost" onClick={() => run({ type: "feedback", messageId: message.id, value: "accepted" })}>Útil</Button><Button size="xs" variant="ghost" onClick={() => run({ type: "feedback", messageId: message.id, value: "rejected" })}>Ruim</Button><Button size="xs" variant="ghost" onClick={() => run({ type: "feedback", messageId: message.id, value: "unsafe" })}>Insegura</Button></>}</>}
        </div>
      </article>)}
    </div>

    <footer className="space-y-3 border-t p-4 sm:p-5">
      {detail.offers.length > 0 && <div className="flex gap-2 overflow-x-auto pb-1">{detail.offers.map((offer) => <button key={offer.id} type="button" className="shrink-0 rounded-lg border bg-background px-3 py-2 text-left text-xs hover:bg-muted" onClick={() => setDraft([draft, offer.name, offer.public_url].filter(Boolean).join(" — "))}><strong className="block">{offer.name}</strong><span className="text-muted-foreground">{offer.price_text || offer.offer_kind}</span></button>)}</div>}
      <Textarea aria-label="Resposta ao Direct" maxLength={1000} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!replyable} placeholder={replyable ? latestProposed ? "Edite ou escreva uma alternativa…" : "Escreva uma resposta…" : "Envio indisponível: janela encerrada ou contato bloqueado."} />
      <div className="flex flex-wrap justify-between gap-2"><Button variant="destructive" size="sm" disabled={c.opted_out || busy} onClick={() => run({ type: "opt_out", value: "Solicitação registrada pela equipe" })}><ShieldBan /> Registrar opt-out</Button><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => run({ type: "mark_read" })}>Marcar como lida</Button><Button size="sm" disabled={!replyable || !draft.trim() || busy} onClick={() => run({ type: "reply" })}><Send /> Criar para aprovação</Button></div></div>
      <p className="text-[0.7rem] leading-5 text-muted-foreground">Criar uma resposta não envia nada. O envio só entra na fila depois de uma aprovação explícita e ainda depende das travas operacionais.</p>
    </footer>
  </>;
}

