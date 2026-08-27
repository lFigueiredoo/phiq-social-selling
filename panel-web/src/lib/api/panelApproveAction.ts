import { callPanelFunction } from "@/lib/api/client";
import type { PanelApproval } from "@/lib/api/types";

interface PanelApproveActionResponse {
  ok: true;
  approval: PanelApproval;
}

export async function approvePanelAction(
  outboundActionId: string,
  organizationId: string,
): Promise<PanelApproval> {
  const result = await callPanelFunction<PanelApproveActionResponse>(
    "panel-approve-action",
    {
      method: "POST",
      body: {
        outbound_action_id: outboundActionId,
        organization_id: organizationId,
      },
    },
  );
  return result.approval;
}
