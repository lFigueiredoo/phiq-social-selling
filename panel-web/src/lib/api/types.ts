export type PanelRole = "reviewer" | "admin";

export interface PanelMembership {
  organization_id: string;
  organization_name: string;
  role: PanelRole;
}

export type ActionType = "public_reply" | "private_reply";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown";

export type Intent =
  | "engagement"
  | "question"
  | "purchase_interest"
  | "product_interest"
  | "support"
  | "complaint"
  | "partnership"
  | "spam"
  | "other";

export type CommercialPotential = "low" | "medium" | "high" | "unknown";

export interface PanelActionAnalysis {
  sentiment: Sentiment;
  intent: Intent;
  commercial_potential: CommercialPotential;
  lead_score: number;
  analysis_summary: string | null;
}

// panel-list-actions only ever returns queued rows: status is always
// 'proposed' and policy_check_status is always 'not_required' or 'eligible'
// (ineligible/not_checked/other statuses are filtered out server-side).
export interface PanelAction {
  outbound_action_id: string;
  action_type: ActionType;
  status: "proposed";
  policy_check_status: "not_required" | "eligible";
  target_username: string | null;
  target_user_id: string | null;
  target_comment_id: string;
  comment_text: string | null;
  message_text: string;
  eligible_until: string | null;
  comment_created_at: string | null;
  created_at: string;
  analysis: PanelActionAnalysis;
}

export interface PanelListActionsFilters {
  intent?: Intent;
  commercial_potential?: CommercialPotential;
  action_type?: ActionType;
  limit?: number;
  offset?: number;
}

export interface PanelPagination {
  limit: number;
  offset: number;
  total: number;
}

export interface PanelApproval {
  outbound_action_id: string;
  status: string;
  policy_check_status: "not_checked" | "not_required" | "eligible" | "ineligible";
  approved_at: string | null;
  approved_by: string | null;
  already_approved: boolean;
}

export interface PanelRejection {
  outbound_action_id: string;
  status: string;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  already_rejected: boolean;
}

export interface PanelUpdatedAction {
  outbound_action_id: string;
  status: string;
  message_text: string;
  previous_message_text: string;
}
