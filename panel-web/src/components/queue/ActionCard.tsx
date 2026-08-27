import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { EligibilityCountdown } from "@/components/queue/EligibilityCountdown";
import { RejectDialog } from "@/components/queue/RejectDialog";
import { useApproveAction } from "@/hooks/useApproveAction";
import { useRejectAction } from "@/hooks/useRejectAction";
import { useUpdateActionMessage } from "@/hooks/useUpdateActionMessage";
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

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {action.target_username ? `@${action.target_username}` : "Usuário desconhecido"}
            </span>
            <Badge variant="outline">
              {action.action_type === "private_reply" ? "Resposta privada" : "Resposta pública"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(action.created_at)}
            </span>
          </div>
          {action.eligible_until && (
            <EligibilityCountdown eligibleUntil={action.eligible_until} />
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          {action.comment_text ?? (
            <span className="italic text-muted-foreground">
              Texto do comentário indisponível
            </span>
          )}
        </p>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">
            {SENTIMENT_LABEL[action.analysis.sentiment] ?? action.analysis.sentiment}
          </Badge>
          <Badge variant="secondary">
            {INTENT_LABEL[action.analysis.intent] ?? action.analysis.intent}
          </Badge>
          <Badge variant="secondary">
            Potencial:{" "}
            {COMMERCIAL_POTENTIAL_LABEL[action.analysis.commercial_potential] ??
              action.analysis.commercial_potential}
          </Badge>
          <Badge variant="secondary">Lead score: {action.analysis.lead_score}/100</Badge>
        </div>

        {action.analysis.analysis_summary && (
          <p className="text-sm text-muted-foreground">{action.analysis.analysis_summary}</p>
        )}

        <Separator />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`message-${action.outbound_action_id}`}>
            Resposta sugerida (editável)
          </Label>
          <Textarea
            id={`message-${action.outbound_action_id}`}
            value={messageDraft}
            maxLength={MAX_MESSAGE_LENGTH}
            disabled={isBusy}
            onChange={(event) => setMessageDraft(event.target.value)}
          />
          {hasMessageChanged && (
            <div className="flex justify-end">
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
                {updateMessage.isPending ? "Salvando…" : "Salvar edição"}
              </Button>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={isBusy} onClick={() => setRejectDialogOpen(true)}>
            Rejeitar
          </Button>
          <Button disabled={isBusy} onClick={() => approveAction.mutate(action.outbound_action_id)}>
            {approveAction.isPending ? "Aprovando…" : "Aprovar para envio"}
          </Button>
        </div>
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
