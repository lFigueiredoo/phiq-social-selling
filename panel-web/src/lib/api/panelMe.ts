import { callPanelFunction } from "@/lib/api/client";
import type { PanelMembership } from "@/lib/api/types";

interface PanelMeResponse {
  ok: true;
  user: { id: string };
  memberships: PanelMembership[];
}

export async function fetchPanelMe(): Promise<PanelMeResponse> {
  return callPanelFunction<PanelMeResponse>("panel-me");
}
