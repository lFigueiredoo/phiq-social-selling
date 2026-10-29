-- F22E local contract test. All fixtures are rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);
do $test$
declare
  v_org uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_account uuid:=gen_random_uuid();
  v_actor uuid:=gen_random_uuid(); v_contact uuid; v_lead uuid; v_route text; v_stage text;
  v_next text; v_idx integer; v_failed boolean; v_before integer; v_key text;
begin
  insert into public.organizations(id,name) values(v_org,'f22e-a'),(v_other,'f22e-b');
  insert into public.instagram_accounts(id,organization_id,external_id,status)
    values(v_account,v_org,'f22e-account','active');
  insert into auth.users(id) values(v_actor);
  insert into public.organization_members(organization_id,user_id,role,status)
    values(v_org,v_actor,'admin','active');

  foreach v_route in array array['franchise','q3','hotmart','nuy'] loop
    v_contact:=public.upsert_social_contact(v_org,v_account,'f22e-'||v_route,null);
    v_lead:=public.get_or_create_social_lead(v_org,v_contact);
    perform public.transition_social_lead_stage(v_org,v_lead,'central','first_contact','fixture','system','system');
    perform public.transition_social_lead_stage(v_org,v_lead,'central','qualification','fixture','system','system');
    perform public.transition_social_lead_stage(v_org,v_lead,'central','routing','fixture','system','system');
    perform public.route_social_lead(v_org,v_lead,v_route,0.91,80,'fixture','human_review','system','system');
    if not exists(select 1 from public.social_leads where id=v_lead and route_type=v_route
      and vertical_stage='lead_received' and vertical_stage_entered_at is not null
      and recommended_next_action=(select recommended_next_action from public.social_vertical_stages
        where route_type=v_route and stage='lead_received')) then
      raise exception 'route entry failed: %',v_route;
    end if;
    v_failed:=false;
    begin
      perform public.transition_vertical_lead_stage(v_org,v_lead,'lead_received',
        (select stage from public.social_vertical_stages where route_type=v_route and position=3),
        v_route||'-skip','invalid skip');
    exception when sqlstate '22023' then v_failed:=true; end;
    if not v_failed then raise exception 'skip allowed: %',v_route; end if;
    for v_idx in 2..(select max(position) from public.social_vertical_stages where route_type=v_route) loop
      select stage into v_stage from public.social_vertical_stages where route_type=v_route and position=v_idx-1;
      select stage into v_next from public.social_vertical_stages where route_type=v_route and position=v_idx;
      v_key:=v_route||'-'||v_idx;
      perform public.transition_vertical_lead_stage(v_org,v_lead,v_stage,v_next,v_key,'fixture');
      perform public.transition_vertical_lead_stage(v_org,v_lead,v_stage,v_next,v_key,'fixture');
      if (select count(*) from public.social_lead_stage_history where lead_id=v_lead and operation_key=v_key)<>1
        then raise exception 'idempotency failed: %',v_key; end if;
      v_failed:=false;
      begin
        perform public.transition_vertical_lead_stage(v_org,v_lead,v_stage,v_next,v_key||'-stale','stale worker');
      exception when sqlstate '22023' then v_failed:=true; end;
      if not v_failed then raise exception 'stale worker advanced twice: %',v_route; end if;
    end loop;
    if not exists(select 1 from public.social_leads where id=v_lead and vertical_stage=v_next
      and status='won' and won_at is not null and closed_at is not null)
      then raise exception 'terminal stage failed: %',v_route; end if;
  end loop;

  -- One lead, preserving earlier NUY history when the classifier changes route.
  v_contact:=public.upsert_social_contact(v_org,v_account,'f22e-reclass',null);
  v_lead:=public.get_or_create_social_lead(v_org,v_contact);
  perform public.transition_social_lead_stage(v_org,v_lead,'central','first_contact','fixture','system','system');
  perform public.transition_social_lead_stage(v_org,v_lead,'central','qualification','fixture','system','system');
  perform public.transition_social_lead_stage(v_org,v_lead,'central','routing','fixture','system','system');
  perform public.route_social_lead(v_org,v_lead,'nuy',0.9,80,'first route','human_review','ai','system');
  perform public.transition_vertical_lead_stage(v_org,v_lead,'lead_received','need_identification','nuy-a','fixture');
  perform public.transition_vertical_lead_stage(v_org,v_lead,'need_identification','product_recommendation','nuy-b','fixture');
  v_before:=(select count(*) from public.social_lead_stage_history where lead_id=v_lead and pipeline='nuy');
  perform public.route_social_lead(v_org,v_lead,'franchise',0.95,90,'new evidence','human_review','ai','system');
  if (select count(*) from public.social_leads where contact_id=v_contact)<>1
    or not exists(select 1 from public.social_leads where id=v_lead and route_type='franchise'
      and vertical_stage='lead_received')
    or (select count(*) from public.social_lead_stage_history where lead_id=v_lead and pipeline='nuy')<>v_before
    or not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
      and pipeline='central' and from_stage='nuy' and to_stage='franchise'
      and details->>'previous_route'='nuy') then raise exception 'reclassification failed'; end if;
  perform public.route_social_lead(v_org,v_lead,'no_profile',0.91,30,'insufficient profile','human_review','ai','system');
  if not exists(select 1 from public.social_leads where id=v_lead and route_type='no_profile'
    and vertical_stage is null and status='awaiting_signal')
    or not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
      and pipeline='franchise' and to_stage='lead_received') then raise exception 'no_profile failed'; end if;
  v_failed:=false;
  begin perform public.set_social_lead_status(v_org,v_lead,v_actor,'lost','lost-no-reason','');
  exception when sqlstate '22023' then v_failed:=true; end;
  if not v_failed then raise exception 'lost without reason accepted'; end if;
  perform public.set_social_lead_status(v_org,v_lead,v_actor,'lost','lost-reason','opportunity closed');
  if not exists(select 1 from public.social_leads where id=v_lead and status='lost' and lost_at is not null)
    then raise exception 'lost failed'; end if;
  v_failed:=false;
  begin
    update public.social_leads set status='active',route_type=null,central_stage='qualification'
      where id=v_lead;
  exception when sqlstate '22023' then v_failed:=true; end;
  if not v_failed then raise exception 'silent automatic reopen accepted'; end if;
  perform public.set_social_lead_status(v_org,v_lead,v_actor,'active','reopen','new evidence');
  -- A no_profile lead reopens to qualification through new signal, not active on no_profile.
  if not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
    and operation_key='reopen' and from_status='lost' and to_status='active') then
    raise exception 'reopen history missing'; end if;
  v_failed:=false;
  begin perform public.transition_vertical_lead_stage(v_other,v_lead,'lead_received','presentation','cross','bad');
  exception when sqlstate 'P0002' then v_failed:=true; end;
  if not v_failed then raise exception 'cross-tenant access accepted'; end if;

  v_contact:=public.upsert_social_contact(v_org,v_account,'f22e-manual',null);
  v_lead:=public.get_or_create_social_lead(v_org,v_contact);
  perform public.transition_social_lead_stage(v_org,v_lead,'central','first_contact','fixture','system','system');
  perform public.transition_social_lead_stage(v_org,v_lead,'central','qualification','fixture','system','system');
  perform public.transition_social_lead_stage(v_org,v_lead,'central','routing','fixture','system','system');
  perform public.route_social_lead(v_org,v_lead,'franchise',0.9,80,'fixture','human_review','system','system');
  v_failed:=false;
  begin perform public.manual_transition_vertical_lead_stage(v_org,v_lead,v_actor,'proposal','bad-manual','');
  exception when sqlstate '22023' then v_failed:=true; end;
  if not v_failed then raise exception 'manual without reason accepted'; end if;
  perform public.manual_transition_vertical_lead_stage(v_org,v_lead,v_actor,'proposal','manual-skip','admin review');
  v_failed:=false;
  begin perform public.manual_transition_vertical_lead_stage(v_org,v_lead,v_actor,'closing','manual-skip','admin review');
  exception when sqlstate '23505' then v_failed:=true; end;
  if not v_failed then raise exception 'operation key reused for a different transition'; end if;
  if not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
    and operation_key='manual-skip' and source='manual' and changed_by_id=v_actor
    and from_stage='lead_received' and to_stage='proposal') then raise exception 'manual audit failed'; end if;
  perform public.assign_social_lead_owner(v_org,v_lead,v_actor,v_actor,'assign','take ownership');
  if not exists(select 1 from public.social_leads where id=v_lead and owner_user_id=v_actor)
    or not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
      and operation_key='assign' and details->>'field'='owner_user_id') then raise exception 'assignment failed'; end if;
  perform public.set_social_lead_status(v_org,v_lead,v_actor,'cancelled','cancel','customer declined');
  perform public.set_social_lead_status(v_org,v_lead,v_actor,'active','resume','new customer request');
  if not exists(select 1 from public.social_lead_stage_history where lead_id=v_lead
    and operation_key='resume' and from_status='cancelled' and to_status='active')
    then raise exception 'cancel/reopen failed'; end if;
  if (select count(*) from public.outbound_actions where organization_id=v_org)<>0
    then raise exception 'vertical engine created outbound'; end if;
end $test$;
select extensions.pass('vertical pipeline integration contract');
select * from extensions.finish();
rollback;
