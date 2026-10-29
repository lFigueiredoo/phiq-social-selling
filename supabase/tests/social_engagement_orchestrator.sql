-- F22F domain integration, classification fixtures from the F22D contract.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);
do $test$
declare
  v_org uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_account uuid:=gen_random_uuid();
  v_actor uuid:=gen_random_uuid(); v_route text; v_input jsonb; v_first jsonb; v_second jsonb;
  v_done jsonb; v_replay jsonb; v_fixture jsonb; v_contact uuid; v_lead uuid;
  v_before integer; v_failed boolean; v_generic jsonb; v_like jsonb; v_closed jsonb;
begin
  insert into public.organizations(id,name) values(v_org,'f22f-a'),(v_other,'f22f-b');
  insert into public.instagram_accounts(id,organization_id,external_id,status)
    values(v_account,v_org,'f22f-account','active');
  insert into auth.users(id) values(v_actor);
  insert into public.organization_members(organization_id,user_id,role,status)
    values(v_org,v_actor,'admin','active');
  foreach v_route in array array['franchise','q3','hotmart','nuy'] loop
    v_fixture:=jsonb_build_object('intent',case v_route when 'franchise' then 'franchise_interest'
      when 'q3' then 'q3_interest' when 'hotmart' then 'course_interest' else 'product_interest' end,
      'commercial_potential','high','lead_score',80,'route_type',v_route,'confidence',0.92,
      'reason','explicit current request','recommended_next_action','human_review',
      'signals',jsonb_build_array('explicit_current_request'),'needs_more_signal',false);
    v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
      'external_user_id','f22f-'||v_route,'engagement_type','comment','source','realtime',
      'external_engagement_id',v_route||'-1','text',case v_route
        when 'franchise' then 'Quero abrir uma franquia, como funciona?'
        when 'q3' then 'Vocês fazem diagnóstico de qualidade na indústria?'
        when 'hotmart' then 'Qual o valor do curso e como faço a inscrição?'
        else 'Onde compro esse aromatizador Nuy?' end);
    v_first:=public.prepare_social_engagement_pipeline(v_input);
    if v_first->>'created_contact'<>'true' or v_first->>'created_engagement'<>'true'
      or v_first->>'created_lead'<>'true' or v_first->>'central_stage'<>'new_lead'
      then raise exception 'phase A first signal failed: %',v_route; end if;
    v_done:=public.complete_social_engagement_pipeline(v_org,(v_first->>'lead_id')::uuid,
      (v_first->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
    if v_done->>'result_code'<>'classified' or v_done->>'route_type' is not null
      then raise exception 'first signal skipped central funnel: %',v_route; end if;
    v_replay:=public.prepare_social_engagement_pipeline(v_input);
    if v_replay->>'result_code'<>'already_processed' or v_replay->>'engagement_id'<>v_first->>'engagement_id'
      then raise exception 'phase A replay failed: %',v_route; end if;
    v_input:=jsonb_set(v_input,'{external_engagement_id}',to_jsonb(v_route||'-2'));
    v_second:=public.prepare_social_engagement_pipeline(v_input);
    if v_second->>'lead_id'<>v_first->>'lead_id' or v_second->>'central_stage'<>'first_contact'
      then raise exception 'second signal did not reach first_contact: %',v_route; end if;
    v_done:=public.complete_social_engagement_pipeline(v_org,(v_second->>'lead_id')::uuid,
      (v_second->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
    if v_done->>'result_code'<>'routed' or v_done->>'route_type'<>v_route
      or v_done->>'vertical_stage'<>'lead_received'
      or v_done->>'recommended_next_action' is null
      then raise exception 'route failed: % %',v_route,v_done; end if;
    v_before:=(select count(*) from public.social_lead_stage_history where lead_id=(v_done->>'lead_id')::uuid);
    for i in 1..5 loop
      v_replay:=public.complete_social_engagement_pipeline(v_org,(v_second->>'lead_id')::uuid,
        (v_second->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
      if v_replay->>'result_code'<>'already_processed' then raise exception 'replay not stable'; end if;
    end loop;
    if (select count(*) from public.social_lead_stage_history where lead_id=(v_done->>'lead_id')::uuid)<>v_before
      or (select count(*) from public.social_classifications where engagement_id=(v_second->>'engagement_id')::uuid)<>1
      then raise exception 'replay duplicated effects: %',v_route; end if;
  end loop;

  -- Generic engagement reaches no_profile only after the central prerequisites.
  v_fixture:='{"intent":"engagement","commercial_potential":"low","lead_score":5,"route_type":"no_profile","confidence":0.3,"reason":"generic engagement","recommended_next_action":"await_new_signal","signals":["generic_engagement"],"needs_more_signal":true}'::jsonb;
  v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
    'external_user_id','f22f-generic','engagement_type','comment','source','realtime',
    'external_engagement_id','generic-1','text','Parabéns 👏');
  v_first:=public.prepare_social_engagement_pipeline(v_input);
  perform public.complete_social_engagement_pipeline(v_org,(v_first->>'lead_id')::uuid,
    (v_first->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  v_input:=jsonb_set(v_input,'{external_engagement_id}','"generic-2"'::jsonb);
  v_generic:=public.prepare_social_engagement_pipeline(v_input);
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_generic->>'lead_id')::uuid,
    (v_generic->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'result_code'<>'no_profile' or v_done->>'lead_status'<>'awaiting_signal'
    or v_done->>'vertical_stage' is not null then raise exception 'generic no_profile failed'; end if;
  -- A new explicit signal uses the same contact and lead and returns to qualification.
  v_input:=jsonb_set(jsonb_set(v_input,'{external_engagement_id}','"generic-3"'::jsonb),
    '{text}','"Quero abrir uma franquia"'::jsonb);
  v_second:=public.prepare_social_engagement_pipeline(v_input);
  if v_second->>'lead_id'<>v_generic->>'lead_id' or v_second->>'central_stage'<>'qualification'
    then raise exception 'no_profile requalification failed'; end if;
  v_fixture:=jsonb_build_object('intent','franchise_interest','commercial_potential','high',
    'lead_score',80,'route_type','franchise','confidence',0.92,'reason','new explicit request',
    'recommended_next_action','human_review','signals',jsonb_build_array('explicit_current_request'),
    'needs_more_signal',false);
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_second->>'lead_id')::uuid,
    (v_second->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'route_type'<>'franchise' or v_done->>'vertical_stage'<>'lead_received'
    then raise exception 'no_profile to franchise failed'; end if;

  -- Ambiguous current interest needs more signal; provider retry never loses base data.
  v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
    'external_user_id','f22f-ambiguous','engagement_type','comment','source','realtime',
    'external_engagement_id','ambiguous-1','text','Quero saber mais');
  v_first:=public.prepare_social_engagement_pipeline(v_input);
  v_replay:=public.mark_social_engagement_pipeline_failure(v_org,(v_first->>'lead_id')::uuid,
    (v_first->>'engagement_id')::uuid,'classifier_timeout');
  if v_replay->>'result_code'<>'retryable_error' or v_replay->>'route_type' is not null
    then raise exception 'provider failure lost or routed lead'; end if;
  v_fixture:='{"intent":"commercial_interest","commercial_potential":"low","lead_score":5,"route_type":"no_profile","confidence":0.7,"reason":"ambiguous interest","recommended_next_action":"request_more_context","signals":["ambiguous_interest"],"needs_more_signal":true}'::jsonb;
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_first->>'lead_id')::uuid,
    (v_first->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'result_code'<>'classified' or v_done->>'classification_status'<>'completed'
    then raise exception 'provider retry failed'; end if;
  v_input:=jsonb_set(v_input,'{external_engagement_id}','"ambiguous-2"'::jsonb);
  v_second:=public.prepare_social_engagement_pipeline(v_input);
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_second->>'lead_id')::uuid,
    (v_second->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'result_code'<>'needs_more_signal' or v_done->>'route_type' is not null
    then raise exception 'ambiguous route invented'; end if;
  v_lead:=(v_second->>'lead_id')::uuid;

  -- Historical and collector inputs preserve unknown eligibility.
  v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
    'external_user_id','f22f-historical','engagement_type','historical_comment',
    'source','historical_backfill','external_engagement_id','historical-1',
    'text','Quero abrir uma franquia');
  v_first:=public.prepare_social_engagement_pipeline(v_input);
  if v_first->>'contact_eligibility'<>'unknown' then raise exception 'historical eligibility changed'; end if;
  v_fixture:=jsonb_build_object('intent','franchise_interest','commercial_potential','high',
    'lead_score',80,'route_type','franchise','confidence',0.92,'reason','explicit historical request',
    'recommended_next_action','human_review','signals',jsonb_build_array('explicit_current_request'),
    'needs_more_signal',false);
  perform public.complete_social_engagement_pipeline(v_org,(v_first->>'lead_id')::uuid,
    (v_first->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  v_input:=jsonb_set(v_input,'{external_engagement_id}','"historical-2"'::jsonb);
  v_second:=public.prepare_social_engagement_pipeline(v_input);
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_second->>'lead_id')::uuid,
    (v_second->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'route_type'<>'franchise' or v_done->>'contact_eligibility'<>'unknown'
    then raise exception 'historical commercial route or eligibility failed'; end if;
  v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
    'external_user_id','f22f-like','engagement_type','like','source','browser_collector',
    'external_engagement_id','like-1');
  v_like:=public.prepare_social_engagement_pipeline(v_input);
  v_done:=public.skip_social_engagement_pipeline(v_org,(v_like->>'lead_id')::uuid,
    (v_like->>'engagement_id')::uuid,'needs_more_signal');
  if v_done->>'route_type' is not null or v_done->>'central_stage'<>'new_lead'
    or v_done->>'contact_eligibility'<>'unknown' then raise exception 'browser like advanced'; end if;

  -- A closed lead receives the engagement, keeps its identity and is not reopened.
  perform public.set_social_lead_status(v_org,v_lead,v_actor,'lost','f22f-lost','closed manually');
  v_input:=jsonb_set(v_input,'{external_user_id}','"f22f-ambiguous"'::jsonb);
  v_input:=jsonb_set(v_input,'{engagement_type}','"comment"'::jsonb);
  v_input:=jsonb_set(v_input,'{source}','"realtime"'::jsonb);
  v_input:=jsonb_set(v_input,'{external_engagement_id}','"closed-1"'::jsonb);
  v_closed:=public.prepare_social_engagement_pipeline(v_input);
  if v_closed->>'lead_id'<>v_lead::text or v_closed->>'result_code'<>'lead_closed'
    or (select count(*) from public.social_leads where contact_id=(v_closed->>'contact_id')::uuid)<>1
    then raise exception 'closed lead duplicated/reopened'; end if;
  v_done:=public.skip_social_engagement_pipeline(v_org,v_lead,(v_closed->>'engagement_id')::uuid,'lead_closed');
  if v_done->>'lead_status'<>'lost' then raise exception 'closed lead changed'; end if;

  -- NUY -> franchise on a later explicit signal preserves the prior route history.
  v_input:=jsonb_build_object('organization_id',v_org,'instagram_account_id',v_account,
    'external_user_id','f22f-nuy','engagement_type','comment','source','realtime',
    'external_engagement_id','nuy-reclass-3','text','Quero abrir uma franquia');
  v_first:=public.prepare_social_engagement_pipeline(v_input);
  v_before:=(select count(*) from public.social_lead_stage_history
    where lead_id=(v_first->>'lead_id')::uuid and pipeline='nuy');
  v_fixture:=jsonb_build_object('intent','franchise_interest','commercial_potential','high',
    'lead_score',85,'route_type','franchise','confidence',0.94,'reason','new explicit franchise request',
    'recommended_next_action','human_review','signals',jsonb_build_array('explicit_current_request'),
    'needs_more_signal',false);
  v_done:=public.complete_social_engagement_pipeline(v_org,(v_first->>'lead_id')::uuid,
    (v_first->>'engagement_id')::uuid,v_fixture,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_done->>'route_type'<>'franchise' or v_done->>'vertical_stage'<>'lead_received'
    or (select count(*) from public.social_lead_stage_history
      where lead_id=(v_first->>'lead_id')::uuid and pipeline='nuy')<>v_before
    or (select count(*) from public.social_leads where contact_id=(v_first->>'contact_id')::uuid)<>1
    then raise exception 'NUY reclassification failed'; end if;

  -- Won leads remain the same opportunity when a new signal arrives.
  v_lead:=(v_first->>'lead_id')::uuid;
  perform public.manual_transition_vertical_lead_stage(v_org,v_lead,v_actor,
    'implementation','f22f-won','implementation complete');
  v_input:=jsonb_set(v_input,'{external_engagement_id}','"won-1"'::jsonb);
  v_closed:=public.prepare_social_engagement_pipeline(v_input);
  if v_closed->>'lead_id'<>v_lead::text or v_closed->>'lead_status'<>'won'
    or (select count(*) from public.social_leads where contact_id=(v_closed->>'contact_id')::uuid)<>1
    then raise exception 'won lead duplicated'; end if;
  v_done:=public.skip_social_engagement_pipeline(v_org,v_lead,(v_closed->>'engagement_id')::uuid,'lead_closed');
  if v_done->>'lead_status'<>'won' then raise exception 'won lead reopened'; end if;

  v_failed:=false;
  begin perform public.prepare_social_engagement_pipeline(jsonb_set(v_input,'{organization_id}',to_jsonb(v_other)));
  exception when sqlstate 'P0002' then v_failed:=true; end;
  if not v_failed or exists(select 1 from public.social_contacts where organization_id=v_other)
    then raise exception 'cross tenant call partially applied'; end if;
  if (select count(*) from public.outbound_actions where organization_id=v_org)<>0
    then raise exception 'orchestrator created outbound'; end if;
end $test$;
set local role authenticated;
do $denied$
declare v_denied boolean:=false;
begin
  begin
    perform public.prepare_social_engagement_pipeline('{}'::jsonb);
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'browser executed orchestrator RPC'; end if;
end $denied$;
reset role;
select extensions.pass('social engagement orchestrator integration contract');
select * from extensions.finish();
rollback;
