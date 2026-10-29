import { callPanelFunction } from "@/lib/api/client";
import type { SocialDashboard, SocialLeadRow, SocialMember, SocialTimelineEvent } from "@/lib/api/socialCrmTypes";

export interface SocialFilters {
  route?: string;
  central_stage?: string;
  vertical_stage?: string;
  status?: string;
  owner?: string;
  source?: string;
  eligibility?: string;
  classification_status?: string;
  score_min?: number;
  confidence_min?: number;
  needs_more_signal?: boolean;
  unassigned?: boolean;
  from?: string;
  to?: string;
  search?: string;
}
export type SocialSort = "recent" | "score" | "confidence" | "created" | "priority";
export interface SocialPage { total: number; limit: number; offset: number; }
export interface SocialLeadsPage extends SocialPage { leads: SocialLeadRow[]; }
export interface SocialTimelinePage extends SocialPage { events: SocialTimelineEvent[]; }

function cleanFilters(filters: SocialFilters): SocialFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) =>
    value !== undefined && value !== null && value !== "")) as SocialFilters;
}

export const socialCrmApi = {
  async getDashboard(organizationId: string) {
    const response = await callPanelFunction<{ ok: true; data: SocialDashboard }>("panel-social-crm", {
      query: { view: "dashboard", organization_id: organizationId },
    });
    return response.data;
  },
  async getLeads(organizationId: string, filters: SocialFilters, sort: SocialSort, offset: number, limit = 25) {
    const response = await callPanelFunction<{ ok: true; data: SocialLeadsPage }>("panel-social-crm", {
      query: { view: "leads", organization_id: organizationId,
        filters: JSON.stringify(cleanFilters(filters)), sort, offset, limit },
    });
    return response.data;
  },
  async getLead(organizationId: string, leadId: string) {
    const response = await callPanelFunction<{ ok: true; data: SocialLeadRow }>("panel-social-crm", {
      query: { view: "lead", organization_id: organizationId, lead_id: leadId },
    });
    return response.data;
  },
  async getTimeline(organizationId: string, leadId: string, offset: number, limit = 50) {
    const response = await callPanelFunction<{ ok: true; data: SocialTimelinePage }>("panel-social-crm", {
      query: { view: "timeline", organization_id: organizationId, lead_id: leadId, offset, limit },
    });
    return response.data;
  },
  async getMembers(organizationId: string) {
    const response = await callPanelFunction<{ ok: true; data: SocialMember[] }>("panel-social-crm", {
      query: { view: "members", organization_id: organizationId },
    });
    return response.data;
  },
  async mutate(organizationId: string, leadId: string, action: string, reason: string,
    changes: Record<string, unknown>) {
    const response = await callPanelFunction<{ ok: true; lead: SocialLeadRow; operation_key: string }>("panel-social-crm", {
      method: "POST", body: { organization_id: organizationId, lead_id: leadId,
        action, reason, operation_key: crypto.randomUUID(), ...changes },
    });
    return response.lead;
  },
};
