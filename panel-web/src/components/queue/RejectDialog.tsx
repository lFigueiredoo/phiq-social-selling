import { MessageSquareWarning, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_REASON_LENGTH = 500;

interface RejectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string | null) => void;
  isSubmitting: boolean;
}

export function RejectDialog({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
}: RejectDialogProps) {
  const [reason, setReason] = useState("");

  function handleConfirm() {
    const trimmed = reason.trim();
    onConfirm(trimmed ? trimmed : null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSubmitting) return;
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <MessageSquareWarning className="size-5" />
          </div>
          <DialogTitle>Rejeitar esta ação?</DialogTitle>
          <DialogDescription>
            A sugestão sairá da fila de revisão e não seguirá para envio. Esta decisão não pode ser desfeita pelo painel.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reject-reason">Motivo (opcional)</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            disabled={isSubmitting}
            className="min-h-24"
            placeholder="Ex.: resposta fora do tom, contexto insuficiente, abordagem inadequada…"
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="text-right text-xs text-muted-foreground">
            {reason.length}/{MAX_REASON_LENGTH}
          </span>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={isSubmitting} onClick={handleConfirm}>
            <X className="size-3.5" />
            {isSubmitting ? "Rejeitando…" : "Confirmar rejeição"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
