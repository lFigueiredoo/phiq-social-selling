import { callPanelFunction } from "@/lib/api/client";

export type ConversationStatus = "open" | "pending" | "waiting_customer" | "resolved" | "blocked";
export type ConversationPriority = "low" | "normal" | "high" | "urgent";

export interface ConversationListItem {
  id: string;
  contact_id: string;
  lead_id: string | null;
  username: string | null;
  external_user_id: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  owner_user_id: string | null;
  owner_email: string | null;
  unread_count: number;
  last_message_at: string;
  last_inbound_at: string | null;
  reply_window_until: string | null;
  sla_due_at: string | null;
  opted_out: boolean;
  route_type: string | null;
  lead_score: number | null;
  lead_status: string | null;
  vertical_stage: string | null;
  latest_message: string;
  latest_direction: "inbound" | "outbound" | null;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  status: string;
  message_text: string;
  provider_message_id: string | null;
  model_name: string | null;
  prompt_version: string | null;
  analysis_summary: string | null;
  created_by_user_id: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  sent_at: string | null;
  eligible_until: string | null;
  last_error: string | null;
  created_at: string;
}

export interface CatalogOffer {
  id: string;
  route_type: string | null;
  offer_kind: "franchise" | "course" | "product" | "service";
  name: string;
  summary: string;
  audience: string;
  approved_claims: string[];
  prohibited_claims?: string[];
  price_text: string | null;
  public_url: string | null;
  active?: boolean;
  sort_order?: number;
}

export interface ConversationMember {
  user_id: string;
  role: "admin" | "reviewer";
  email: string | null;
}

export interface ConversationDetail {
  conversation: ConversationListItem & { last_outbound_at: string | null };
  messages: ConversationMessage[];
  tasks: Array<{ id: string; task_type: string; status: string; title: string; due_at: string; assignee_user_id: string | null }>;
  offers: CatalogOffer[];
  members: ConversationMember[];
}

export interface ConversationsPageData {
  total: number;
  limit: number;
  offset: number;
  items: ConversationListItem[];
}

async function mutate(organizationId: string, body: Record<string, unknown>) {
  return callPanelFunction<{ ok: true; data: unknown }>("panel-conversations", {
    method: "POST",
    body: { organization_id: organizationId, ...body },
  });
}

export const conversationsApi = {
  async list(organizationId: string, filters: { status?: string; owner?: string; search?: string } = {}) {
    const response = await callPanelFunction<{ ok: true; data: ConversationsPageData }>("panel-conversations", {
      query: { view: "list", organization_id: organizationId, limit: 100, ...filters },
    });
    return response.data;
  },
  async detail(organizationId: string, conversationId: string) {
    const response = await callPanelFunction<{ ok: true; data: ConversationDetail }>("panel-conversations", {
      query: { view: "detail", organization_id: organizationId, conversation_id: conversationId },
    });
    return response.data;
  },
  createReply: (organizationId: string, conversationId: string, messageText: string) =>
    mutate(organizationId, { action: "create_reply", conversation_id: conversationId, message_text: messageText, operation_key: crypto.randomUUID() }),
  approveReply: (organizationId: string, messageId: string) =>
    mutate(organizationId, { action: "approve_reply", message_id: messageId }),
  manage: (organizationId: string, conversationId: string, manageAction: string, value?: string) =>
    mutate(organizationId, { action: "manage", conversation_id: conversationId, manage_action: manageAction, value }),
  feedback: (organizationId: string, messageId: string, rating: "accepted" | "edited" | "rejected" | "unsafe") =>
    mutate(organizationId, { action: "feedback", message_id: messageId, rating }),
};

