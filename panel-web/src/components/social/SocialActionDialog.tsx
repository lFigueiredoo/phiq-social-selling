import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { socialCrmApi } from "@/lib/api/socialCrmApi";
import { CENTRAL_LABELS, ELIGIBILITY_LABELS, ROUTE_LABELS, STATUS_LABELS } from "@/lib/api/socialCrmPresentation";
import { getVerticalStages, type ContactEligibility, type LeadStatus,
  type RouteType, type SocialLeadRow, type SocialMember } from "@/lib/api/socialCrmTypes";

export type SocialAction = "transition" | "override" | "route" | "assign" | "close" | "reopen" | "central" | "eligibility";
const TITLES: Record<SocialAction, string> = {
  transition: "Avançar etapa", override: "Alterar etapa manualmente",
  route: "Reclassificar rota", assign: "Atribuir responsável",
  close: "Encerrar oportunidade", reopen: "Reabrir oportunidade",
  central: "Alterar funil central", eligibility: "Alterar elegibilidade",
};

export function SocialActionDialog({ open, action, lead, members, organizationId, onClose, onSaved }: {
  open: boolean; action: SocialAction | null; lead: SocialLeadRow;
  members: SocialMember[]; organizationId: string; onClose: () => void;
  onSaved: (lead: SocialLeadRow) => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState(() =>
    action === "route" ? lead.route_type ?? "franchise"
      : action === "assign" ? lead.owner_user_id ?? "unassigned"
      : action === "close" ? "lost"
      : action === "central" ? lead.central_stage
      : action === "eligibility" ? lead.contact_eligibility
      : "");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error("Escolha uma operação.");
      if (!reason.trim()) throw new Error("Informe o motivo.");
      let changes: Record<string, unknown> = {};
      if (action === "transition" || action === "override") {
        if (!target) throw new Error("Escolha a etapa de destino.");
        changes = { expected_stage: lead.vertical_stage, to_stage: target };
      } else if (action === "route") changes = { route_type: target };
      else if (action === "assign") changes = { owner_user_id: target === "unassigned" ? null : target };
      else if (action === "close") changes = { status: target };
      else if (action === "central") changes = { central_stage: target };
      else if (action === "eligibility") changes = { eligibility: target };
      return socialCrmApi.mutate(organizationId, lead.id, action, reason.trim(), changes);
    },
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ["social-crm", organizationId] });
      onSaved(updated);
      onClose();
    },
  });
  const stages = lead.route_type ? getVerticalStages(lead.route_type) : [];
  const currentIndex = stages.findIndex((item) => item.stage === lead.vertical_stage);
  const options = action === "transition" ? stages.slice(currentIndex + 1, currentIndex + 2)
    : action === "override" ? stages.filter((item) => item.stage !== lead.vertical_stage) : [];
  const label = action ? TITLES[action] : "Ação";
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>Esta alteração será registrada com seu usuário, motivo e horário.</DialogDescription>
        </DialogHeader>
        {action !== "reopen" && <div className="grid gap-2">
          <Label htmlFor="social-target">{action === "assign" ? "Responsável" : action === "close" ? "Status" : "Destino"}</Label>
          <select id="social-target" className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
            value={target} onChange={(event) => setTarget(event.target.value)}>
            {(action === "transition" || action === "override") && <>
              <option value="">Selecione a etapa</option>
              {options.map((item) => <option key={item.stage} value={item.stage}>{item.label}</option>)}
            </>}
            {action === "route" && (Object.entries(ROUTE_LABELS) as [RouteType, string][])
              .map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            {action === "assign" && <><option value="unassigned">Sem responsável</option>
              {members.map((item) => <option key={item.user_id} value={item.user_id}>{item.email ?? item.user_id}</option>)}
            </>}
            {action === "close" && (["lost", "cancelled"] as LeadStatus[])
              .map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            {action === "central" && (Object.entries(CENTRAL_LABELS))
              .map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            {action === "eligibility" && (Object.entries(ELIGIBILITY_LABELS) as [ContactEligibility, string][])
              .map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </div>}
        <div className="grid gap-2">
          <Label htmlFor="social-reason">Motivo obrigatório</Label>
          <Textarea id="social-reason" value={reason} maxLength={500}
            placeholder="Descreva a evidência ou decisão" onChange={(event) => setReason(event.target.value)} />
        </div>
        {mutation.error && <p role="alert" className="text-sm text-destructive">
          {mutation.error instanceof Error && mutation.error.message === "Informe o motivo."
            ? mutation.error.message : "Não foi possível concluir a alteração. Confira o estado atual do lead e tente novamente."}
        </p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={mutation.isPending || !reason.trim() || (action !== "reopen" && !target)}
            onClick={() => mutation.mutate()}>{mutation.isPending ? "Salvando…" : "Confirmar alteração"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
