-- F22G: service-only read model. Every public RPC checks active membership.
create view public.panel_social_lead_rows with (security_invoker=true) as
select l.id,l.organization_id,l.contact_id,l.central_stage,l.route_type,l.vertical_stage,
  l.status,l.owner_user_id,owner_user.email::text as owner_email,
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
left join auth.users owner_user on owner_user.id=l.owner_user_id
left join lateral (
  select e.id,e.source,e.engagement_type,e.occurred_at,e.classification_status,
    e.pipeline_error_code,e.pipeline_processed_at
  from public.social_engagements e
  where e.organization_id=l.organization_id and e.contact_id=l.contact_id
  order by e.occurred_at desc,e.id desc limit 1
) last_e on true;
revoke all on public.panel_social_lead_rows from public,anon,authenticated,service_role;
grant select on public.panel_social_lead_rows to service_role;
create index social_leads_org_created on public.social_leads(organization_id,created_at desc,id);
create index social_leads_org_owner on public.social_leads(organization_id,owner_user_id);
create index social_engagements_org_time on public.social_engagements(organization_id,occurred_at desc,id);

create function public.panel_social_leads(
  p_user_id uuid,p_organization_id uuid,p_filters jsonb default '{}'::jsonb,
  p_limit integer default 25,p_offset integer default 0,p_sort text default 'recent'
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb; v_search text;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if p_filters is null or jsonb_typeof(p_filters)<>'object'
    or p_limit<1 or p_limit>100 or p_offset<0
    or p_sort not in ('recent','score','confidence','created','priority')
    or exists(select 1 from jsonb_object_keys(p_filters) k(key) where k.key not in
      ('route','central_stage','vertical_stage','status','owner','source','eligibility',
       'score_min','confidence_min','needs_more_signal','from','to','search','unassigned','classification_status'))
    then raise exception 'invalid_lead_filters' using errcode='22023'; end if;
  if (p_filters ? 'route' and p_filters->>'route' not in ('franchise','q3','hotmart','nuy','no_profile'))
    or (p_filters ? 'central_stage' and p_filters->>'central_stage' not in
      ('new_lead','first_contact','qualification','routing'))
    or (p_filters ? 'status' and p_filters->>'status' not in
      ('active','awaiting_signal','won','lost','cancelled'))
    or (p_filters ? 'source' and p_filters->>'source' not in
      ('realtime','historical_backfill','browser_collector','manual'))
    or (p_filters ? 'eligibility' and p_filters->>'eligibility' not in
      ('unknown','eligible','ineligible','not_required'))
    or (p_filters ? 'classification_status' and p_filters->>'classification_status' not in
      ('pending','completed','failed_retryable','failed_terminal','not_required'))
    then raise exception 'invalid_lead_filters' using errcode='22023'; end if;
  v_search:=nullif(lower(btrim(p_filters->>'search')),'');
  if length(coalesce(v_search,''))>100 then raise exception 'invalid_search' using errcode='22023'; end if;
  begin
    with filtered as materialized (
      select * from public.panel_social_lead_rows r
      where r.organization_id=p_organization_id
        and (not p_filters ? 'route' or r.route_type=p_filters->>'route')
        and (not p_filters ? 'central_stage' or r.central_stage=p_filters->>'central_stage')
        and (not p_filters ? 'vertical_stage' or r.vertical_stage=p_filters->>'vertical_stage')
        and (not p_filters ? 'status' or r.status=p_filters->>'status')
        and (not p_filters ? 'owner' or r.owner_user_id=(p_filters->>'owner')::uuid)
        and (not p_filters ? 'unassigned' or (p_filters->>'unassigned')::boolean=false
          or r.owner_user_id is null)
        and (not p_filters ? 'source' or r.last_source=p_filters->>'source')
        and (not p_filters ? 'eligibility' or r.contact_eligibility=p_filters->>'eligibility')
        and (not p_filters ? 'score_min' or r.lead_score>=(p_filters->>'score_min')::integer)
        and (not p_filters ? 'confidence_min' or r.route_confidence>=(p_filters->>'confidence_min')::numeric)
        and (not p_filters ? 'needs_more_signal' or r.needs_more_signal=(p_filters->>'needs_more_signal')::boolean)
        and (not p_filters ? 'classification_status' or r.classification_status=p_filters->>'classification_status')
        and (not p_filters ? 'from' or r.last_interaction_at>=(p_filters->>'from')::timestamptz)
        and (not p_filters ? 'to' or r.last_interaction_at<=(p_filters->>'to')::timestamptz)
        and (v_search is null or lower(coalesce(r.username,'')) like '%'||v_search||'%'
          or lower(coalesce(r.display_name,'')) like '%'||v_search||'%')
    )
    select jsonb_build_object('total',(select count(*) from filtered),
      'limit',p_limit,'offset',p_offset,
      'leads',coalesce((select jsonb_agg(to_jsonb(page)) from (
        select * from filtered
        order by
          case when p_sort='priority' then
            case when classification_status in ('pending','failed_retryable','failed_terminal') then 3
              when needs_more_signal or status='awaiting_signal' then 2
              when owner_user_id is null and status='active' then 1 else 0 end end desc nulls last,
          case when p_sort='score' then lead_score end desc nulls last,
          case when p_sort='confidence' then route_confidence end desc nulls last,
          case when p_sort='created' then created_at end desc nulls last,
          case when p_sort='recent' then last_interaction_at end desc nulls last,
          last_interaction_at desc nulls last,id desc
        limit p_limit offset p_offset
      ) page),'[]'::jsonb)) into v_result;
  exception when invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range then
    raise exception 'invalid_lead_filters' using errcode='22023';
  end;
  return v_result;
end $$;

create function public.panel_social_dashboard(p_user_id uuid,p_organization_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  select jsonb_build_object(
    'kpis',jsonb_build_object(
      'active',count(*) filter(where status='active'),
      'new_leads',count(*) filter(where central_stage='new_lead'),
      'qualification',count(*) filter(where central_stage='qualification'),
      'routed',count(*) filter(where route_type in ('franchise','q3','hotmart','nuy')),
      'no_profile',count(*) filter(where route_type='no_profile'),
      'franchise',count(*) filter(where route_type='franchise'),
      'q3',count(*) filter(where route_type='q3'),
      'hotmart',count(*) filter(where route_type='hotmart'),
      'nuy',count(*) filter(where route_type='nuy'),
      'won',count(*) filter(where status='won'),
      'lost',count(*) filter(where status='lost'),
      'awaiting_signal',count(*) filter(where status='awaiting_signal'),
      'unassigned',count(*) filter(where owner_user_id is null and status='active'),
      'classification_pending',count(*) filter(where classification_status in
        ('pending','failed_retryable','failed_terminal')),
      'needs_action',count(*) filter(where status='active' and recommended_next_action is not null)),
    'recent_interactions',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select id,username,display_name,last_source,last_engagement_type,last_interaction_at,
        route_type,status from public.panel_social_lead_rows
      where organization_id=p_organization_id and last_interaction_at is not null
      order by last_interaction_at desc limit 5) x),'[]'::jsonb),
    'unassigned_leads',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select id,username,display_name,route_type,lead_score,last_interaction_at
      from public.panel_social_lead_rows where organization_id=p_organization_id
        and owner_user_id is null and status='active'
      order by last_interaction_at desc nulls last limit 5) x),'[]'::jsonb),
    'pending_leads',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select id,username,display_name,classification_status,pipeline_error_code,
        pipeline_processed_at,last_interaction_at
      from public.panel_social_lead_rows where organization_id=p_organization_id
        and classification_status in ('pending','failed_retryable','failed_terminal')
      order by last_interaction_at desc nulls last limit 5) x),'[]'::jsonb))
    into v_result from public.panel_social_lead_rows where organization_id=p_organization_id;
  return v_result;
end $$;

create function public.panel_social_lead_detail(p_user_id uuid,p_organization_id uuid,p_lead_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  select to_jsonb(r) into v_result from public.panel_social_lead_rows r
    where r.id=p_lead_id and r.organization_id=p_organization_id;
  if v_result is null then raise exception 'lead_not_found' using errcode='P0002'; end if;
  return v_result;
end $$;

create function public.panel_social_lead_timeline(
  p_user_id uuid,p_organization_id uuid,p_lead_id uuid,p_limit integer default 50,p_offset integer default 0
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if p_limit<1 or p_limit>100 or p_offset<0 then
    raise exception 'invalid_pagination' using errcode='22023'; end if;
  if not exists(select 1 from public.social_leads where id=p_lead_id and organization_id=p_organization_id)
    then raise exception 'lead_not_found' using errcode='P0002'; end if;
  with events as materialized (
    select e.id,'interaction'::text kind,e.occurred_at at,
      jsonb_build_object('engagement_type',e.engagement_type,'source',e.source,
        'text',coalesce(nullif(e.metadata->>'text',''),(
          select change->'value'->>'text'
          from public.webhook_events w,
            lateral jsonb_array_elements(coalesce(w.payload->'entry','[]'::jsonb)) entry,
            lateral jsonb_array_elements(coalesce(entry->'changes','[]'::jsonb)) change
          where w.id=e.webhook_event_id and change->'value'->>'id'=e.external_engagement_id
          limit 1)),
        'media_permalink',e.media_permalink,'media_external_id',e.media_external_id,
        'classification_status',e.classification_status,'error_code',e.pipeline_error_code,
        'pipeline_processed_at',e.pipeline_processed_at) info
    from public.social_engagements e join public.social_leads l on l.contact_id=e.contact_id
      and l.organization_id=e.organization_id
    where l.id=p_lead_id and l.organization_id=p_organization_id
    union all
    select h.id,case when h.source in ('human','manual') then 'manual_action' else 'stage_change' end,
      h.changed_at,jsonb_build_object('pipeline',h.pipeline,'route_type',h.route_type,
        'from_stage',h.from_stage,'to_stage',h.to_stage,'from_status',h.from_status,
        'to_status',h.to_status,'reason',h.reason,'source',h.source,
        'changed_by_id',h.changed_by_id,'details',h.details)
    from public.social_lead_stage_history h
    where h.lead_id=p_lead_id and h.organization_id=p_organization_id
    union all
    select c.id,'classification',c.classified_at,
      jsonb_build_object('classifier_source',c.classifier_source,'prompt_version',c.prompt_version,
        'route_type',c.classification->>'route_type','lead_score',c.classification->>'lead_score',
        'confidence',c.classification->>'confidence','reason',c.classification->>'reason',
        'apply_result',c.apply_result)
    from public.social_classifications c
    where c.lead_id=p_lead_id and c.organization_id=p_organization_id
  )
  select jsonb_build_object('total',(select count(*) from events),'limit',p_limit,'offset',p_offset,
    'events',coalesce((select jsonb_agg(to_jsonb(page)) from (
      select * from events order by at desc,id desc limit p_limit offset p_offset
    ) page),'[]'::jsonb)) into v_result;
  return v_result;
end $$;

create function public.panel_social_members(p_user_id uuid,p_organization_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,
    'role',m.role) order by u.email),'[]'::jsonb) into v_result
  from public.organization_members m join auth.users u on u.id=m.user_id
  where m.organization_id=p_organization_id and m.status='active';
  return v_result;
end $$;

revoke all on function public.panel_social_leads(uuid,uuid,jsonb,integer,integer,text),
  public.panel_social_dashboard(uuid,uuid),public.panel_social_lead_detail(uuid,uuid,uuid),
  public.panel_social_lead_timeline(uuid,uuid,uuid,integer,integer),
  public.panel_social_members(uuid,uuid) from public,anon,authenticated;
grant execute on function public.panel_social_leads(uuid,uuid,jsonb,integer,integer,text),
  public.panel_social_dashboard(uuid,uuid),public.panel_social_lead_detail(uuid,uuid,uuid),
  public.panel_social_lead_timeline(uuid,uuid,uuid,integer,integer),
  public.panel_social_members(uuid,uuid) to service_role;
-- Human transition with an expected stage.
create function public.panel_social_transition_vertical(
  p_user_id uuid,p_organization_id uuid,p_lead_id uuid,p_expected_stage text,
  p_to_stage text,p_operation_key text,p_reason text,p_override boolean default false
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_lead public.social_leads%rowtype;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  select * into v_lead from public.social_leads where id=p_lead_id
    and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if v_lead.vertical_stage is distinct from p_expected_stage then
    raise exception 'stage_conflict' using errcode='P0001'; end if;
  if not p_override and not exists(select 1 from public.social_vertical_transitions t
    where t.route_type=v_lead.route_type and t.from_stage=p_expected_stage and t.to_stage=p_to_stage)
    then raise exception 'invalid_vertical_transition' using errcode='22023'; end if;
  return public.manual_transition_vertical_lead_stage(p_organization_id,p_lead_id,p_user_id,
    p_to_stage,p_operation_key,p_reason);
end $$;
revoke all on function public.panel_social_transition_vertical(uuid,uuid,uuid,text,text,text,text,boolean)
  from public,anon,authenticated;
grant execute on function public.panel_social_transition_vertical(uuid,uuid,uuid,text,text,text,text,boolean)
  to service_role;
-- Manual route changes retain the previous pipeline and an explicit route-change record.
create function public.panel_social_reclassify_route(
  p_user_id uuid,p_organization_id uuid,p_lead_id uuid,p_route_type text,
  p_operation_key text,p_reason text
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  if p_route_type not in ('franchise','q3','hotmart','nuy','no_profile')
    or nullif(btrim(p_reason),'') is null or nullif(btrim(p_operation_key),'') is null
    then raise exception 'invalid_route_change' using errcode='22023'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id
    and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.social_lead_stage_history h
    where h.organization_id=p_organization_id and h.operation_key=p_operation_key
      and h.lead_id=p_lead_id and h.to_stage=p_route_type
      and h.source='manual' and h.changed_by_id=p_user_id and h.reason=p_reason)
    then return p_lead_id; end if;
  if v_lead.central_stage<>'routing' or v_lead.status not in ('active','awaiting_signal')
    or v_lead.route_type=p_route_type
    then raise exception 'invalid_route_change' using errcode='22023'; end if;
  update public.social_leads set route_type=p_route_type,
    vertical_stage=case when p_route_type='no_profile' then null else 'lead_received' end,
    status=case when p_route_type='no_profile' then 'awaiting_signal' else 'active' end,
    route_confidence=null,route_reason=p_reason,classifier_source='manual',
    prompt_version=null,classified_at=clock_timestamp(),routed_at=clock_timestamp()
    where id=p_lead_id returning * into v_after;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,
    from_stage,to_stage,reason,source,changed_by_type,changed_by_id,route_type,
    from_status,to_status,operation_key,details)
    values(p_organization_id,p_lead_id,'central',v_lead.route_type,p_route_type,
      p_reason,'manual','human',p_user_id,p_route_type,v_lead.status,v_after.status,
      p_operation_key,jsonb_build_object('previous_route',v_lead.route_type,'new_route',p_route_type));
  if p_route_type<>'no_profile' then
    insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,
      from_stage,to_stage,reason,source,changed_by_type,changed_by_id,route_type,
      from_status,to_status,details)
      values(p_organization_id,p_lead_id,p_route_type,v_lead.vertical_stage,'lead_received',
        p_reason,'manual','human',p_user_id,p_route_type,v_lead.status,v_after.status,
        jsonb_build_object('previous_route',v_lead.route_type,'new_route',p_route_type));
  end if;
  return p_lead_id;
end $$;
revoke all on function public.panel_social_reclassify_route(uuid,uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.panel_social_reclassify_route(uuid,uuid,uuid,text,text,text)
  to service_role;
