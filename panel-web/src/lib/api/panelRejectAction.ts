import { callPanelFunction } from "@/lib/api/client";
import type { PanelRejection } from "@/lib/api/types";

interface PanelRejectActionResponse {
  ok: true;
  rejection: PanelRejection;
}

export async function rejectPanelAction(
  outboundActionId: string,
  organizationId: string,
  reason?: string | null,
): Promise<PanelRejection> {
  const trimmedReason = reason?.trim();
  const result = await callPanelFunction<PanelRejectActionResponse>(
    "panel-reject-action",
    {
      method: "POST",
      body: {
        outbound_action_id: outboundActionId,
        organization_id: organizationId,
        reason: trimmedReason ? trimmedReason : undefined,
      },
    },
  );
  return result.rejection;
}
