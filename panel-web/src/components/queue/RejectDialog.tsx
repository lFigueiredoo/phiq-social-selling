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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rejeitar esta ação?</DialogTitle>
          <DialogDescription>
            A resposta não será enviada. Esta decisão não pode ser desfeita.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reject-reason">Motivo (opcional)</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            disabled={isSubmitting}
            placeholder="Por que esta resposta está sendo rejeitada?"
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            {reason.length}/{MAX_REASON_LENGTH}
          </span>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={isSubmitting} onClick={handleConfirm}>
            {isSubmitting ? "Rejeitando…" : "Confirmar rejeição"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
