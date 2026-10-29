// Read models for a future authenticated Social CRM panel endpoint (F22G).
// The browser has no direct grants on the underlying CRM tables.
export type CentralStage =
  | "new_lead"
  | "first_contact"
  | "qualification"
  | "routing";

export type RouteType = "franchise" | "q3" | "hotmart" | "nuy" | "no_profile";
export type CommercialRoute = Exclude<RouteType, "no_profile">;
export type LeadStatus = "active" | "awaiting_signal" | "won" | "lost" | "cancelled";
export type ContactEligibility = "unknown" | "eligible" | "ineligible" | "not_required";
export type SocialIntent =
  | "commercial_interest" | "product_interest" | "franchise_interest"
  | "q3_interest" | "course_interest" | "support" | "complaint"
  | "engagement" | "other";
export type CommercialPotential = "low" | "medium" | "high" | "unknown";

export type VerticalStage =
  | "lead_received"
  | "presentation"
  | "evaluation"
  | "proposal"
  | "negotiation"
  | "closing"
  | "implementation"
  | "diagnosis"
  | "onboarding"
  | "active_client"
  | "course_recommendation"
  | "offer"
  | "follow_up"
  | "purchase"
  | "active_student"
  | "need_identification"
  | "product_recommendation"
  | "post_sale";

export interface VerticalStageDefinition {
  stage: VerticalStage;
  label: string;
  recommendedNextAction: string;
  terminal: boolean;
}

export const VERTICAL_STAGES: Record<CommercialRoute, readonly VerticalStageDefinition[]> = {
  franchise: [
    { stage: "lead_received", label: "Lead Recebido", recommendedNextAction: "review_profile", terminal: false },
    { stage: "presentation", label: "Apresentação", recommendedNextAction: "present_franchise", terminal: false },
    { stage: "evaluation", label: "Avaliação", recommendedNextAction: "evaluate_candidate", terminal: false },
    { stage: "proposal", label: "Proposta", recommendedNextAction: "prepare_proposal", terminal: false },
    { stage: "negotiation", label: "Negociação", recommendedNextAction: "follow_negotiation", terminal: false },
    { stage: "closing", label: "Fechamento", recommendedNextAction: "confirm_closing", terminal: false },
    { stage: "implementation", label: "Implantação", recommendedNextAction: "monitor_implementation", terminal: true },
  ],
  q3: [
    { stage: "lead_received", label: "Lead Recebido", recommendedNextAction: "review_company", terminal: false },
    { stage: "diagnosis", label: "Diagnóstico", recommendedNextAction: "perform_diagnosis", terminal: false },
    { stage: "presentation", label: "Apresentação", recommendedNextAction: "present_q3", terminal: false },
    { stage: "proposal", label: "Proposta", recommendedNextAction: "prepare_proposal", terminal: false },
    { stage: "negotiation", label: "Negociação", recommendedNextAction: "follow_negotiation", terminal: false },
    { stage: "onboarding", label: "Onboarding", recommendedNextAction: "start_onboarding", terminal: false },
    { stage: "active_client", label: "Cliente Ativo", recommendedNextAction: "customer_success", terminal: true },
  ],
  hotmart: [
    { stage: "lead_received", label: "Lead Recebido", recommendedNextAction: "understand_learning_need", terminal: false },
    { stage: "course_recommendation", label: "Indicação do Curso", recommendedNextAction: "recommend_course", terminal: false },
    { stage: "offer", label: "Oferta", recommendedNextAction: "present_offer", terminal: false },
    { stage: "follow_up", label: "Follow-up", recommendedNextAction: "follow_up", terminal: false },
    { stage: "purchase", label: "Compra", recommendedNextAction: "confirm_purchase", terminal: false },
    { stage: "active_student", label: "Aluno Ativo", recommendedNextAction: "student_success", terminal: true },
  ],
  nuy: [
    { stage: "lead_received", label: "Lead Recebido", recommendedNextAction: "understand_need", terminal: false },
    { stage: "need_identification", label: "Identificação da Necessidade", recommendedNextAction: "identify_need", terminal: false },
    { stage: "product_recommendation", label: "Indicação dos Produtos", recommendedNextAction: "recommend_products", terminal: false },
    { stage: "offer", label: "Oferta", recommendedNextAction: "present_offer", terminal: false },
    { stage: "purchase", label: "Compra", recommendedNextAction: "confirm_purchase", terminal: false },
    { stage: "post_sale", label: "Pós-venda", recommendedNextAction: "post_sale_follow_up", terminal: true },
  ],
};

export function getVerticalStages(route: RouteType): readonly VerticalStageDefinition[] {
  return route === "no_profile" ? [] : VERTICAL_STAGES[route];
}

export function getStageLabel(route: RouteType, stage: VerticalStage): string | null {
  return getVerticalStages(route).find((item) => item.stage === stage)?.label ?? null;
}

export function getNextAllowedStage(route: RouteType, stage: VerticalStage): VerticalStage | null {
  const stages = getVerticalStages(route);
  const index = stages.findIndex((item) => item.stage === stage);
  return index < 0 ? null : stages[index + 1]?.stage ?? null;
}

export interface SocialRouteProposal {
  route_type: RouteType;
  confidence: number;
  lead_score: number;
  reason: string;
  recommended_next_action: string;
}

export interface SocialAssessment extends SocialRouteProposal {
  intent: SocialIntent;
  commercial_potential: CommercialPotential;
  signals: string[];
}

export interface SocialStageHistoryEntry {
  id: string;
  lead_id: string;
  pipeline: "central" | CommercialRoute;
  route_type: RouteType | null;
  from_stage: string | null;
  to_stage: string;
  from_status: LeadStatus | null;
  to_status: LeadStatus | null;
  reason: string;
  source: "system" | "ai" | "human" | "manual" | "import";
  changed_by_id: string | null;
  operation_key: string | null;
  details: Record<string, unknown>;
  changed_at: string;
}

export interface SocialLeadSummary {
  id: string;
  organization_id: string;
  contact_id: string;
  central_stage: CentralStage;
  route_type: RouteType | null;
  vertical_stage: VerticalStage | null;
  status: LeadStatus;
  owner_user_id: string | null;
  vertical_stage_entered_at: string | null;
  closed_at: string | null;
  won_at: string | null;
  lost_at: string | null;
  lead_score: number | null;
  contact_eligibility: ContactEligibility;
  eligibility_reason: string | null;
  eligibility_checked_at: string | null;
  intent: SocialIntent | null;
  commercial_potential: CommercialPotential | null;
  signals: string[];
  qualification_reason: string | null;
  needs_more_signal: boolean;
  route_confidence: number | null;
  route_reason: string | null;
  recommended_next_action: string | null;
  updated_at: string;
}

export type SocialPipelineResultCode =
  | "classified" | "routed" | "no_profile" | "needs_more_signal"
  | "lead_closed" | "already_processed" | "retryable_error" | "terminal_error";

export interface SocialPipelineResult {
  operation_id: string;
  organization_id: string;
  contact_id: string;
  engagement_id: string;
  lead_id: string;
  created_contact: boolean;
  created_engagement: boolean;
  created_lead: boolean;
  central_stage: CentralStage;
  route_type: RouteType | null;
  vertical_stage: VerticalStage | null;
  lead_status: LeadStatus;
  classification_status: "pending" | "completed" | "failed_retryable" | "failed_terminal" | "not_required" | null;
  classifier_source: "deterministic" | "ai" | "fallback" | "manual" | null;
  prompt_version: string | null;
  contact_eligibility: ContactEligibility;
  recommended_next_action: string | null;
  needs_more_signal: boolean;
  result_code: SocialPipelineResultCode;
  already_processed: boolean;
  retryable: boolean;
  error_code: string | null;
  actions_performed: string[];
  duration_ms: number;
}

export type ClassificationStatus = "pending" | "completed" | "failed_retryable" | "failed_terminal" | "not_required" | null;
export type EngagementSource = "realtime" | "historical_backfill" | "browser_collector" | "manual";

export interface SocialLeadRow extends SocialLeadSummary {
  username: string | null;
  display_name: string | null;
  profile_url: string | null;
  external_user_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  engagement_count: number;
  owner_email: string | null;
  last_engagement_id: string | null;
  last_source: EngagementSource | null;
  last_engagement_type: string | null;
  last_interaction_at: string | null;
  classification_status: ClassificationStatus;
  pipeline_error_code: string | null;
  pipeline_processed_at: string | null;
  classifier_source: "deterministic" | "ai" | "fallback" | "manual" | null;
  prompt_version: string | null;
  classified_at: string | null;
  first_contact_at: string | null;
  qualified_at: string | null;
  routed_at: string | null;
  created_at: string;
}

export interface SocialDashboard {
  kpis: Record<"active" | "new_leads" | "qualification" | "routed" | "no_profile" |
    "franchise" | "q3" | "hotmart" | "nuy" | "won" | "lost" |
    "awaiting_signal" | "unassigned" | "classification_pending" | "needs_action", number>;
  recent_interactions: Partial<SocialLeadRow>[];
  unassigned_leads: Partial<SocialLeadRow>[];
  pending_leads: Partial<SocialLeadRow>[];
}

export interface SocialTimelineEvent {
  id: string;
  kind: "interaction" | "classification" | "stage_change" | "manual_action";
  at: string;
  info: Record<string, unknown>;
}

export interface SocialMember {
  user_id: string;
  email: string | null;
  role: "admin" | "reviewer";
}
