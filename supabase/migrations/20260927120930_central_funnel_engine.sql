-- F22C: central funnel state and structured assessment, backend only.
alter table public.social_leads
  add column contact_eligibility text not null default 'unknown'
    check (contact_eligibility in ('unknown','eligible','ineligible','not_required')),
  add column eligibility_reason text,
  add column eligibility_checked_at timestamptz,
  add column intent text check (intent in ('commercial_interest','product_interest','franchise_interest',
    'q3_interest','course_interest','support','complaint','engagement','other')),
  add column commercial_potential text check (commercial_potential in ('low','medium','high','unknown')),
  add column signals jsonb not null default '[]'::jsonb check (jsonb_typeof(signals) = 'array'),
  add column qualification_reason text,
  add column needs_more_signal boolean not null default false;

alter table public.social_lead_stage_history
  add column changed_by_id uuid,
  add column details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object');
create index social_lead_history_actor on public.social_lead_stage_history(organization_id, changed_by_id)
  where changed_by_id is not null;

alter table public.social_engagements add column central_processed_at timestamptz;
grant update on public.social_engagements to service_role;

create table public.social_funnel_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  auto_route_threshold numeric(4,3) not null default 0.850,
  more_signal_threshold numeric(4,3) not null default 0.600,
  low_confidence_action text not null default 'no_profile'
    check (low_confidence_action in ('no_profile','qualification')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (more_signal_threshold >= 0 and auto_route_threshold <= 1
    and more_signal_threshold < auto_route_threshold)
);
alter table public.social_funnel_policies enable row level security;
revoke all on public.social_funnel_policies from public, anon, authenticated, service_role;
grant select, insert, update on public.social_funnel_policies to service_role;
create trigger social_funnel_policies_updated before update on public.social_funnel_policies
  for each row execute function public.set_updated_at();

-- The allowed automatic central transitions live in one table.
create table public.social_central_transitions (
  from_stage text not null,
  to_stage text not null,
  condition text not null default 'always' check (condition in ('always','new_signal')),
  primary key (from_stage, to_stage),
  check (from_stage in ('new_lead','first_contact','qualification','routing')),
  check (to_stage in ('new_lead','first_contact','qualification','routing'))
);
insert into public.social_central_transitions(from_stage, to_stage, condition) values
  ('new_lead','first_contact','always'),
  ('first_contact','qualification','always'),
  ('qualification','routing','always'),
  ('routing','qualification','new_signal');
alter table public.social_central_transitions enable row level security;
revoke all on public.social_central_transitions from public, anon, authenticated, service_role;
grant select on public.social_central_transitions to service_role;

-- Prevent actor-less use of the older override switch. Manual edits use the
-- verified manual RPC below and leave a complete audit record.
create or replace function public.transition_social_lead_stage(
  p_organization_id uuid, p_lead_id uuid, p_pipeline text, p_to_stage text,
  p_reason text, p_source text, p_changed_by_type text, p_human_override boolean default false
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_from text; v_next integer; v_current integer;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_human_override or p_source = 'human' or p_changed_by_type = 'human' then
    raise exception 'manual_override_requires_verified_actor' using errcode = '22023';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  if p_pipeline = 'central' then
    v_from := v_lead.central_stage;
    if not exists (select 1 from public.social_central_transitions t
      where t.from_stage = v_from and t.to_stage = p_to_stage
        and (t.condition = 'always' or (t.condition = 'new_signal' and v_lead.route_type = 'no_profile')))
    then raise exception 'invalid_central_transition' using errcode = '22023'; end if;
    update public.social_leads set central_stage = p_to_stage,
      route_type = case when p_to_stage = 'qualification' then null else route_type end,
      vertical_stage = case when p_to_stage = 'qualification' then null else vertical_stage end,
      status = case when p_to_stage = 'qualification' then 'active' else status end,
      first_contact_at = case when p_to_stage = 'first_contact' then coalesce(first_contact_at, now()) else first_contact_at end,
      qualified_at = case when p_to_stage = 'qualification' then now() else qualified_at end,
      routed_at = case when p_to_stage = 'routing' then now() else routed_at end
      where id = p_lead_id;
  elsif p_pipeline = v_lead.route_type and p_pipeline in ('franchise','q3','hotmart','nuy') and v_lead.central_stage = 'routing' then
    v_from := v_lead.vertical_stage;
    v_current := public.social_vertical_stage_position(p_pipeline, v_from);
    v_next := public.social_vertical_stage_position(p_pipeline, p_to_stage);
    if v_next is null or v_current is null or v_next <> v_current + 1 then
      raise exception 'invalid_vertical_transition' using errcode = '22023';
    end if;
    update public.social_leads set vertical_stage = p_to_stage where id = p_lead_id;
  else
    raise exception 'invalid_pipeline' using errcode = '22023';
  end if;
  insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, from_stage, to_stage, reason, source, changed_by_type)
    values (p_organization_id, p_lead_id, p_pipeline, v_from, p_to_stage, p_reason, p_source, p_changed_by_type);
  return p_lead_id;
end $$;

create or replace function public.route_social_lead(
  p_organization_id uuid, p_lead_id uuid, p_route_type text,
  p_confidence numeric, p_lead_score integer, p_reason text,
  p_recommended_next_action text, p_source text, p_changed_by_type text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype;
begin
  if p_source is null or p_source = 'human' or p_changed_by_type is null or p_changed_by_type = 'human' then
    raise exception 'manual_route_requires_verified_actor' using errcode = '22023';
  end if;
  if p_route_type is null or p_route_type not in ('franchise','q3','hotmart','nuy','no_profile')
    or p_confidence is null or p_confidence < 0 or p_confidence > 1
    or p_lead_score is null or p_lead_score < 0 or p_lead_score > 100
    or nullif(btrim(p_reason), '') is null or nullif(btrim(p_recommended_next_action), '') is null then
    raise exception 'invalid_route_contract' using errcode = '22023';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  if v_lead.central_stage <> 'routing' then raise exception 'routing_stage_required' using errcode = '22023'; end if;
  if v_lead.status not in ('active','awaiting_signal') then raise exception 'closed_lead' using errcode = '22023'; end if;
  if v_lead.route_type = p_route_type then raise exception 'route_unchanged' using errcode = '22023'; end if;
  update public.social_leads set route_type = p_route_type, route_confidence = p_confidence,
    lead_score = p_lead_score, route_reason = p_reason,
    recommended_next_action = p_recommended_next_action,
    vertical_stage = case when p_route_type = 'no_profile' then null else 'lead_received' end,
    status = case when p_route_type = 'no_profile' then 'awaiting_signal' else 'active' end,
    routed_at = now() where id = p_lead_id;
  insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, from_stage, to_stage, reason, source, changed_by_type)
    values (p_organization_id, p_lead_id, 'central', v_lead.route_type, p_route_type, p_reason, p_source, p_changed_by_type);
  if p_route_type <> 'no_profile' then
    insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, to_stage, reason, source, changed_by_type)
      values (p_organization_id, p_lead_id, p_route_type, 'lead_received', p_reason, p_source, p_changed_by_type);
  end if;
  return p_lead_id;
end $$;

create function public.process_social_engagement(p_engagement_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_eng public.social_engagements%rowtype; v_lead public.social_leads%rowtype; v_lead_id uuid;
begin
  select * into v_eng from public.social_engagements where id = p_engagement_id for update;
  if not found then raise exception 'engagement_not_found' using errcode = 'P0002'; end if;
  v_lead_id := public.get_or_create_social_lead(v_eng.organization_id, v_eng.contact_id);
  if v_eng.central_processed_at is not null then return v_lead_id; end if;
  select * into v_lead from public.social_leads where id = v_lead_id for update;
  if v_eng.source in ('historical_backfill','browser_collector') and v_lead.contact_eligibility = 'unknown' then
    update public.social_leads set eligibility_reason = v_eng.source || '_does_not_authorize_outbound',
      eligibility_checked_at = now() where id = v_lead_id;
  end if;
  if v_lead.central_stage = 'new_lead'
    and v_eng.engagement_type in ('comment','dm','mention','reply','historical_comment')
    and (select count(*) from public.social_engagements
      where contact_id = v_eng.contact_id
        and engagement_type in ('comment','dm','mention','reply','historical_comment')) >= 2 then
    perform public.transition_social_lead_stage(v_eng.organization_id, v_lead_id, 'central',
      'first_contact', 'relationship_context_identified',
      case when v_eng.source = 'historical_backfill' then 'import' else 'system' end, 'system');
  elsif v_lead.route_type = 'no_profile' and v_eng.source in ('realtime','manual')
      and v_eng.engagement_type in ('comment','dm','mention','reply') then
    perform public.transition_social_lead_stage(v_eng.organization_id, v_lead_id, 'central',
      'qualification', 'new_relevant_engagement', 'system', 'system');
    update public.social_leads set needs_more_signal = true where id = v_lead_id;
  end if;
  update public.social_engagements set central_processed_at = now() where id = p_engagement_id;
  return v_lead_id;
end $$;

create function public.social_engagement_process_trigger()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform public.process_social_engagement(new.id);
  return new;
end $$;
create trigger social_engagement_process after insert on public.social_engagements
  for each row execute function public.social_engagement_process_trigger();

-- Assessment is explicit: no keyword classifier or external model is invoked.
create function public.apply_social_assessment(
  p_organization_id uuid, p_lead_id uuid, p_assessment jsonb, p_source text default 'ai'
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_lead public.social_leads%rowtype;
  v_policy public.social_funnel_policies%rowtype;
  v_intent text := p_assessment->>'intent';
  v_potential text := p_assessment->>'commercial_potential';
  v_route text := p_assessment->>'route_type';
  v_score integer;
  v_confidence numeric;
  v_reason text := nullif(btrim(p_assessment->>'reason'), '');
  v_action text := nullif(btrim(p_assessment->>'recommended_next_action'), '');
  v_signals jsonb := p_assessment->'signals';
begin
  if p_source is null or p_source not in ('ai','system','import')
    or p_assessment is null or jsonb_typeof(p_assessment) <> 'object'
    or v_intent is null or v_intent not in ('commercial_interest','product_interest','franchise_interest','q3_interest',
      'course_interest','support','complaint','engagement','other')
    or v_potential is null or v_potential not in ('low','medium','high','unknown')
    or v_route is null or v_route not in ('franchise','q3','hotmart','nuy','no_profile')
    or v_reason is null or v_action is null or v_signals is null or jsonb_typeof(v_signals) <> 'array'
  then raise exception 'invalid_assessment_contract' using errcode = '22023'; end if;
  if jsonb_array_length(v_signals) > 50
    or exists (select 1 from jsonb_array_elements(v_signals) as s(value)
      where jsonb_typeof(s.value) <> 'string' or length(trim(both '"' from s.value::text)) > 120)
  then raise exception 'invalid_assessment_signals' using errcode = '22023'; end if;
  begin
    v_score := (p_assessment->>'lead_score')::integer;
    v_confidence := (p_assessment->>'confidence')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_assessment_numbers' using errcode = '22023';
  end;
  if v_score is null or v_score < 0 or v_score > 100 or v_confidence is null or v_confidence < 0 or v_confidence > 1 then
    raise exception 'invalid_assessment_numbers' using errcode = '22023';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  if v_lead.central_stage = 'first_contact' then
    perform public.transition_social_lead_stage(p_organization_id, p_lead_id, 'central',
      'qualification', 'structured_assessment_received', p_source, 'system');
  elsif v_lead.central_stage <> 'qualification' then
    raise exception 'qualification_stage_required' using errcode = '22023';
  end if;
  update public.social_leads set intent = v_intent, commercial_potential = v_potential,
    lead_score = v_score, signals = v_signals, qualification_reason = v_reason,
    qualified_at = now(), needs_more_signal = false where id = p_lead_id;
  select * into v_policy from public.social_funnel_policies where organization_id = p_organization_id;
  if not found then
    v_policy.auto_route_threshold := 0.850;
    v_policy.more_signal_threshold := 0.600;
    v_policy.low_confidence_action := 'no_profile';
  end if;
  if v_confidence >= v_policy.auto_route_threshold then
    perform public.transition_social_lead_stage(p_organization_id, p_lead_id, 'central',
      'routing', 'confidence_threshold_met', p_source, 'system');
    perform public.route_social_lead(p_organization_id, p_lead_id, v_route,
      v_confidence, v_score, v_reason, v_action, p_source, 'system');
    return 'routed';
  elsif v_confidence >= v_policy.more_signal_threshold or v_policy.low_confidence_action = 'qualification' then
    update public.social_leads set needs_more_signal = true where id = p_lead_id;
    return 'needs_more_signal';
  else
    perform public.transition_social_lead_stage(p_organization_id, p_lead_id, 'central',
      'routing', 'low_confidence_no_profile', p_source, 'system');
    perform public.route_social_lead(p_organization_id, p_lead_id, 'no_profile',
      v_confidence, v_score, v_reason, v_action, p_source, 'system');
    return 'no_profile';
  end if;
end $$;

-- Human changes require an active organization member and keep an actor ID.
create function public.manual_override_social_lead(
  p_organization_id uuid, p_lead_id uuid, p_actor_user_id uuid,
  p_reason text, p_changes jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_lead public.social_leads%rowtype;
  v_stage text;
  v_route text;
  v_vertical text;
  v_score integer;
  v_pipeline text;
  v_from text;
  v_to text;
begin
  if p_actor_user_id is null or nullif(btrim(p_reason), '') is null
    or p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
    or exists (select 1 from jsonb_object_keys(p_changes) as k(key)
      where k.key not in ('central_stage','route_type','lead_score','intent','commercial_potential','signals','vertical_stage'))
  then raise exception 'invalid_manual_override' using errcode = '22023'; end if;
  if not exists (select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
      and m.status = 'active' and m.role = 'admin') then
    raise exception 'active_admin_required' using errcode = '42501';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  v_stage := coalesce(p_changes->>'central_stage', v_lead.central_stage);
  v_route := case when p_changes ? 'route_type' then p_changes->>'route_type' else v_lead.route_type end;
  v_vertical := case when p_changes ? 'vertical_stage' then p_changes->>'vertical_stage' else v_lead.vertical_stage end;
  if v_stage = 'qualification' and v_lead.central_stage = 'routing' and not (p_changes ? 'route_type') then
    v_route := null;
    v_vertical := null;
  end if;
  if p_changes ? 'signals' then
    if jsonb_typeof(p_changes->'signals') <> 'array' then
      raise exception 'invalid_manual_signals' using errcode = '22023';
    end if;
    if jsonb_array_length(p_changes->'signals') > 50
      or exists (select 1 from jsonb_array_elements(p_changes->'signals') as s(value)
        where jsonb_typeof(s.value) <> 'string' or length(trim(both '"' from s.value::text)) > 120) then
      raise exception 'invalid_manual_signals' using errcode = '22023';
    end if;
  end if;
  begin
    v_score := case when p_changes ? 'lead_score' then (p_changes->>'lead_score')::integer else v_lead.lead_score end;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_lead_score' using errcode = '22023';
  end;
  if v_stage not in ('new_lead','first_contact','qualification','routing')
    or (v_route is not null and v_route not in ('franchise','q3','hotmart','nuy','no_profile'))
    or (v_score is not null and (v_score < 0 or v_score > 100))
    or (p_changes ? 'intent' and p_changes->>'intent' not in ('commercial_interest','product_interest','franchise_interest',
      'q3_interest','course_interest','support','complaint','engagement','other'))
    or (p_changes ? 'commercial_potential' and p_changes->>'commercial_potential' not in ('low','medium','high','unknown'))
    or (p_changes ? 'signals' and jsonb_typeof(p_changes->'signals') <> 'array')
    or (v_route is not null and v_stage <> 'routing')
    or (v_route = 'no_profile' and v_vertical is not null)
    or (v_vertical is not null and public.social_vertical_stage_position(v_route, v_vertical) is null)
  then raise exception 'invalid_manual_override' using errcode = '22023'; end if;
  if v_stage = 'qualification' then v_route := null; v_vertical := null; end if;
  v_pipeline := case when p_changes ? 'vertical_stage' and not (p_changes ? 'central_stage')
    and not (p_changes ? 'route_type') then v_route else 'central' end;
  v_from := case when v_pipeline = 'central' then v_lead.central_stage else v_lead.vertical_stage end;
  v_to := case when v_pipeline = 'central' then v_stage else v_vertical end;
  update public.social_leads set central_stage = v_stage, route_type = v_route,
    vertical_stage = case when v_route = 'no_profile' then null
      when v_route is not null and v_route is distinct from v_lead.route_type and not (p_changes ? 'vertical_stage') then 'lead_received'
      else v_vertical end,
    status = case when v_route = 'no_profile' then 'awaiting_signal' else 'active' end,
    lead_score = v_score,
    intent = case when p_changes ? 'intent' then p_changes->>'intent' else intent end,
    commercial_potential = case when p_changes ? 'commercial_potential' then p_changes->>'commercial_potential' else commercial_potential end,
    signals = case when p_changes ? 'signals' then p_changes->'signals' else signals end,
    qualification_reason = case when p_changes ? 'intent' or p_changes ? 'commercial_potential'
      or p_changes ? 'signals' or p_changes ? 'lead_score' then p_reason else qualification_reason end,
    route_reason = case when p_changes ? 'route_type' then p_reason else route_reason end,
    first_contact_at = case when v_stage = 'first_contact' then coalesce(first_contact_at, now()) else first_contact_at end,
    qualified_at = case when v_stage = 'qualification' then now() else qualified_at end,
    routed_at = case when v_stage = 'routing' then now() else routed_at end
    where id = p_lead_id;
  insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, from_stage,
    to_stage, reason, source, changed_by_type, changed_by_id, details)
    values (p_organization_id, p_lead_id, v_pipeline, v_from, v_to, p_reason,
      'human', 'human', p_actor_user_id, p_changes);
  return p_lead_id;
end $$;

create function public.set_social_contact_eligibility(
  p_organization_id uuid, p_lead_id uuid, p_actor_user_id uuid,
  p_eligibility text, p_reason text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype;
begin
  if p_eligibility not in ('unknown','eligible','ineligible','not_required')
    or p_actor_user_id is null or nullif(btrim(p_reason), '') is null then
    raise exception 'invalid_eligibility_change' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
      and m.status = 'active' and m.role = 'admin') then
    raise exception 'active_admin_required' using errcode = '42501';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  update public.social_leads set contact_eligibility = p_eligibility,
    eligibility_reason = p_reason, eligibility_checked_at = now() where id = p_lead_id;
  insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, from_stage,
    to_stage, reason, source, changed_by_type, changed_by_id, details)
    values (p_organization_id, p_lead_id, 'central', v_lead.central_stage,
      v_lead.central_stage, p_reason, 'human', 'human', p_actor_user_id,
      jsonb_build_object('field','contact_eligibility','from',v_lead.contact_eligibility,'to',p_eligibility));
  return p_lead_id;
end $$;

revoke all on function public.process_social_engagement(uuid),
  public.social_engagement_process_trigger(),
  public.apply_social_assessment(uuid,uuid,jsonb,text),
  public.manual_override_social_lead(uuid,uuid,uuid,text,jsonb),
  public.set_social_contact_eligibility(uuid,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.process_social_engagement(uuid),
  public.social_engagement_process_trigger(),
  public.apply_social_assessment(uuid,uuid,jsonb,text),
  public.manual_override_social_lead(uuid,uuid,uuid,text,jsonb),
  public.set_social_contact_eligibility(uuid,uuid,uuid,text,text)
  to service_role;
