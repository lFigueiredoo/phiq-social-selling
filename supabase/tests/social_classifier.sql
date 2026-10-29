-- Local-only classifier handoff test; all fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $test$
declare
  v_org uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_contact uuid;
  v_lead uuid;
  v_eng1 uuid;
  v_eng2 uuid;
  v_eng3 uuid;
  v_history_contact uuid;
  v_history_lead uuid;
  v_history_eng uuid;
  v_like_contact uuid;
  v_like_lead uuid;
  v_like_eng uuid;
  v_result jsonb;
  v_failed boolean;
  v_base jsonb := '{"intent":"franchise_interest","commercial_potential":"high","lead_score":80,"route_type":"franchise","confidence":0.92,"reason":"explicit unit investment interest","recommended_next_action":"human_review","signals":["explicit_current_request"],"needs_more_signal":false}'::jsonb;
begin
  insert into public.organizations(id,name) values (v_org,'classifier-local-a'),(v_other,'classifier-local-b');
  insert into public.instagram_accounts(id,organization_id,external_id,status)
    values (v_account,v_org,'classifier-ig-a','active');
  v_contact := public.upsert_social_contact(v_org,v_account,'classifier-user-1','classifier_one');
  v_lead := public.get_or_create_social_lead(v_org,v_contact);
  v_eng1 := public.record_social_engagement(v_org,v_contact,v_account,null,'classifier-comment-1','comment','realtime',now());
  v_result := public.save_social_classification(v_org,v_lead,v_eng1,v_base,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'apply_result' <> 'deferred' or not exists
    (select 1 from public.social_leads where id=v_lead and central_stage='new_lead' and route_type is null) then
    raise exception 'first engagement should defer routing';
  end if;
  v_eng2 := public.record_social_engagement(v_org,v_contact,v_account,null,'classifier-comment-2','comment','realtime',now());
  v_result := public.save_social_classification(v_org,v_lead,v_eng2,v_base,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'apply_result' <> 'routed' or not exists
    (select 1 from public.social_leads where id=v_lead and central_stage='routing'
      and route_type='franchise' and lead_score=80 and classifier_source='deterministic'
      and prompt_version='SOCIAL_SELLING_CLASSIFIER_V1' and classified_at is not null) then
    raise exception 'classifier did not route franchise';
  end if;
  v_result := public.save_social_classification(v_org,v_lead,v_eng2,v_base,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'already_exists' <> 'true' or
    (select count(*) from public.social_classifications where engagement_id=v_eng2) <> 1 then
    raise exception 'classification replay was not idempotent';
  end if;
  v_eng3 := public.record_social_engagement(v_org,v_contact,v_account,null,'classifier-comment-3','comment','realtime',now()+interval '1 second');
  v_result := public.save_social_classification(v_org,v_lead,v_eng3,
    jsonb_set(jsonb_set(jsonb_set(v_base,'{route_type}','"q3"'::jsonb),
      '{intent}','"q3_interest"'::jsonb),'{reason}','"new explicit B2B diagnosis"'::jsonb),
    'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'apply_result' <> 'routed' or not exists
    (select 1 from public.social_leads where id=v_lead and route_type='q3' and classifier_source='ai') then
    raise exception 'new route did not replace old route';
  end if;
  if not exists (select 1 from public.social_lead_stage_history where lead_id=v_lead
    and from_stage='routing' and to_stage='qualification'
    and details->>'previous_route'='franchise' and changed_at is not null) then
    raise exception 'reclassification history incomplete';
  end if;

  v_history_contact := public.upsert_social_contact(v_org,v_account,'history-user','history_user');
  v_history_lead := public.get_or_create_social_lead(v_org,v_history_contact);
  perform public.record_social_engagement(v_org,v_history_contact,v_account,null,'history-1','comment','historical_backfill',now());
  v_history_eng := public.record_social_engagement(v_org,v_history_contact,v_account,null,'history-2','comment','historical_backfill',now());
  v_result := public.save_social_classification(v_org,v_history_lead,v_history_eng,v_base,'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'apply_result' <> 'routed' or not exists
    (select 1 from public.social_leads where id=v_history_lead and route_type='franchise'
      and contact_eligibility='unknown') then
    raise exception 'historical classifier changed eligibility or failed routing';
  end if;

  v_like_contact := public.upsert_social_contact(v_org,v_account,'like-user','like_user');
  v_like_lead := public.get_or_create_social_lead(v_org,v_like_contact);
  v_like_eng := public.record_social_engagement(v_org,v_like_contact,v_account,null,'like-1','like','browser_collector',now());
  v_result := public.save_social_classification(v_org,v_like_lead,v_like_eng,
    '{"intent":"engagement","commercial_potential":"unknown","lead_score":0,"route_type":"no_profile","confidence":0.3,"reason":"isolated like","recommended_next_action":"await_new_signal","signals":["like"],"needs_more_signal":true}'::jsonb,
    'deterministic','SOCIAL_SELLING_CLASSIFIER_V1');
  if v_result->>'apply_result' <> 'deferred' or not exists
    (select 1 from public.social_leads where id=v_like_lead and contact_eligibility='unknown'
      and route_type is null) then raise exception 'browser like inferred eligibility or route'; end if;

  v_failed := false;
  begin
    perform public.save_social_classification(v_other,v_lead,v_eng3,v_base,'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  exception when sqlstate 'P0002' then v_failed := true;
  end;
  if not v_failed then raise exception 'cross-tenant classifier access accepted'; end if;
  v_failed := false;
  begin
    perform public.save_social_classification(v_org,v_lead,v_eng3,
      jsonb_set(v_base,'{route_type}','"invalid"'::jsonb),'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'invalid route accepted'; end if;
  v_failed := false;
  begin
    perform public.save_social_classification(v_org,v_lead,v_eng3,
      jsonb_set(v_base,'{lead_score}','101'::jsonb),'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'score >100 accepted'; end if;
  v_failed := false;
  begin
    perform public.save_social_classification(v_org,v_lead,v_eng3,
      jsonb_set(v_base,'{confidence}','1.1'::jsonb),'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'confidence >1 accepted'; end if;
  v_failed := false;
  begin
    perform public.save_social_classification(v_org,v_lead,v_eng3,
      jsonb_set(v_base,'{recommended_next_action}','"send_dm"'::jsonb),'ai','SOCIAL_SELLING_CLASSIFIER_V1');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'outbound recommendation accepted'; end if;
  if (select count(*) from public.outbound_actions where organization_id=v_org) <> 0 then
    raise exception 'classifier created outbound';
  end if;
end $test$;

set local role authenticated;
do $browser$
declare v_denied boolean := false;
begin
  begin
    perform public.save_social_classification(null,null,null,'{}'::jsonb,'ai','test');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'browser executed classifier persistence'; end if;
end $browser$;
reset role;
select extensions.pass('social classifier integration contract');
select * from extensions.finish();
rollback;
