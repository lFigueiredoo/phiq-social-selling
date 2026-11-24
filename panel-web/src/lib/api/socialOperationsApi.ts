import { callPanelFunction } from "@/lib/api/client";
import type { CatalogOffer } from "@/lib/api/conversationsApi";

export interface SocialSettings {
  response_sla_minutes: number;
  retention_days: number;
  retention_enabled: boolean;
  auto_assign_enabled: boolean;
  auto_suggest_enabled: boolean;
  conversation_daily_limit: number;
}

export interface OperationalAlert {
  id: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged";
  title: string;
  details: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

export interface SocialOperationsSummary {
  metrics: {
    open_conversations: number;
    unread_conversations: number;
    sla_overdue: number;
    inbound_24h: number;
    outbound_sent_24h: number;
    private_replies_sent_24h: number;
    won_leads: number;
    active_leads: number;
    model_acceptance_rate: number;
  };
  settings: SocialSettings;
  alerts: OperationalAlert[];
  offers: CatalogOffer[];
  feedback: { total: number; edited: number; rejected: number };
}

async function mutate(organizationId: string, body: Record<string, unknown>) {
  return callPanelFunction<{ ok: true; data: unknown }>("panel-social-operations", {
    method: "POST",
    body: { organization_id: organizationId, ...body },
  });
}

export const socialOperationsApi = {
  async get(organizationId: string) {
    const response = await callPanelFunction<{ ok: true; data: SocialOperationsSummary }>("panel-social-operations", {
      query: { organization_id: organizationId },
    });
    return response.data;
  },
  updateSettings: (organizationId: string, settings: SocialSettings) =>
    mutate(organizationId, { action: "update_settings", ...settings }),
  saveOffer: (organizationId: string, offer: Partial<CatalogOffer> & Pick<CatalogOffer, "name" | "offer_kind">) =>
    mutate(organizationId, { action: "upsert_offer", ...offer }),
  acknowledgeAlert: (organizationId: string, alertId: string, resolve = false) =>
    mutate(organizationId, { action: resolve ? "resolve_alert" : "ack_alert", alert_id: alertId }),
  eraseContact: (organizationId: string, contactId: string, reason: string) =>
    mutate(organizationId, { action: "erase_contact", contact_id: contactId, reason }),
};

