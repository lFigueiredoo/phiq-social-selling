-- Disposable local PostgreSQL integration test. No Meta or dispatcher calls.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $test$
declare
  v_org uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_contact uuid;
  v_lead uuid;
  v_second_contact uuid;
  v_second_lead uuid;
  v_manual_contact uuid;
  v_manual_lead uuid;
  v_result text;
  v_failed boolean;
  v_count integer;
  v_base jsonb := '{"intent":"commercial_interest","commercial_potential":"medium","lead_score":65,"route_type":"franchise","confidence":0.70,"reason":"structured local assessment","recommended_next_action":"review","signals":["requested details"]}'::jsonb;
begin
  insert into public.organizations(id, name) values (v_org, 'central-local-a'), (v_other, 'central-local-b');
  insert into public.instagram_accounts(id, organization_id, external_id, status)
    values (v_account, v_org, 'central-local-ig', 'active');
  insert into auth.users(id) values (v_actor);
  insert into public.organization_members(organization_id, user_id, role, status)
    values (v_org, v_actor, 'admin', 'active');

  v_contact := public.upsert_social_contact(v_org, v_account, 'user-1', 'user_one');
  v_lead := public.get_or_create_social_lead(v_org, v_contact);
  if not exists (select 1 from public.social_leads where id = v_lead and central_stage = 'new_lead'
    and status = 'active' and route_type is null and contact_eligibility = 'unknown') then
    raise exception 'new lead initial state invalid';
  end if;
  if (select count(*) from public.social_lead_stage_history where lead_id = v_lead) <> 1 then
    raise exception 'initial stage history missing';
  end if;
  v_failed := false;
  begin
    perform public.transition_social_lead_stage(v_org, v_lead, 'central', 'routing',
      'skip', 'system', 'system');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'new_lead to routing was accepted'; end if;
  perform public.record_social_engagement(v_org, v_contact, v_account, null,
    'central-comment-1', 'comment', 'historical_backfill', now());
  if not exists (select 1 from public.social_leads where id = v_lead and central_stage = 'new_lead'
    and contact_eligibility = 'unknown' and eligibility_reason = 'historical_backfill_does_not_authorize_outbound') then
    raise exception 'historical eligibility changed incorrectly';
  end if;
  perform public.record_social_engagement(v_org, v_contact, v_account, null,
    'central-like-2', 'like', 'browser_collector', now());
  if not exists (select 1 from public.social_leads where id = v_lead
    and central_stage = 'new_lead' and contact_eligibility = 'unknown') then
    raise exception 'like advanced central stage or authorized contact';
  end if;
  perform public.record_social_engagement(v_org, v_contact, v_account, null,
    'central-comment-3', 'comment', 'browser_collector', now());
  if not exists (select 1 from public.social_leads where id = v_lead and central_stage = 'first_contact'
    and contact_eligibility = 'unknown' and first_contact_at is not null) then
    raise exception 'first_contact did not advance or browser collector authorized contact';
  end if;

  v_result := public.apply_social_assessment(v_org, v_lead, v_base, 'import');
  if v_result <> 'needs_more_signal' or not exists (select 1 from public.social_leads
    where id = v_lead and central_stage = 'qualification' and route_type is null
      and needs_more_signal and intent = 'commercial_interest' and lead_score = 65
      and commercial_potential = 'medium' and qualified_at is not null) then
    raise exception 'medium confidence policy failed';
  end if;
  v_failed := false;
  begin
    perform public.apply_social_assessment(v_org, v_lead,
      jsonb_set(v_base, '{lead_score}', '101'::jsonb), 'ai');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'score out of range accepted'; end if;
  v_failed := false;
  begin
    perform public.apply_social_assessment(v_org, v_lead,
      jsonb_set(v_base, '{confidence}', '1.1'::jsonb), 'ai');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'confidence out of range accepted'; end if;
  v_failed := false;
  begin
    perform public.apply_social_assessment(v_org, v_lead,
      jsonb_set(v_base, '{route_type}', '"invalid"'::jsonb), 'ai');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'invalid route accepted'; end if;

  v_result := public.apply_social_assessment(v_org, v_lead,
    jsonb_set(v_base, '{confidence}', '0.85'::jsonb), 'ai');
  if v_result <> 'routed' or not exists (select 1 from public.social_leads
    where id = v_lead and central_stage = 'routing' and route_type = 'franchise'
      and vertical_stage = 'lead_received' and routed_at is not null) then
    raise exception 'high confidence route failed';
  end if;
  if (select count(*) from public.social_lead_stage_history where lead_id = v_lead and pipeline = 'central') <> 5 then
    raise exception 'central stage history incomplete';
  end if;

  insert into public.social_funnel_policies(organization_id, auto_route_threshold, more_signal_threshold)
    values (v_org, 0.95, 0.65);

  v_second_contact := public.upsert_social_contact(v_org, v_account, 'user-2', 'user_two');
  v_second_lead := public.get_or_create_social_lead(v_org, v_second_contact);
  perform public.record_social_engagement(v_org, v_second_contact, v_account, null,
    'second-comment-1', 'comment', 'realtime', now());
  perform public.record_social_engagement(v_org, v_second_contact, v_account, null,
    'second-comment-2', 'comment', 'realtime', now());
  v_result := public.apply_social_assessment(v_org, v_second_lead,
    jsonb_set(v_base, '{confidence}', '0.90'::jsonb), 'ai');
  if v_result <> 'needs_more_signal' or not exists (select 1 from public.social_leads
    where id = v_second_lead and central_stage = 'qualification' and route_type is null) then
    raise exception 'configurable threshold ignored';
  end if;
  v_result := public.apply_social_assessment(v_org, v_second_lead,
    jsonb_set(v_base, '{confidence}', '0.59'::jsonb), 'ai');
  if v_result <> 'no_profile' or not exists (select 1 from public.social_leads
    where id = v_second_lead and route_type = 'no_profile' and status = 'awaiting_signal') then
    raise exception 'low confidence no_profile failed';
  end if;
  perform public.process_social_engagement((select id from public.social_engagements
    where external_engagement_id = 'second-comment-2'));
  if not exists (select 1 from public.social_leads where id = v_second_lead
    and route_type = 'no_profile' and status = 'awaiting_signal') then
    raise exception 'old engagement replay caused requalification';
  end if;
  perform public.record_social_engagement(v_org, v_second_contact, v_account, null,
    'second-comment-3', 'comment', 'realtime', now());
  if not exists (select 1 from public.social_leads where id = v_second_lead
    and central_stage = 'qualification' and route_type is null and status = 'active'
    and needs_more_signal) then raise exception 'no_profile requalification failed'; end if;

  v_manual_contact := public.upsert_social_contact(v_org, v_account, 'user-3', 'user_three');
  v_manual_lead := public.get_or_create_social_lead(v_org, v_manual_contact);
  v_failed := false;
  begin
    perform public.manual_override_social_lead(v_org, v_manual_lead, v_actor, '',
      '{"central_stage":"routing","route_type":"q3"}'::jsonb);
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'actor-less reason accepted'; end if;
  v_failed := false;
  begin
    perform public.manual_override_social_lead(v_other, v_manual_lead, v_actor, 'cross-tenant',
      '{"central_stage":"routing","route_type":"q3"}'::jsonb);
  exception when sqlstate '42501' then v_failed := true;
  end;
  if not v_failed then raise exception 'cross-tenant override accepted'; end if;
  perform public.manual_override_social_lead(v_org, v_manual_lead, v_actor, 'verified human assessment',
    '{"central_stage":"routing","route_type":"q3","lead_score":70,"intent":"q3_interest","commercial_potential":"high","signals":["human review"]}'::jsonb);
  if not exists (select 1 from public.social_leads where id = v_manual_lead and central_stage = 'routing'
    and route_type = 'q3' and vertical_stage = 'lead_received' and lead_score = 70) then
    raise exception 'manual override did not persist';
  end if;
  if not exists (select 1 from public.social_lead_stage_history where lead_id = v_manual_lead
    and source = 'human' and changed_by_type = 'human' and changed_by_id = v_actor
    and reason = 'verified human assessment' and changed_at is not null) then
    raise exception 'manual history lacks actor/reason/time';
  end if;
  perform public.set_social_contact_eligibility(v_org, v_manual_lead, v_actor,
    'eligible', 'human reviewed contact policy');
  if not exists (select 1 from public.social_leads where id = v_manual_lead
    and contact_eligibility = 'eligible' and route_type = 'q3') then
    raise exception 'contact eligibility changed route';
  end if;
  if not exists (select 1 from public.social_lead_stage_history where lead_id = v_manual_lead
    and changed_by_id = v_actor and details->>'field' = 'contact_eligibility') then
    raise exception 'eligibility audit missing';
  end if;
  v_failed := false;
  begin
    perform public.transition_social_lead_stage(v_org, v_manual_lead, 'central', 'qualification',
      'unverified override', 'human', 'human', true);
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'legacy actor-less override accepted'; end if;
  v_failed := false;
  begin
    perform public.route_social_lead(v_org, v_manual_lead, 'franchise', 0.9, 75,
      'unverified human route', 'review', 'human', 'human');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'legacy actor-less route accepted'; end if;
  if (select count(*) from public.outbound_actions where organization_id = v_org) <> 0 then
    raise exception 'central engine created outbound';
  end if;
end $test$;

set local role authenticated;
do $browser$
declare v_denied boolean := false;
begin
  begin
    perform public.apply_social_assessment(null, null, '{}'::jsonb, 'ai');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated role executed backend assessment'; end if;
end $browser$;
reset role;

set local role service_role;
do $service$
declare v_org uuid; v_lead uuid; v_actor uuid; v_engagement uuid;
begin
  select id into v_org from public.organizations where name = 'central-local-a';
  select l.id into v_lead from public.social_leads l
    join public.social_contacts c on c.id = l.contact_id
    where l.organization_id = v_org and c.external_user_id = 'user-2';
  select user_id into v_actor from public.organization_members where organization_id = v_org;
  select id into v_engagement from public.social_engagements
    where external_engagement_id = 'second-comment-3';
  if public.process_social_engagement(v_engagement) is distinct from v_lead then
    raise exception 'service role engagement processing failed';
  end if;
  if public.apply_social_assessment(v_org, v_lead,
    '{"intent":"commercial_interest","commercial_potential":"medium","lead_score":60,"route_type":"q3","confidence":0.80,"reason":"service assessment","recommended_next_action":"review","signals":[]}'::jsonb,
    'ai') <> 'needs_more_signal' then
    raise exception 'service role assessment failed';
  end if;
  perform public.set_social_contact_eligibility(v_org, v_lead, v_actor,
    'ineligible', 'service role human review');
  if not exists (select 1 from public.social_leads where id = v_lead
    and contact_eligibility = 'ineligible') then
    raise exception 'service role eligibility update failed';
  end if;
end $service$;
reset role;
select extensions.pass('central funnel integration contract');
select * from extensions.finish();
rollback;
