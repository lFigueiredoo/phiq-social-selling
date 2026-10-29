-- F22D: audited classifier result and atomic handoff to F22C.
alter table public.social_leads
  add column classifier_source text check (classifier_source in ('deterministic','ai','fallback','manual')),
  add column prompt_version text,
  add column classified_at timestamptz;

create table public.social_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  lead_id uuid not null,
  engagement_id uuid not null,
  classifier_source text not null check (classifier_source in ('deterministic','ai','fallback','manual')),
  prompt_version text not null check (btrim(prompt_version) <> ''),
  classification jsonb not null check (jsonb_typeof(classification) = 'object'),
  apply_result text not null check (apply_result in ('routed','needs_more_signal','no_profile','deferred')),
  classified_at timestamptz not null default now(),
  unique (engagement_id),
  foreign key (lead_id, organization_id) references public.social_leads(id, organization_id),
  foreign key (engagement_id, organization_id) references public.social_engagements(id, organization_id)
);
create index social_classifications_lead_time on public.social_classifications(organization_id, lead_id, classified_at desc);
alter table public.social_classifications enable row level security;
revoke all on public.social_classifications from public, anon, authenticated, service_role;
grant select, insert on public.social_classifications to service_role;

create function public.save_social_classification(
  p_organization_id uuid, p_lead_id uuid, p_engagement_id uuid,
  p_classification jsonb, p_classifier_source text, p_prompt_version text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_lead public.social_leads%rowtype;
  v_eng public.social_engagements%rowtype;
  v_existing public.social_classifications%rowtype;
  v_id uuid;
  v_result text;
  v_confidence numeric;
  v_score integer;
  v_policy public.social_funnel_policies%rowtype;
  v_source text;
begin
  if p_classifier_source is null or p_classifier_source not in ('deterministic','ai','fallback')
    or nullif(btrim(p_prompt_version), '') is null
    or p_classification is null or jsonb_typeof(p_classification) <> 'object'
    or not (p_classification ?& array['intent','commercial_potential','lead_score','route_type',
      'confidence','reason','recommended_next_action','signals','needs_more_signal'])
    or (select count(*) from jsonb_object_keys(p_classification)) <> 9
    or p_classification->>'intent' is null
    or p_classification->>'intent' not in ('franchise_interest','q3_interest','course_interest',
      'product_interest','commercial_interest','support','complaint','engagement','other')
    or p_classification->>'commercial_potential' is null
    or p_classification->>'commercial_potential' not in ('low','medium','high','unknown')
    or p_classification->>'route_type' is null
    or p_classification->>'route_type' not in ('franchise','q3','hotmart','nuy','no_profile')
    or jsonb_typeof(p_classification->'needs_more_signal') <> 'boolean'
    or jsonb_typeof(p_classification->'signals') <> 'array'
    or nullif(btrim(p_classification->>'reason'), '') is null
    or p_classification->>'recommended_next_action' is null
    or p_classification->>'recommended_next_action' not in
      ('human_review','await_new_signal','request_more_context') then
    raise exception 'invalid_classifier_contract' using errcode = '22023';
  end if;
  if length(p_classification->>'reason') > 240
    or length(p_classification->>'recommended_next_action') > 120
    or jsonb_array_length(p_classification->'signals') > 12
    or exists (select 1 from jsonb_array_elements(p_classification->'signals') as s(value)
      where jsonb_typeof(s.value) <> 'string' or length(btrim(s.value #>> '{}')) > 120)
  then raise exception 'invalid_classifier_contract' using errcode = '22023'; end if;
  begin
    v_confidence := (p_classification->>'confidence')::numeric;
    v_score := (p_classification->>'lead_score')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_classifier_confidence' using errcode = '22023';
  end;
  if v_confidence is null or v_confidence < 0 or v_confidence > 1
    or v_score is null or v_score < 0 or v_score > 100 then
    raise exception 'invalid_classifier_confidence' using errcode = '22023';
  end if;
  select * into v_eng from public.social_engagements
    where id = p_engagement_id and organization_id = p_organization_id for update;
  if not found then raise exception 'engagement_not_found' using errcode = 'P0002'; end if;
  select * into v_lead from public.social_leads
    where id = p_lead_id and organization_id = p_organization_id and contact_id = v_eng.contact_id for update;
  if not found then raise exception 'lead_not_for_engagement' using errcode = '23503'; end if;
  select * into v_existing from public.social_classifications where engagement_id = p_engagement_id;
  if found then
    return jsonb_build_object('classification_id', v_existing.id, 'apply_result', v_existing.apply_result, 'already_exists', true);
  end if;
  select * into v_policy from public.social_funnel_policies where organization_id = p_organization_id;
  if not found then v_policy.auto_route_threshold := 0.850; end if;
  if (p_classification->>'needs_more_signal')::boolean and v_confidence >= v_policy.auto_route_threshold then
    raise exception 'inconsistent_classifier_confidence' using errcode = '22023';
  end if;
  v_source := case when v_eng.source = 'historical_backfill' then 'import'
    when p_classifier_source = 'ai' then 'ai' else 'system' end;
  if v_lead.central_stage = 'new_lead' then
    v_result := 'deferred';
  elsif v_lead.central_stage = 'routing' then
    if v_confidence < v_policy.auto_route_threshold
      or (p_classification->>'needs_more_signal')::boolean then
      update public.social_leads set needs_more_signal = true where id = p_lead_id;
      v_result := 'needs_more_signal';
    elsif v_eng.engagement_type not in ('comment','dm','mention','reply','historical_comment')
      or v_eng.occurred_at < coalesce(v_lead.routed_at, v_lead.created_at) then
      v_result := 'deferred';
    else
      update public.social_leads set central_stage = 'qualification', route_type = null,
        vertical_stage = null, status = 'active', needs_more_signal = true,
        qualified_at = now() where id = p_lead_id;
      insert into public.social_lead_stage_history(organization_id, lead_id, pipeline,
        from_stage, to_stage, reason, source, changed_by_type, details)
        values (p_organization_id, p_lead_id, 'central', 'routing', 'qualification',
          'new_explicit_classifier_signal', v_source, 'system',
          jsonb_build_object('previous_route', v_lead.route_type,
            'previous_confidence', v_lead.route_confidence,
            'new_confidence', v_confidence));
      v_result := public.apply_social_assessment(p_organization_id, p_lead_id, p_classification, v_source);
    end if;
  else
    v_result := public.apply_social_assessment(p_organization_id, p_lead_id, p_classification, v_source);
  end if;
  insert into public.social_classifications(organization_id, lead_id, engagement_id,
    classifier_source, prompt_version, classification, apply_result)
    values (p_organization_id, p_lead_id, p_engagement_id,
      p_classifier_source, p_prompt_version, p_classification, v_result)
    returning id into v_id;
  update public.social_leads set classifier_source = p_classifier_source,
    prompt_version = p_prompt_version, classified_at = now() where id = p_lead_id;
  return jsonb_build_object('classification_id', v_id, 'apply_result', v_result, 'already_exists', false);
end $$;

revoke all on function public.save_social_classification(uuid,uuid,uuid,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function public.save_social_classification(uuid,uuid,uuid,jsonb,text,text)
  to service_role;
