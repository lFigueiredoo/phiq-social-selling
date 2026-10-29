-- Keep the CRM read view as security-invoker while allowing the service-only
-- panel API to resolve an owner's email without granting service_role broad
-- SELECT access to auth.users.
create function public.panel_social_owner_email(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from auth.users u
  where u.id = p_user_id
$$;

revoke all on function public.panel_social_owner_email(uuid)
  from public, anon, authenticated;
grant execute on function public.panel_social_owner_email(uuid)
  to service_role;

create or replace view public.panel_social_lead_rows
with (security_invoker = true) as
select l.id,l.organization_id,l.contact_id,l.central_stage,l.route_type,l.vertical_stage,
  l.status,l.owner_user_id,public.panel_social_owner_email(l.owner_user_id) as owner_email,
  l.lead_score,l.route_confidence,l.route_reason,l.recommended_next_action,
  l.intent,l.commercial_potential,l.signals,l.qualification_reason,l.needs_more_signal,
  l.contact_eligibility,l.eligibility_reason,l.eligibility_checked_at,
  l.classifier_source,l.prompt_version,l.classified_at,
  l.first_contact_at,l.qualified_at,l.routed_at,l.vertical_stage_entered_at,
  l.closed_at,l.won_at,l.lost_at,l.created_at,l.updated_at,
  c.username,c.display_name,c.profile_url,c.external_user_id,c.first_seen_at,
  c.last_seen_at,c.engagement_count,
  last_e.id as last_engagement_id,last_e.source as last_source,
  last_e.engagement_type as last_engagement_type,last_e.occurred_at as last_interaction_at,
  last_e.classification_status,last_e.pipeline_error_code,
  last_e.pipeline_processed_at
from public.social_leads l
join public.social_contacts c on c.id=l.contact_id and c.organization_id=l.organization_id
left join lateral (
  select e.id,e.source,e.engagement_type,e.occurred_at,e.classification_status,
    e.pipeline_error_code,e.pipeline_processed_at
  from public.social_engagements e
  where e.organization_id=l.organization_id and e.contact_id=l.contact_id
  order by e.occurred_at desc,e.id desc limit 1
) last_e on true;

revoke all on public.panel_social_lead_rows
  from public, anon, authenticated, service_role;
grant select on public.panel_social_lead_rows to service_role;

comment on function public.panel_social_owner_email(uuid) is
  'Service-only, least-privilege owner email resolver used by the CRM read view.';
