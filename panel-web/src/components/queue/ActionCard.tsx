import { Check, Globe2, MessageCircle, PencilLine, Send, Sparkles, UserRound, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EligibilityCountdown } from "@/components/queue/EligibilityCountdown";
import { RejectDialog } from "@/components/queue/RejectDialog";
import { useApproveAction } from "@/hooks/useApproveAction";
import { useRejectAction } from "@/hooks/useRejectAction";
import { useUpdateActionMessage } from "@/hooks/useUpdateActionMessage";
import { cn } from "@/lib/utils";
import type { PanelAction } from "@/lib/api/types";

const MAX_MESSAGE_LENGTH = 2000;

const INTENT_LABEL: Record<string, string> = {
  engagement: "Engajamento",
  question: "Dúvida",
  purchase_interest: "Interesse de compra",
  product_interest: "Interesse no produto",
  support: "Suporte",
  complaint: "Reclamação",
  partnership: "Parceria",
  spam: "Spam",
  other: "Outro",
};

const COMMERCIAL_POTENTIAL_LABEL: Record<string, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  unknown: "Desconhecido",
};

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "Positivo",
  neutral: "Neutro",
  negative: "Negativo",
  mixed: "Misto",
  unknown: "Desconhecido",
};

const POTENTIAL_CLASS: Record<string, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300",
  medium: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/45 dark:text-amber-300",
  low: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  unknown: "border-border bg-muted text-muted-foreground",
};

const SENTIMENT_CLASS: Record<string, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300",
  negative: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300",
  mixed: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/45 dark:text-violet-300",
  neutral: "border-border bg-muted/70 text-muted-foreground",
  unknown: "border-border bg-muted/70 text-muted-foreground",
};

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

function scoreClass(score: number): string {
  if (score >= 80) return "text-emerald-700 dark:text-emerald-300";
  if (score >= 60) return "text-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
}

interface ActionCardProps {
  action: PanelAction;
  organizationId: string;
}

export function ActionCard({ action, organizationId }: ActionCardProps) {
  const [messageDraft, setMessageDraft] = useState(action.message_text);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);

  const approveAction = useApproveAction(organizationId);
  const rejectAction = useRejectAction(organizationId);
  const updateMessage = useUpdateActionMessage(organizationId);

  const isBusy = approveAction.isPending || rejectAction.isPending || updateMessage.isPending;
  const hasMessageChanged = messageDraft.trim() !== action.message_text;
  const isPrivate = action.action_type === "private_reply";

  return (
    <Card
      className={cn(
        "panel-surface gap-0 rounded-2xl py-0 transition-shadow hover:shadow-md",
        isPrivate ? "border-l-4 border-l-violet-500" : "border-l-4 border-l-primary",
      )}
    >
      <CardHeader className="gap-3 border-b border-border/70 px-5 py-4 sm:px-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl",
                isPrivate ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" : "bg-primary/10 text-primary",
              )}
            >
              {isPrivate ? <Send className="size-4" /> : <Globe2 className="size-4" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-semibold">
                  {action.target_username ? `@${action.target_username}` : "Usuário desconhecido"}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "border px-2 font-semibold",
                    isPrivate
                      ? "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/45 dark:text-violet-300"
                      : "border-primary/20 bg-primary/7 text-primary",
                  )}
                >
                  {isPrivate ? "Resposta privada" : "Resposta pública"}
                </Badge>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <UserRound className="size-3" />
                <span>Recebido {formatRelativeTime(action.created_at)}</span>
              </div>
            </div>
          </div>
          {action.eligible_until && <EligibilityCountdown eligibleUntil={action.eligible_until} />}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 px-5 py-5 sm:px-6 sm:py-6">
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <MessageCircle className="size-3.5" />
            Comentário original
          </div>
          <blockquote className="rounded-xl border border-border/70 bg-muted/45 px-4 py-3 text-sm leading-6">
            {action.comment_text ?? (
              <span className="italic text-muted-foreground">Texto do comentário indisponível</span>
            )}
          </blockquote>
        </section>

        <section className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Sparkles className="size-3.5" />
              Leitura da IA
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={cn("border", SENTIMENT_CLASS[action.analysis.sentiment])}>
                {SENTIMENT_LABEL[action.analysis.sentiment] ?? action.analysis.sentiment}
              </Badge>
              <Badge variant="outline" className="border-primary/15 bg-primary/5 text-primary">
                {INTENT_LABEL[action.analysis.intent] ?? action.analysis.intent}
              </Badge>
              <Badge variant="outline" className={cn("border", POTENTIAL_CLASS[action.analysis.commercial_potential])}>
                Potencial {COMMERCIAL_POTENTIAL_LABEL[action.analysis.commercial_potential] ?? action.analysis.commercial_potential}
              </Badge>
            </div>
            {action.analysis.analysis_summary && (
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                {action.analysis.analysis_summary}
              </p>
            )}
          </div>

          <div className="min-w-30 rounded-xl border border-border/70 bg-card px-3 py-2.5 lg:text-right">
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Lead score
            </p>
            <p className={cn("mt-0.5 font-heading text-2xl font-semibold", scoreClass(action.analysis.lead_score))}>
              {action.analysis.lead_score}
              <span className="ml-0.5 text-xs font-medium text-muted-foreground">/100</span>
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-primary/12 bg-primary/[0.035] p-4 sm:p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Label htmlFor={`message-${action.outbound_action_id}`} className="flex items-center gap-2 font-semibold">
              <PencilLine className="size-3.5 text-primary" />
              Resposta sugerida
            </Label>
            {hasMessageChanged && (
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Edição não salva</span>
            )}
          </div>
          <Textarea
            id={`message-${action.outbound_action_id}`}
            value={messageDraft}
            maxLength={MAX_MESSAGE_LENGTH}
            disabled={isBusy}
            className="min-h-28 resize-y bg-background text-sm leading-6 shadow-xs"
            onChange={(event) => setMessageDraft(event.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {messageDraft.length}/{MAX_MESSAGE_LENGTH} caracteres
            </span>
            {hasMessageChanged && (
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy || messageDraft.trim().length === 0}
                onClick={() =>
                  updateMessage.mutate({
                    outboundActionId: action.outbound_action_id,
                    messageText: messageDraft.trim(),
                  })
                }
              >
                <Check className="size-3.5" />
                {updateMessage.isPending ? "Salvando…" : "Salvar edição"}
              </Button>
            )}
          </div>
        </section>

        <footer className="flex flex-col-reverse justify-end gap-2 border-t border-border/70 pt-4 sm:flex-row">
          <Button
            variant="outline"
            className="border-destructive/20 text-destructive hover:bg-destructive/8 hover:text-destructive"
            disabled={isBusy}
            onClick={() => setRejectDialogOpen(true)}
          >
            <X className="size-3.5" />
            Rejeitar
          </Button>
          <Button
            className="shadow-sm"
            disabled={isBusy}
            onClick={() => approveAction.mutate(action.outbound_action_id)}
          >
            <Check className="size-3.5" />
            {approveAction.isPending ? "Aprovando…" : "Aprovar para envio"}
          </Button>
        </footer>
      </CardContent>

      <RejectDialog
        open={rejectDialogOpen}
        onOpenChange={setRejectDialogOpen}
        isSubmitting={rejectAction.isPending}
        onConfirm={(reason) => {
          rejectAction.mutate(
            { outboundActionId: action.outbound_action_id, reason },
            { onSuccess: () => setRejectDialogOpen(false) },
          );
        }}
      />
    </Card>
  );
}
