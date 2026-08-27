import { callPanelFunction } from "@/lib/api/client";
import type { PanelUpdatedAction } from "@/lib/api/types";

interface PanelUpdateActionMessageResponse {
  ok: true;
  action: PanelUpdatedAction;
}

export async function updatePanelActionMessage(
  outboundActionId: string,
  organizationId: string,
  messageText: string,
): Promise<PanelUpdatedAction> {
  const result = await callPanelFunction<PanelUpdateActionMessageResponse>(
    "panel-update-action-message",
    {
      method: "POST",
      body: {
        outbound_action_id: outboundActionId,
        organization_id: organizationId,
        message_text: messageText,
      },
    },
  );
  return result.action;
}
