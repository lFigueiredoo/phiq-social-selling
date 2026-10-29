-- F22B: CRM social shared by realtime and historical ingestion. Backend only.
create table public.social_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  instagram_account_id uuid not null,
  external_user_id text,
  username text,
  username_normalized text generated always as (nullif(lower(btrim(username)), '')) stored,
  display_name text,
  profile_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  engagement_count integer not null default 0 check (engagement_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (instagram_account_id, organization_id)
    references public.instagram_accounts(id, organization_id),
  check (external_user_id is not null or username_normalized is not null),
  check (external_user_id is null or btrim(external_user_id) <> ''),
  check (profile_url is null or profile_url ~ '^https://(www[.])?instagram[.]com/')
);
create unique index social_contacts_external_identity
  on public.social_contacts(organization_id, instagram_account_id, external_user_id)
  where external_user_id is not null;
create unique index social_contacts_username_identity
  on public.social_contacts(organization_id, instagram_account_id, username_normalized)
  where username_normalized is not null;
create index social_contacts_account on public.social_contacts(organization_id, instagram_account_id);
create trigger social_contacts_updated before update on public.social_contacts
  for each row execute function public.set_updated_at();

create table public.social_engagements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  contact_id uuid not null,
  instagram_account_id uuid not null,
  webhook_event_id uuid,
  external_engagement_id text,
  media_external_id text,
  media_permalink text,
  engagement_type text not null check (engagement_type in ('comment','dm','mention','reply','like','historical_comment','other')),
  source text not null check (source in ('realtime','historical_backfill','browser_collector','manual')),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (webhook_event_id),
  foreign key (contact_id, organization_id) references public.social_contacts(id, organization_id),
  foreign key (instagram_account_id, organization_id) references public.instagram_accounts(id, organization_id),
  foreign key (webhook_event_id, organization_id) references public.webhook_events(id, organization_id),
  check (external_engagement_id is null or btrim(external_engagement_id) <> ''),
  check (media_permalink is null or media_permalink ~ '^https://')
);
-- A historical copy and a realtime delivery of one comment share this key.
create unique index social_engagements_provider_identity
  on public.social_engagements(organization_id, instagram_account_id, engagement_type, external_engagement_id)
  where external_engagement_id is not null;
create index social_engagements_contact_time on public.social_engagements(organization_id, contact_id, occurred_at desc);

create table public.social_leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  contact_id uuid not null,
  central_stage text not null default 'new_lead'
    check (central_stage in ('new_lead','first_contact','qualification','routing')),
  route_type text check (route_type in ('franchise','q3','hotmart','nuy','no_profile')),
  route_confidence numeric(4,3) check (route_confidence between 0 and 1),
  route_reason text,
  recommended_next_action text,
  lead_score smallint check (lead_score between 0 and 100),
  vertical_stage text,
  status text not null default 'active' check (status in ('active','awaiting_signal','won','lost')),
  first_contact_at timestamptz,
  qualified_at timestamptz,
  routed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (contact_id, organization_id) references public.social_contacts(id, organization_id),
  check (route_type is null or central_stage = 'routing'),
  check ((route_type = 'no_profile' and status = 'awaiting_signal' and vertical_stage is null)
    or (route_type is distinct from 'no_profile' and status <> 'awaiting_signal')),
  check (vertical_stage is null or (route_type in ('franchise','q3','hotmart','nuy') and central_stage = 'routing'))
);
create unique index social_leads_one_active_per_contact
  on public.social_leads(organization_id, contact_id) where status in ('active','awaiting_signal');
create index social_leads_route on public.social_leads(organization_id, route_type, vertical_stage);
create trigger social_leads_updated before update on public.social_leads
  for each row execute function public.set_updated_at();

create table public.social_lead_stage_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  lead_id uuid not null,
  pipeline text not null check (pipeline in ('central','franchise','q3','hotmart','nuy')),
  from_stage text,
  to_stage text not null,
  reason text not null check (btrim(reason) <> ''),
  source text not null check (source in ('system','ai','human','import')),
  changed_by_type text not null check (changed_by_type in ('system','ai','human')),
  changed_at timestamptz not null default now(),
  foreign key (lead_id, organization_id) references public.social_leads(id, organization_id)
);
create index social_lead_history_timeline on public.social_lead_stage_history(organization_id, lead_id, changed_at, id);

alter table public.social_contacts enable row level security;
alter table public.social_engagements enable row level security;
alter table public.social_leads enable row level security;
alter table public.social_lead_stage_history enable row level security;
revoke all on public.social_contacts, public.social_engagements, public.social_leads,
  public.social_lead_stage_history from public, anon, authenticated, service_role;
grant select, insert, update on public.social_contacts, public.social_leads to service_role;
grant select, insert on public.social_engagements, public.social_lead_stage_history to service_role;

create function public.upsert_social_contact(
  p_organization_id uuid, p_instagram_account_id uuid,
  p_external_user_id text, p_username text, p_seen_at timestamptz default now()
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_external text := nullif(btrim(p_external_user_id), '');
  v_username text := nullif(lower(btrim(p_username)), '');
  v_id uuid;
  v_owner uuid;
begin
  if p_organization_id is null or p_instagram_account_id is null or (v_external is null and v_username is null) then
    raise exception 'social_identity_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.instagram_accounts a where a.id = p_instagram_account_id and a.organization_id = p_organization_id) then
    raise exception 'instagram_account_not_in_organization' using errcode = '23503';
  end if;
  -- Serialize identities before lookup, including the username-to-ID upgrade.
  if v_username is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text || ':' || p_instagram_account_id::text || ':u:' || v_username, 0));
  end if;
  if v_external is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_organization_id::text || ':' || p_instagram_account_id::text || ':i:' || v_external, 0));
    select id into v_id from public.social_contacts
      where organization_id = p_organization_id and instagram_account_id = p_instagram_account_id and external_user_id = v_external for update;
  end if;
  if v_username is not null then
    select id into v_owner from public.social_contacts
      where organization_id = p_organization_id and instagram_account_id = p_instagram_account_id and username_normalized = v_username for update;
  end if;
  if v_id is null and v_owner is not null then
    if v_external is null or exists (select 1 from public.social_contacts c where c.id = v_owner and c.external_user_id is null) then
      v_id := v_owner;
    end if;
  end if;
  if v_id is null then
    insert into public.social_contacts(organization_id, instagram_account_id, external_user_id, username, first_seen_at, last_seen_at)
      values (p_organization_id, p_instagram_account_id, v_external,
        case when v_owner is null then v_username else null end, coalesce(p_seen_at, now()), coalesce(p_seen_at, now()))
      returning id into v_id;
  else
    update public.social_contacts set
      external_user_id = coalesce(external_user_id, v_external),
      username = case when v_username is not null and (v_owner is null or v_owner = v_id) then v_username else username end,
      first_seen_at = least(first_seen_at, coalesce(p_seen_at, now())),
      last_seen_at = greatest(last_seen_at, coalesce(p_seen_at, now()))
    where id = v_id;
  end if;
  return v_id;
end $$;

create function public.get_or_create_social_lead(p_organization_id uuid, p_contact_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.social_contacts c where c.id = p_contact_id and c.organization_id = p_organization_id) then
    raise exception 'contact_not_in_organization' using errcode = '23503';
  end if;
  insert into public.social_leads(organization_id, contact_id)
    values (p_organization_id, p_contact_id)
    on conflict (organization_id, contact_id) where status in ('active','awaiting_signal') do nothing
    returning id into v_id;
  if v_id is not null then
    insert into public.social_lead_stage_history(organization_id, lead_id, pipeline, to_stage, reason, source, changed_by_type)
      values (p_organization_id, v_id, 'central', 'new_lead', 'first_engagement', 'system', 'system');
  else
    select id into v_id from public.social_leads
      where organization_id = p_organization_id and contact_id = p_contact_id and status in ('active','awaiting_signal');
  end if;
  return v_id;
end $$;

create function public.record_social_engagement(
  p_organization_id uuid, p_contact_id uuid, p_instagram_account_id uuid,
  p_webhook_event_id uuid, p_external_engagement_id text, p_engagement_type text,
  p_source text, p_occurred_at timestamptz, p_media_external_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if p_webhook_event_id is null and nullif(btrim(p_external_engagement_id), '') is null then
    raise exception 'engagement_identity_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.social_contacts c where c.id = p_contact_id and c.organization_id = p_organization_id and c.instagram_account_id = p_instagram_account_id) then
    raise exception 'contact_not_in_account' using errcode = '23503';
  end if;
  if p_webhook_event_id is not null and not exists (select 1 from public.webhook_events e where e.id = p_webhook_event_id and e.organization_id = p_organization_id and e.instagram_account_id = p_instagram_account_id) then
    raise exception 'event_not_in_account' using errcode = '23503';
  end if;
  insert into public.social_engagements(organization_id, contact_id, instagram_account_id,
      webhook_event_id, external_engagement_id, engagement_type, source, occurred_at, media_external_id, metadata)
    values (p_organization_id, p_contact_id, p_instagram_account_id, p_webhook_event_id,
      nullif(btrim(p_external_engagement_id), ''), p_engagement_type, p_source,
      coalesce(p_occurred_at, now()), p_media_external_id, coalesce(p_metadata, '{}'::jsonb))
    on conflict do nothing returning id into v_id;
  if v_id is not null then
    update public.social_contacts set engagement_count = engagement_count + 1,
      last_seen_at = greatest(last_seen_at, coalesce(p_occurred_at, now())) where id = p_contact_id;
  else
    select id into v_id from public.social_engagements
      where organization_id = p_organization_id and instagram_account_id = p_instagram_account_id
        and ((p_webhook_event_id is not null and webhook_event_id = p_webhook_event_id)
          or (p_external_engagement_id is not null and external_engagement_id = p_external_engagement_id and engagement_type = p_engagement_type))
      limit 1;
  end if;
  return v_id;
end $$;

create function public.ingest_social_comment_event(p_webhook_event_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_event public.webhook_events%rowtype;
  v_change jsonb;
  v_user_id text;
  v_username text;
  v_contact uuid;
  v_source text;
  v_occurred timestamptz;
begin
  select * into v_event from public.webhook_events where id = p_webhook_event_id;
  if not found or v_event.organization_id is null or v_event.instagram_account_id is null then
    raise exception 'mapped_comment_event_required' using errcode = '22023';
  end if;
  if v_event.event_type not in ('comments','live_comments') then
    raise exception 'comment_event_required' using errcode = '22023';
  end if;
  select change into v_change
    from jsonb_array_elements(coalesce(v_event.payload->'entry', '[]'::jsonb)) entry,
         jsonb_array_elements(coalesce(entry->'changes', '[]'::jsonb)) change
    where change->>'field' = v_event.event_type
      and change->'value'->>'id' = v_event.external_object_id
      and entry->>'id' = (select a.external_id from public.instagram_accounts a where a.id = v_event.instagram_account_id)
    limit 1;
  if v_change is null then raise exception 'comment_change_not_found' using errcode = '22023'; end if;
  v_user_id := nullif(btrim(v_change->'value'->'from'->>'id'), '');
  v_username := nullif(btrim(v_change->'value'->'from'->>'username'), '');
  if v_user_id is null and v_username is null then
    -- Keep the webhook/job for later enrichment; never invent an identity.
    return null;
  end if;
  v_source := case when v_event.payload->>'source' = 'historical_backfill' then 'historical_backfill' else 'realtime' end;
  begin
    v_occurred := (v_change->'value'->>'timestamp')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    v_occurred := null;
  end;
  v_occurred := coalesce(v_occurred, v_event.received_at);
  v_contact := public.upsert_social_contact(v_event.organization_id, v_event.instagram_account_id, v_user_id, v_username, v_occurred);
  perform public.record_social_engagement(v_event.organization_id, v_contact, v_event.instagram_account_id,
    v_event.id, v_event.external_object_id, 'comment', v_source, v_occurred,
    v_change->'value'->'media'->>'id', jsonb_build_object('event_type', v_event.event_type));
  perform public.get_or_create_social_lead(v_event.organization_id, v_contact);
  return v_contact;
end $$;

create function public.social_vertical_stage_position(p_route text, p_stage text)
returns integer language sql immutable security invoker set search_path = '' as $$
  select array_position(case p_route
    when 'franchise' then array['lead_received','presentation','evaluation','proposal','negotiation','closing','implementation']
    when 'q3' then array['lead_received','diagnosis','presentation','proposal','negotiation','onboarding','active_client']
    when 'hotmart' then array['lead_received','course_recommendation','offer','follow_up','purchase','active_student']
    when 'nuy' then array['lead_received','needs_identification','product_recommendation','offer','purchase','after_sales']
    else array[]::text[] end, p_stage);
$$;

create function public.transition_social_lead_stage(
  p_organization_id uuid, p_lead_id uuid, p_pipeline text, p_to_stage text,
  p_reason text, p_source text, p_changed_by_type text, p_human_override boolean default false
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_from text; v_next integer; v_current integer;
begin
  if nullif(btrim(p_reason), '') is null then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_human_override and (p_source is distinct from 'human' or p_changed_by_type is distinct from 'human') then
    raise exception 'explicit_human_override_required' using errcode = '22023';
  end if;
  select * into v_lead from public.social_leads where id = p_lead_id and organization_id = p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode = 'P0002'; end if;
  if p_pipeline = 'central' then
    v_from := v_lead.central_stage;
    if not p_human_override and not (
      (v_from = 'new_lead' and p_to_stage = 'first_contact') or
      (v_from = 'first_contact' and p_to_stage = 'qualification') or
      (v_from = 'qualification' and p_to_stage = 'routing') or
      (v_from = 'routing' and v_lead.route_type = 'no_profile' and p_to_stage = 'qualification')
    ) then raise exception 'invalid_central_transition' using errcode = '22023'; end if;
    if v_from = p_to_stage then raise exception 'stage_unchanged' using errcode = '22023'; end if;
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
    if v_next is null or (not p_human_override and (v_current is null or v_next <> v_current + 1)) or v_from = p_to_stage then
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

create function public.route_social_lead(
  p_organization_id uuid, p_lead_id uuid, p_route_type text,
  p_confidence numeric, p_lead_score integer, p_reason text,
  p_recommended_next_action text, p_source text, p_changed_by_type text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype;
begin
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

revoke all on function public.upsert_social_contact(uuid,uuid,text,text,timestamptz),
  public.get_or_create_social_lead(uuid,uuid),
  public.record_social_engagement(uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,jsonb),
  public.ingest_social_comment_event(uuid),
  public.social_vertical_stage_position(text,text),
  public.transition_social_lead_stage(uuid,uuid,text,text,text,text,text,boolean),
  public.route_social_lead(uuid,uuid,text,numeric,integer,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.upsert_social_contact(uuid,uuid,text,text,timestamptz),
  public.get_or_create_social_lead(uuid,uuid),
  public.record_social_engagement(uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,jsonb),
  public.ingest_social_comment_event(uuid),
  public.social_vertical_stage_position(text,text),
  public.transition_social_lead_stage(uuid,uuid,text,text,text,text,text,boolean),
  public.route_social_lead(uuid,uuid,text,numeric,integer,text,text,text,text)
  to service_role;
