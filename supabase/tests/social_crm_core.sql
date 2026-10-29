-- Run only against a disposable LOCAL database after applying local migrations.
-- All fixtures roll back. No outbound function is called.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $test$
declare
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_other_account uuid := gen_random_uuid();
  v_event uuid := gen_random_uuid();
  v_historical_event uuid := gen_random_uuid();
  v_second_event uuid := gen_random_uuid();
  v_contact uuid;
  v_contact_again uuid;
  v_other_contact uuid;
  v_engagement uuid;
  v_lead uuid;
  v_lead_again uuid;
  v_count integer;
  v_route text;
  v_failed boolean;
begin
  insert into public.organizations(id, name) values (v_org, 'local-crm-a'), (v_other_org, 'local-crm-b');
  insert into public.instagram_accounts(id, organization_id, external_id, status)
    values (v_account, v_org, 'local-ig-a', 'active'), (v_other_account, v_other_org, 'local-ig-b', 'active');
  insert into public.webhook_events(id, organization_id, instagram_account_id, object_type, event_type,
    external_object_id, idempotency_key, payload)
    values (v_event, v_org, v_account, 'instagram', 'comments', 'comment-1',
      'meta:instagram:comments:local-ig-a:comment-1',
      '{"object":"instagram","entry":[{"id":"local-ig-a","changes":[{"field":"comments","value":{"id":"comment-1","from":{"username":" @Joao "},"media":{"id":"post-1"}}}]}]}'::jsonb);
  -- The external username fixture is intentionally plain for the first ingestion.
  update public.webhook_events set payload = jsonb_set(payload, '{entry,0,changes,0,value,from,username}', '"Joao"'::jsonb)
    where id = v_event;

  v_contact := public.ingest_social_comment_event(v_event);
  if v_contact is null then raise exception 'first comment did not create contact'; end if;
  v_contact_again := public.ingest_social_comment_event(v_event);
  if v_contact_again is distinct from v_contact then raise exception 'repeated realtime event duplicated contact'; end if;
  select count(*) into v_count from public.social_engagements where organization_id = v_org;
  if v_count <> 1 then raise exception 'repeated event duplicated engagement'; end if;
  select id into v_lead from public.social_leads where contact_id = v_contact;
  if v_lead is null then raise exception 'first engagement did not create lead'; end if;
  if not exists (select 1 from public.social_leads where id = v_lead and central_stage = 'new_lead') then
    raise exception 'lead did not begin at new_lead';
  end if;

  v_contact_again := public.upsert_social_contact(v_org, v_account, null, '  JOAO  ');
  if v_contact_again is distinct from v_contact then raise exception 'username fallback failed'; end if;
  insert into public.webhook_events(id, organization_id, instagram_account_id, object_type, event_type,
    external_object_id, idempotency_key, payload)
    values (v_second_event, v_org, v_account, 'instagram', 'comments', 'comment-username-2',
      'meta:instagram:comments:local-ig-a:comment-username-2',
      '{"object":"instagram","entry":[{"id":"local-ig-a","changes":[{"field":"comments","value":{"id":"comment-username-2","from":{"username":"JOAO"}}}]}]}'::jsonb);
  v_contact_again := public.ingest_social_comment_event(v_second_event);
  if v_contact_again is distinct from v_contact then raise exception 'second username comment duplicated contact'; end if;
  v_contact_again := public.upsert_social_contact(v_org, v_account, 'user-123', 'joao');
  if v_contact_again is distinct from v_contact then raise exception 'external ID upgrade failed'; end if;
  v_contact_again := public.upsert_social_contact(v_org, v_account, 'user-123', 'renamed');
  if v_contact_again is distinct from v_contact then raise exception 'external ID priority failed'; end if;

  insert into public.webhook_events(id, organization_id, instagram_account_id, object_type, event_type,
    external_object_id, idempotency_key, payload)
    values (v_historical_event, v_org, v_account, 'instagram', 'comments', 'comment-2',
      'meta:instagram:comments:local-ig-a:comment-2',
      '{"source":"historical_backfill","object":"instagram","entry":[{"id":"local-ig-a","changes":[{"field":"comments","value":{"id":"comment-2","from":{"id":"user-123","username":"renamed"}}}]}]}'::jsonb);
  v_contact_again := public.ingest_social_comment_event(v_historical_event);
  if v_contact_again is distinct from v_contact then raise exception 'historical contact duplicated'; end if;
  select count(*) into v_count from public.social_engagements where contact_id = v_contact;
  if v_count <> 3 then raise exception 'second comment missing or duplicated'; end if;
  select count(*) into v_count from public.social_leads where contact_id = v_contact and status in ('active','awaiting_signal');
  if v_count <> 1 then raise exception 'duplicate active lead'; end if;
  if not exists (select 1 from public.social_engagements where webhook_event_id = v_historical_event and source = 'historical_backfill') then
    raise exception 'historical source missing';
  end if;
  v_failed := false;
  begin
    insert into public.webhook_events(organization_id, instagram_account_id, object_type, event_type,
      external_object_id, idempotency_key, payload)
      values (v_org, v_account, 'instagram', 'comments', 'comment-2',
        'meta:instagram:comments:local-ig-a:comment-2', '{}'::jsonb);
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'realtime plus historical duplicated event'; end if;

  if not exists (select 1 from public.social_leads where id = v_lead and central_stage = 'first_contact') then
    raise exception 'second engagement did not advance to first_contact';
  end if;
  perform public.transition_social_lead_stage(v_org, v_lead, 'central', 'qualification', 'qualify', 'system', 'system');
  perform public.transition_social_lead_stage(v_org, v_lead, 'central', 'routing', 'route', 'system', 'system');
  foreach v_route in array array['franchise','q3','hotmart','nuy','no_profile'] loop
    perform public.route_social_lead(v_org, v_lead, v_route, 0.7, 60, 'local test route', 'review', 'system', 'system');
    if v_route = 'no_profile' then
      if not exists (select 1 from public.social_leads where id = v_lead and status = 'awaiting_signal' and vertical_stage is null) then
        raise exception 'no_profile not awaiting signal';
      end if;
    else
      if not exists (select 1 from public.social_leads where id = v_lead and vertical_stage = 'lead_received') then
        raise exception 'vertical did not begin at lead_received';
      end if;
    end if;
  end loop;
  perform public.transition_social_lead_stage(v_org, v_lead, 'central', 'qualification', 'new signal', 'system', 'system');
  if not exists (select 1 from public.social_leads where id = v_lead and route_type is null and status = 'active') then
    raise exception 'no_profile requalification failed';
  end if;
  perform public.transition_social_lead_stage(v_org, v_lead, 'central', 'routing', 'reroute', 'system', 'system');
  perform public.route_social_lead(v_org, v_lead, 'franchise', 0.8, 75, 'franchise fit', 'review', 'system', 'system');
  v_failed := false;
  begin
    perform public.transition_social_lead_stage(v_org, v_lead, 'franchise', 'closing', 'skip', 'system', 'system');
  exception when sqlstate '22023' then v_failed := true;
  end;
  if not v_failed then raise exception 'invalid vertical transition accepted'; end if;
  perform public.transition_social_lead_stage(v_org, v_lead, 'franchise', 'presentation', 'next', 'system', 'system');
  if (select count(*) from public.social_lead_stage_history where lead_id = v_lead) < 13 then
    raise exception 'stage history incomplete';
  end if;

  v_failed := false;
  begin
    perform public.transition_social_lead_stage(v_other_org, v_lead, 'central', 'qualification', 'cross tenant', 'system', 'system');
  exception when sqlstate 'P0002' then v_failed := true;
  end;
  if not v_failed then raise exception 'cross-tenant transition accepted'; end if;
  if has_table_privilege('anon', 'public.social_contacts', 'select')
    or has_table_privilege('authenticated', 'public.social_leads', 'select') then
    raise exception 'CRM tables exposed to browser roles';
  end if;
  if (select count(*) from public.outbound_actions where organization_id = v_org) <> 0 then
    raise exception 'CRM ingestion created outbound action';
  end if;
end $test$;

-- Runtime access checks: browser role cannot read or write CRM rows, while
-- the backend service role can read them. These checks remain in the rollback.
set local role authenticated;
do $access$
declare v_denied boolean;
begin
  v_denied := false;
  begin
    perform count(*) from public.social_contacts;
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated role read CRM contacts'; end if;
  v_denied := false;
  begin
    insert into public.social_contacts(organization_id, instagram_account_id, username)
      values (gen_random_uuid(), gen_random_uuid(), 'cross-tenant');
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'authenticated role wrote CRM contacts'; end if;
end $access$;
reset role;
set local role service_role;
do $backend$
declare
  v_org uuid;
  v_account uuid;
  v_contact uuid;
  v_event uuid;
  v_lead uuid;
begin
  if (select count(*) from public.social_contacts) <> 1 then
    raise exception 'service role cannot read CRM contacts';
  end if;
  select organization_id, instagram_account_id, id into v_org, v_account, v_contact
    from public.social_contacts limit 1;
  select id into v_event from public.webhook_events where external_object_id = 'comment-1' limit 1;
  select id into v_lead from public.social_leads where contact_id = v_contact;
  if public.upsert_social_contact(v_org, v_account, 'user-123', 'renamed') is distinct from v_contact then
    raise exception 'service role contact RPC failed';
  end if;
  if public.get_or_create_social_lead(v_org, v_contact) is distinct from v_lead then
    raise exception 'service role lead RPC failed';
  end if;
  perform public.record_social_engagement(v_org, v_contact, v_account, v_event, 'comment-1',
    'comment', 'realtime', now());
  if (select count(*) from public.social_engagements where contact_id = v_contact) <> 3 then
    raise exception 'service role engagement RPC duplicated';
  end if;
  perform public.transition_social_lead_stage(v_org, v_lead, 'franchise', 'evaluation',
    'service role step', 'system', 'system');
  perform public.route_social_lead(v_org, v_lead, 'q3', 0.8, 70,
    'service role route', 'review', 'system', 'system');
end $backend$;
reset role;
select extensions.pass('social CRM core integration contract');
select * from extensions.finish();
rollback;

