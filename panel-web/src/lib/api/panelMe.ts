import { callPanelFunction } from "@/lib/api/client";
import type { PanelDispatchStatus, PanelMembership } from "@/lib/api/types";

export interface PanelMeResponse {
  ok: true;
  user: { id: string };
  memberships: PanelMembership[];
  dispatch: PanelDispatchStatus;
}

export async function fetchPanelMe(): Promise<PanelMeResponse> {
  return callPanelFunction<PanelMeResponse>("panel-me");
}
