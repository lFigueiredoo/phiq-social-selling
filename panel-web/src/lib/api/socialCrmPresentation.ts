import { getStageLabel, type CentralStage, type ContactEligibility,
  type EngagementSource, type LeadStatus, type RouteType, type VerticalStage } from "./socialCrmTypes";

export const ROUTE_LABELS: Record<RouteType, string> = {
  franchise: "Franquia", q3: "Q3", hotmart: "Hotmart", nuy: "Nuy", no_profile: "Sem perfil",
};
export const CENTRAL_LABELS: Record<CentralStage, string> = {
  new_lead: "Novo Lead", first_contact: "Primeiro Contato",
  qualification: "Qualificação", routing: "Direcionamento",
};
export const STATUS_LABELS: Record<LeadStatus, string> = {
  active: "Ativo", awaiting_signal: "Aguardando sinal", won: "Ganho",
  lost: "Perdido", cancelled: "Cancelado",
};
export const SOURCE_LABELS: Record<EngagementSource, string> = {
  realtime: "Realtime", historical_backfill: "Histórico",
  browser_collector: "Browser Collector", manual: "Manual",
};
export const ELIGIBILITY_LABELS: Record<ContactEligibility, string> = {
  eligible: "Elegível", ineligible: "Não elegível", unknown: "Desconhecida",
  not_required: "Não necessária",
};
export const ACTION_LABELS: Record<string, string> = {
  review_profile: "Revisar perfil", present_franchise: "Apresentar franquia",
  evaluate_candidate: "Avaliar candidato", prepare_proposal: "Preparar proposta",
  follow_negotiation: "Acompanhar negociação", confirm_closing: "Confirmar fechamento",
  monitor_implementation: "Acompanhar implantação", review_company: "Revisar empresa",
  perform_diagnosis: "Realizar diagnóstico", present_q3: "Apresentar Q3",
  start_onboarding: "Iniciar onboarding", customer_success: "Acompanhar cliente",
  understand_learning_need: "Entender necessidade de aprendizado",
  recommend_course: "Indicar curso", present_offer: "Apresentar oferta",
  follow_up: "Fazer follow-up", confirm_purchase: "Confirmar compra",
  student_success: "Acompanhar aluno", understand_need: "Entender necessidade",
  identify_need: "Identificar necessidade", recommend_products: "Indicar produtos",
  post_sale_follow_up: "Realizar pós-venda", await_new_signal: "Aguardar novo sinal",
  collect_more_signal: "Coletar mais sinais", human_review: "Revisão humana",
  request_more_context: "Pedir mais contexto",
};

export function actionLabel(action: string | null): string {
  return action ? ACTION_LABELS[action] ?? action.replaceAll("_", " ") : "Sem ação sugerida";
}
export function stageLabel(route: RouteType | null, central: CentralStage,
  vertical: VerticalStage | null): string {
  return vertical && route ? getStageLabel(route, vertical) ?? vertical : CENTRAL_LABELS[central];
}
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}
export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
