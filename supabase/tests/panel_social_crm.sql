-- F22G read model and admin mutations; rollback fixtures.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);
do $test$
declare
  v_org uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_account uuid:=gen_random_uuid();
  v_admin uuid:=gen_random_uuid(); v_reviewer uuid:=gen_random_uuid();
  v_route text; v_contact uuid; v_lead uuid; v_first uuid; v_data jsonb; v_page jsonb;
  v_failed boolean;
begin
  insert into public.organizations(id,name) values(v_org,'f22g-a'),(v_other,'f22g-b');
  insert into public.instagram_accounts(id,organization_id,external_id,status)
    values(v_account,v_org,'f22g-account','active');
  insert into auth.users(id,email) values(v_admin,'f22g-admin@example.test'),(v_reviewer,'f22g-reviewer@example.test');
  insert into public.organization_members(organization_id,user_id,role,status)
    values(v_org,v_admin,'admin','active'),(v_org,v_reviewer,'reviewer','active');
  foreach v_route in array array['franchise','q3','hotmart','nuy','no_profile'] loop
    v_contact:=public.upsert_social_contact(v_org,v_account,'f22g-'||v_route,v_route||'_person');
    v_lead:=public.get_or_create_social_lead(v_org,v_contact);
    if v_first is null then v_first:=v_lead; end if;
    perform public.record_social_engagement(v_org,v_contact,v_account,null,'f22g-'||v_route,
      'comment',case when v_route='nuy' then 'historical_backfill' else 'realtime' end,now(),null,
      jsonb_build_object('text','Quero saber mais sobre '||v_route));
    perform public.transition_social_lead_stage(v_org,v_lead,'central','first_contact','fixture','system','system');
    perform public.transition_social_lead_stage(v_org,v_lead,'central','qualification','fixture','system','system');
    perform public.transition_social_lead_stage(v_org,v_lead,'central','routing','fixture','system','system');
    perform public.route_social_lead(v_org,v_lead,v_route,0.91,75,'fixture','human_review','system','system');
    if v_route='q3' then
      perform public.assign_social_lead_owner(v_org,v_lead,v_admin,v_reviewer,'f22g-assign','fixture');
    elsif v_route='hotmart' then
      perform public.set_social_lead_status(v_org,v_lead,v_admin,'lost','f22g-lost','fixture');
    elsif v_route='nuy' then
      perform public.manual_transition_vertical_lead_stage(v_org,v_lead,v_admin,'post_sale','f22g-won','fixture');
    end if;
  end loop;
  v_data:=public.panel_social_dashboard(v_reviewer,v_org);
  if (v_data->'kpis'->>'franchise')::integer<>1 or (v_data->'kpis'->>'q3')::integer<>1
    or (v_data->'kpis'->>'hotmart')::integer<>1 or (v_data->'kpis'->>'nuy')::integer<>1
    or (v_data->'kpis'->>'no_profile')::integer<>1 or (v_data->'kpis'->>'won')::integer<>1
    or (v_data->'kpis'->>'lost')::integer<>1 or (v_data->'kpis'->>'awaiting_signal')::integer<>1
    then raise exception 'dashboard KPI mismatch: %',v_data->'kpis'; end if;
  v_page:=public.panel_social_leads(v_reviewer,v_org,'{}',2,0,'recent');
  if (v_page->>'total')::integer<>5 or jsonb_array_length(v_page->'leads')<>2
    then raise exception 'pagination failed'; end if;
  v_page:=public.panel_social_leads(v_reviewer,v_org,'{"route":"nuy","status":"won"}',25,0,'recent');
  if (v_page->>'total')::integer<>1 or v_page->'leads'->0->>'vertical_stage'<>'post_sale'
    or v_page->'leads'->0->>'last_source'<>'historical_backfill'
    then raise exception 'route/status/source filtering failed'; end if;
  v_page:=public.panel_social_leads(v_reviewer,v_org,'{"search":"franchise_person"}',25,0,'recent');
  if (v_page->>'total')::integer<>1 then raise exception 'username search failed'; end if;
  v_page:=public.panel_social_leads(v_reviewer,v_org,'{"unassigned":true}',25,0,'recent');
  if (v_page->>'total')::integer<>4 then raise exception 'owner filtering failed'; end if;
  v_page:=public.panel_social_leads(v_reviewer,v_org,'{"eligibility":"unknown"}',25,0,'recent');
  if (v_page->>'total')::integer<>5 then raise exception 'eligibility filter failed'; end if;
  v_data:=public.panel_social_lead_detail(v_reviewer,v_org,v_first);
  if v_data->>'username'<>'franchise_person' or v_data->>'route_type'<>'franchise'
    then raise exception 'detail mismatch'; end if;
  v_data:=public.panel_social_lead_timeline(v_reviewer,v_org,v_first,50,0);
  if (v_data->>'total')::integer<4 or not exists(select 1 from jsonb_array_elements(v_data->'events') x(value)
    where x.value->>'kind'='interaction' and x.value->'info'->>'text' like '%franchise%')
    then raise exception 'timeline incomplete'; end if;
  if jsonb_array_length(public.panel_social_members(v_reviewer,v_org))<>2
    then raise exception 'member list failed'; end if;
  v_failed:=false;
  begin perform public.panel_social_dashboard(v_admin,v_other);
  exception when insufficient_privilege then v_failed:=true; end;
  if not v_failed then raise exception 'cross tenant read accepted'; end if;
  v_failed:=false;
  begin perform public.panel_social_transition_vertical(v_reviewer,v_org,v_first,'lead_received',
    'presentation','f22g-reviewer','fixture',false);
  exception when insufficient_privilege then v_failed:=true; end;
  if not v_failed then raise exception 'reviewer mutation accepted'; end if;
  v_failed:=false;
  begin perform public.panel_social_transition_vertical(v_admin,v_org,v_first,'lead_received',
    'proposal','f22g-skip','fixture',false);
  exception when sqlstate '22023' then v_failed:=true; end;
  if not v_failed then raise exception 'invalid ordinary transition accepted'; end if;
  perform public.panel_social_transition_vertical(v_admin,v_org,v_first,'lead_received',
    'presentation','f22g-next','fixture',false);
  if not exists(select 1 from public.social_lead_stage_history where lead_id=v_first
    and operation_key='f22g-next' and changed_by_id=v_admin and source='manual')
    then raise exception 'transition audit missing'; end if;
  perform public.panel_social_transition_vertical(v_admin,v_org,v_first,'presentation',
    'closing','f22g-override','fixture',true);
  if not exists(select 1 from public.social_leads where id=v_first and vertical_stage='closing')
    then raise exception 'override failed'; end if;
  perform public.panel_social_reclassify_route(v_admin,v_org,v_first,'q3','f22g-reclass','new business signal');
  if not exists(select 1 from public.social_leads where id=v_first and route_type='q3'
    and vertical_stage='lead_received' and route_confidence is null)
    or not exists(select 1 from public.social_lead_stage_history where lead_id=v_first
      and operation_key='f22g-reclass' and details->>'previous_route'='franchise'
      and details->>'new_route'='q3' and changed_by_id=v_admin)
    then raise exception 'manual reclassification incomplete'; end if;
  if (select count(*) from public.outbound_actions where organization_id=v_org)<>0
    then raise exception 'panel read/mutation created outbound'; end if;
end $test$;
set local role service_role;
do $service_role_view$
begin
  -- Regression: a security-invoker view must not require direct auth.users
  -- privileges from service_role in hosted Supabase.
  perform count(*) from public.panel_social_lead_rows;
end $service_role_view$;
reset role;
set local role authenticated;
do $denied$
declare v_denied boolean:=false;
begin
  begin perform public.panel_social_dashboard(null,null);
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'browser executed CRM RPC'; end if;
end $denied$;
reset role;
select extensions.pass('panel social CRM integration contract');
select * from extensions.finish();
rollback;
