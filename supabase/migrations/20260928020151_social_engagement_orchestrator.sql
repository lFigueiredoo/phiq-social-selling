-- F22F: transactional boundaries around one social engagement.
alter table public.social_engagements
  add column classification_status text check (classification_status in
    ('pending','completed','failed_retryable','failed_terminal','not_required')),
  add column pipeline_processed_at timestamptz,
  add column pipeline_error_code text;
create index social_engagements_classification_pending
  on public.social_engagements(organization_id,classification_status,created_at)
  where classification_status in ('pending','failed_retryable');

-- The engagement trigger must not manufacture another lead for a won or
-- manually closed opportunity. Contact serialization happens in phase A.
create or replace function public.process_social_engagement(p_engagement_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_eng public.social_engagements%rowtype; v_lead public.social_leads%rowtype; v_lead_id uuid;
begin
  select * into v_eng from public.social_engagements where id=p_engagement_id for update;
  if not found then raise exception 'engagement_not_found' using errcode='P0002'; end if;
  select * into v_lead from public.social_leads where organization_id=v_eng.organization_id
    and contact_id=v_eng.contact_id order by
      case when status in ('active','awaiting_signal') then 0 else 1 end,
      created_at desc,id desc limit 1 for update;
  if not found then
    v_lead_id:=public.get_or_create_social_lead(v_eng.organization_id,v_eng.contact_id);
    select * into v_lead from public.social_leads where id=v_lead_id for update;
  else v_lead_id:=v_lead.id; end if;
  if v_eng.central_processed_at is not null then return v_lead_id; end if;
  if v_eng.source in ('historical_backfill','browser_collector') and v_lead.contact_eligibility='unknown' then
    update public.social_leads set eligibility_reason=v_eng.source||'_does_not_authorize_outbound',
      eligibility_checked_at=clock_timestamp() where id=v_lead_id;
  end if;
  if v_lead.status in ('active','awaiting_signal') then
    if v_lead.central_stage='new_lead'
      and v_eng.engagement_type in ('comment','dm','mention','reply','historical_comment')
      and (select count(*) from public.social_engagements where contact_id=v_eng.contact_id
        and engagement_type in ('comment','dm','mention','reply','historical_comment'))>=2 then
      perform public.transition_social_lead_stage(v_eng.organization_id,v_lead_id,'central',
        'first_contact','relationship_context_identified',
        case when v_eng.source='historical_backfill' then 'import' else 'system' end,'system');
    elsif v_lead.route_type='no_profile' and v_eng.source in ('realtime','manual')
      and v_eng.engagement_type in ('comment','dm','mention','reply') then
      perform public.transition_social_lead_stage(v_eng.organization_id,v_lead_id,'central',
        'qualification','new_relevant_engagement','system','system');
      update public.social_leads set needs_more_signal=true where id=v_lead_id;
    end if;
  end if;
  update public.social_engagements set central_processed_at=clock_timestamp() where id=p_engagement_id;
  return v_lead_id;
end $$;

create function public.social_pipeline_state(
  p_organization_id uuid,p_lead_id uuid,p_engagement_id uuid,p_result_code text,
  p_already_processed boolean default false,p_actions jsonb default '[]'::jsonb
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'operation_id',e.id,'organization_id',e.organization_id,
    'contact_id',e.contact_id,'engagement_id',e.id,'lead_id',l.id,
    'source',e.source,'central_stage',l.central_stage,
    'qualification',jsonb_build_object('intent',l.intent,'commercial_potential',l.commercial_potential,
      'lead_score',l.lead_score,'signals',l.signals,'qualified_at',l.qualified_at),
    'classification',c.classification,'classification_status',e.classification_status,
    'classifier_source',c.classifier_source,'prompt_version',c.prompt_version,
    'route_type',l.route_type,'vertical_stage',l.vertical_stage,'lead_status',l.status,
    'contact_eligibility',l.contact_eligibility,'recommended_next_action',l.recommended_next_action,
    'needs_more_signal',l.needs_more_signal,'result_code',p_result_code,
    'already_processed',p_already_processed,'actions_performed',p_actions,
    'retryable',e.classification_status in ('pending','failed_retryable'),
    'error_code',e.pipeline_error_code)
  from public.social_engagements e
  join public.social_leads l on l.organization_id=e.organization_id and l.id=p_lead_id
    and l.contact_id=e.contact_id
  left join public.social_classifications c on c.engagement_id=e.id
  where e.id=p_engagement_id and e.organization_id=p_organization_id
$$;

create function public.prepare_social_engagement_pipeline(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_org uuid; v_account uuid; v_event uuid; v_contact uuid; v_eng uuid; v_lead uuid;
  v_contact_exists boolean; v_eng_exists boolean; v_lead_exists boolean;
  v_source text; v_type text; v_external text; v_text text; v_metadata jsonb;
  v_occurred timestamptz; v_state jsonb; v_context jsonb;
begin
  if p_input is null or jsonb_typeof(p_input)<>'object'
    or exists(select 1 from jsonb_object_keys(p_input) k(key) where k.key not in
      ('organization_id','instagram_account_id','webhook_event_id','external_user_id','username',
       'display_name','engagement_type','external_engagement_id','media_external_id',
       'media_permalink','text','source','occurred_at','metadata'))
    then raise exception 'invalid_pipeline_input' using errcode='22023'; end if;
  begin
    v_org:=(p_input->>'organization_id')::uuid;
    v_account:=(p_input->>'instagram_account_id')::uuid;
    v_event:=nullif(p_input->>'webhook_event_id','')::uuid;
    v_occurred:=coalesce((p_input->>'occurred_at')::timestamptz,clock_timestamp());
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid_pipeline_identifiers' using errcode='22023';
  end;
  v_source:=p_input->>'source'; v_type:=p_input->>'engagement_type';
  v_external:=nullif(btrim(p_input->>'external_engagement_id'),'');
  v_text:=p_input->>'text'; v_metadata:=coalesce(p_input->'metadata','{}'::jsonb);
  if v_org is null or v_account is null or v_source is null or v_source not in
      ('realtime','historical_backfill','browser_collector','manual')
    or v_type is null or v_type not in ('comment','dm','mention','reply','like','historical_comment','other')
    or (v_external is null and v_event is null)
    or (nullif(btrim(p_input->>'external_user_id'),'') is null
      and nullif(btrim(p_input->>'username'),'') is null)
    or length(coalesce(v_external,''))>250 or length(coalesce(v_text,''))>2000
    or (p_input ? 'display_name' and length(coalesce(p_input->>'display_name',''))>250)
    or jsonb_typeof(v_metadata)<>'object' or pg_catalog.pg_column_size(v_metadata)>2048
    or (p_input ? 'media_permalink' and p_input->>'media_permalink' !~ '^https://')
    then raise exception 'invalid_pipeline_input' using errcode='22023'; end if;
  -- Account row lock serializes identity creation, duplicate delivery and lead selection.
  perform 1 from public.instagram_accounts where id=v_account and organization_id=v_org
    and status='active' for update;
  if not found then raise exception 'account_not_in_organization' using errcode='P0002'; end if;
  v_contact_exists:=exists(select 1 from public.social_contacts where organization_id=v_org
    and instagram_account_id=v_account and
    ((nullif(btrim(p_input->>'external_user_id'),'') is not null
       and external_user_id=nullif(btrim(p_input->>'external_user_id'),''))
     or (nullif(btrim(p_input->>'username'),'') is not null
       and username_normalized=lower(btrim(p_input->>'username')))));
  v_contact:=public.upsert_social_contact(v_org,v_account,p_input->>'external_user_id',
    p_input->>'username',v_occurred);
  if nullif(btrim(p_input->>'display_name'),'') is not null then
    update public.social_contacts set display_name=left(p_input->>'display_name',250)
      where id=v_contact and (display_name is null or display_name='');
  end if;
  v_eng_exists:=exists(select 1 from public.social_engagements where organization_id=v_org
    and instagram_account_id=v_account and
    ((v_event is not null and webhook_event_id=v_event)
      or (v_external is not null and external_engagement_id=v_external and engagement_type=v_type)));
  v_lead_exists:=exists(select 1 from public.social_leads where organization_id=v_org and contact_id=v_contact);
  v_metadata:=v_metadata || jsonb_build_object('text',coalesce(v_text,''));
  v_eng:=public.record_social_engagement(v_org,v_contact,v_account,v_event,v_external,
    v_type,v_source,v_occurred,p_input->>'media_external_id',v_metadata);
  if v_eng is null then raise exception 'engagement_not_recorded' using errcode='P0002'; end if;
  if not v_eng_exists and nullif(btrim(p_input->>'media_permalink'),'') is not null then
    update public.social_engagements set media_permalink=p_input->>'media_permalink' where id=v_eng;
  end if;
  if not exists(select 1 from public.social_engagements where id=v_eng and organization_id=v_org
    and contact_id=v_contact and instagram_account_id=v_account) then
    raise exception 'engagement_identity_conflict' using errcode='23505'; end if;
  select id into v_lead from public.social_leads where organization_id=v_org and contact_id=v_contact
    order by case when status in ('active','awaiting_signal') then 0 else 1 end,
      created_at desc,id desc limit 1;
  if v_lead is null then v_lead:=public.get_or_create_social_lead(v_org,v_contact); end if;
  if not v_eng_exists then
    update public.social_engagements set classification_status='pending' where id=v_eng;
  end if;
  v_state:=public.social_pipeline_state(v_org,v_lead,v_eng,
    case when v_eng_exists and exists(select 1 from public.social_engagements
      where id=v_eng and classification_status in ('completed','not_required'))
      then 'already_processed'
      when exists(select 1 from public.social_leads where id=v_lead and status in ('lost','cancelled','won'))
      then 'lead_closed' else 'classification_pending' end,
    v_eng_exists and exists(select 1 from public.social_engagements
      where id=v_eng and classification_status in ('completed','not_required')),
    case when v_eng_exists then '[]'::jsonb
      else jsonb_build_array('contact_upserted','engagement_recorded',
        case when v_lead_exists then 'lead_reused' else 'lead_created' end) end);
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'external_engagement_id',s.external_engagement_id,
    'engagement_type',s.engagement_type,
    'source',s.source,'occurred_at',s.occurred_at,'metadata',s.metadata,
    'webhook_payload',s.payload) order by s.target_order,s.occurred_at desc),'[]'::jsonb)
    into v_context from (
      select e.id,e.external_engagement_id,e.engagement_type,e.source,e.occurred_at,e.metadata,w.payload,
        case when e.id=v_eng then 0 else 1 end target_order
      from public.social_engagements e
      left join public.webhook_events w on w.id=e.webhook_event_id and w.organization_id=e.organization_id
      where e.organization_id=v_org and e.contact_id=v_contact
      order by case when e.id=v_eng then 0 else 1 end,e.occurred_at desc
      limit 9
    ) s;
  return v_state || jsonb_build_object('created_contact',not v_contact_exists,
    'created_engagement',not v_eng_exists,'created_lead',not v_lead_exists,
    'context_snapshot',v_context);
end $$;

create function public.skip_social_engagement_pipeline(
  p_organization_id uuid,p_lead_id uuid,p_engagement_id uuid,p_result_code text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_eng public.social_engagements%rowtype; v_lead public.social_leads%rowtype;
begin
  if p_result_code not in ('lead_closed','needs_more_signal') then
    raise exception 'invalid_skip_result' using errcode='22023'; end if;
  select * into v_eng from public.social_engagements where id=p_engagement_id
    and organization_id=p_organization_id for update;
  if not found then raise exception 'engagement_not_found' using errcode='P0002'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id
    and contact_id=v_eng.contact_id for update;
  if not found then raise exception 'lead_not_for_engagement' using errcode='23503'; end if;
  if p_result_code='lead_closed' and v_lead.status not in ('won','lost','cancelled') then
    raise exception 'lead_not_closed' using errcode='22023'; end if;
  if p_result_code='needs_more_signal' and not
    (v_eng.source='browser_collector' and v_eng.engagement_type='like') then
    raise exception 'skip_requires_weak_signal' using errcode='22023'; end if;
  if v_eng.classification_status in ('completed','not_required') then
    return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,'already_processed',true);
  end if;
  update public.social_engagements set classification_status='not_required',
    pipeline_processed_at=clock_timestamp(),pipeline_error_code=null where id=p_engagement_id;
  return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,p_result_code,false,
    jsonb_build_array('engagement_recorded'));
end $$;

create function public.complete_social_engagement_pipeline(
  p_organization_id uuid,p_lead_id uuid,p_engagement_id uuid,p_classification jsonb,
  p_classifier_source text,p_prompt_version text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_eng public.social_engagements%rowtype; v_lead public.social_leads%rowtype;
  v_saved jsonb; v_code text;
begin
  select * into v_eng from public.social_engagements where id=p_engagement_id
    and organization_id=p_organization_id for update;
  if not found then raise exception 'engagement_not_found' using errcode='P0002'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id
    and contact_id=v_eng.contact_id for update;
  if not found then raise exception 'lead_not_for_engagement' using errcode='23503'; end if;
  if v_eng.classification_status in ('completed','not_required') then
    return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,'already_processed',true);
  end if;
  if v_lead.status in ('lost','cancelled','won') then
    update public.social_engagements set classification_status='not_required',
      pipeline_processed_at=clock_timestamp(),pipeline_error_code=null where id=p_engagement_id;
    return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,'lead_closed',false,
      jsonb_build_array('engagement_recorded'));
  end if;
  v_saved:=public.save_social_classification(p_organization_id,p_lead_id,p_engagement_id,
    p_classification,p_classifier_source,p_prompt_version);
  v_code:=case v_saved->>'apply_result' when 'deferred' then 'classified'
    else v_saved->>'apply_result' end;
  update public.social_engagements set classification_status='completed',
    pipeline_processed_at=clock_timestamp(),pipeline_error_code=null where id=p_engagement_id;
  return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,v_code,false,
    jsonb_build_array('classification_persisted',
      case when v_code='routed' then 'route_applied' when v_code='no_profile' then 'no_profile_applied'
        else 'qualification_updated' end));
end $$;

create function public.mark_social_engagement_pipeline_failure(
  p_organization_id uuid,p_lead_id uuid,p_engagement_id uuid,p_error_code text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_eng public.social_engagements%rowtype;
begin
  if p_error_code not in ('classifier_unavailable','classifier_timeout','classifier_rate_limited',
      'classifier_provider_error','classifier_invalid_output') then
    raise exception 'invalid_pipeline_error_code' using errcode='22023'; end if;
  select * into v_eng from public.social_engagements where id=p_engagement_id
    and organization_id=p_organization_id for update;
  if not found then raise exception 'engagement_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.social_leads where id=p_lead_id and organization_id=p_organization_id
    and contact_id=v_eng.contact_id) then raise exception 'lead_not_for_engagement' using errcode='23503'; end if;
  if v_eng.classification_status in ('completed','not_required') then
    return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,'already_processed',true);
  end if;
  update public.social_engagements set classification_status='failed_retryable',
    pipeline_error_code=p_error_code where id=p_engagement_id;
  return public.social_pipeline_state(p_organization_id,p_lead_id,p_engagement_id,'retryable_error',false);
end $$;

revoke all on function public.social_pipeline_state(uuid,uuid,uuid,text,boolean,jsonb),
  public.prepare_social_engagement_pipeline(jsonb),
  public.complete_social_engagement_pipeline(uuid,uuid,uuid,jsonb,text,text),
  public.mark_social_engagement_pipeline_failure(uuid,uuid,uuid,text),
  public.skip_social_engagement_pipeline(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.social_pipeline_state(uuid,uuid,uuid,text,boolean,jsonb),
  public.prepare_social_engagement_pipeline(jsonb),
  public.complete_social_engagement_pipeline(uuid,uuid,uuid,jsonb,text,text),
  public.mark_social_engagement_pipeline_failure(uuid,uuid,uuid,text),
  public.skip_social_engagement_pipeline(uuid,uuid,uuid,text)
  to service_role;
