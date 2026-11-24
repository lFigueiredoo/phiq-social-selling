-- Inbox conversacional, operação comercial, privacidade e observabilidade.
-- Toda tabela continua backend-only. O navegador acessa apenas Edge Functions
-- autenticadas, e toda mutação crítica revalida membership no PostgreSQL.

create table public.social_selling_settings (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  response_sla_minutes integer not null default 30 check (response_sla_minutes between 5 and 1440),
  retention_days integer not null default 180 check (retention_days between 30 and 730),
  retention_enabled boolean not null default false,
  auto_assign_enabled boolean not null default true,
  auto_suggest_enabled boolean not null default true,
  conversation_daily_limit integer not null default 100 check (conversation_daily_limit between 1 and 500),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, updated_by)
    references public.organization_members(organization_id, user_id)
);

create table public.social_contact_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  contact_id uuid not null,
  channel_status text not null default 'not_recorded'
    check (channel_status in ('not_recorded','allowed','opted_out','blocked')),
  lawful_basis_status text not null default 'not_recorded'
    check (lawful_basis_status in ('not_recorded','reviewed_legitimate_interest','consent','contract','not_applicable')),
  do_not_contact boolean not null default false,
  reason text,
  source text not null default 'system' check (source in ('system','user','operator','import')),
  opted_out_at timestamptz,
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, contact_id),
  foreign key (contact_id, organization_id)
    references public.social_contacts(id, organization_id)
);

create table public.instagram_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  instagram_account_id uuid not null,
  contact_id uuid not null,
  lead_id uuid,
  external_user_id text not null check (btrim(external_user_id) <> ''),
  username text,
  status text not null default 'open'
    check (status in ('open','pending','waiting_customer','resolved','blocked')),
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  owner_user_id uuid,
  unread_count integer not null default 0 check (unread_count >= 0),
  first_message_at timestamptz not null,
  last_message_at timestamptz not null,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  reply_window_until timestamptz,
  sla_due_at timestamptz,
  opted_out boolean not null default false,
  opted_out_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  constraint instagram_conversations_identity_unique
    unique (organization_id, instagram_account_id, external_user_id),
  foreign key (instagram_account_id, organization_id)
    references public.instagram_accounts(id, organization_id),
  foreign key (contact_id, organization_id)
    references public.social_contacts(id, organization_id),
  foreign key (lead_id, organization_id)
    references public.social_leads(id, organization_id),
  foreign key (organization_id, owner_user_id)
    references public.organization_members(organization_id, user_id),
  check (reply_window_until is null or last_inbound_at is not null),
  check (not opted_out or opted_out_at is not null)
);

create table public.instagram_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  conversation_id uuid not null,
  webhook_event_id uuid,
  source_processing_job_id uuid,
  direction text not null check (direction in ('inbound','outbound')),
  status text not null
    check (status in ('received','proposed','approved','dispatching','sent','failed','cancelled','blocked')),
  provider_message_id text,
  message_text text not null,
  idempotency_key text not null unique,
  model_provider text,
  model_name text,
  prompt_version text,
  analysis_summary text,
  created_by_user_id uuid,
  approved_by_user_id uuid,
  approved_at timestamptz,
  dispatch_started_at timestamptz,
  sent_at timestamptz,
  eligible_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (webhook_event_id),
  unique (source_processing_job_id),
  foreign key (conversation_id, organization_id)
    references public.instagram_conversations(id, organization_id) on delete restrict,
  foreign key (webhook_event_id, organization_id)
    references public.webhook_events(id, organization_id),
  foreign key (source_processing_job_id, organization_id)
    references public.processing_jobs(id, organization_id),
  foreign key (organization_id, created_by_user_id)
    references public.organization_members(organization_id, user_id),
  foreign key (organization_id, approved_by_user_id)
    references public.organization_members(organization_id, user_id),
  check (length(message_text) <= 2000),
  check (direction = 'inbound' or octet_length(btrim(message_text)) between 1 and 1000),
  check (direction = 'outbound' or status = 'received'),
  check (status not in ('approved','dispatching','sent') or approved_at is not null)
);

create unique index instagram_conversation_messages_provider_unique
  on public.instagram_conversation_messages(organization_id, provider_message_id)
  where provider_message_id is not null;
create index instagram_conversations_queue
  on public.instagram_conversations(organization_id, status, priority, last_message_at desc);
create index instagram_conversations_owner
  on public.instagram_conversations(organization_id, owner_user_id, status);
create index instagram_conversation_messages_timeline
  on public.instagram_conversation_messages(organization_id, conversation_id, created_at, id);
create index instagram_conversation_messages_dispatch
  on public.instagram_conversation_messages(status, approved_at)
  where direction = 'outbound' and status in ('approved','dispatching');

create table public.social_followup_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  conversation_id uuid,
  lead_id uuid,
  source_message_id uuid,
  assignee_user_id uuid,
  task_type text not null check (task_type in ('reply','follow_up','review','retention_review')),
  status text not null default 'open' check (status in ('open','done','cancelled')),
  title text not null check (btrim(title) <> '' and length(title) <= 200),
  due_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, source_message_id, task_type),
  foreign key (conversation_id, organization_id)
    references public.instagram_conversations(id, organization_id),
  foreign key (lead_id, organization_id)
    references public.social_leads(id, organization_id),
  foreign key (source_message_id, organization_id)
    references public.instagram_conversation_messages(id, organization_id),
  foreign key (organization_id, assignee_user_id)
    references public.organization_members(organization_id, user_id)
);

create index social_followup_tasks_due
  on public.social_followup_tasks(organization_id, status, due_at);

create table public.social_catalog_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  route_type text check (route_type in ('franchise','q3','hotmart','nuy')),
  offer_kind text not null check (offer_kind in ('franchise','course','product','service')),
  name text not null check (btrim(name) <> '' and length(name) <= 160),
  summary text not null default '' check (length(summary) <= 1000),
  audience text not null default '' check (length(audience) <= 500),
  approved_claims jsonb not null default '[]'::jsonb check (jsonb_typeof(approved_claims) = 'array'),
  prohibited_claims jsonb not null default '[]'::jsonb check (jsonb_typeof(prohibited_claims) = 'array'),
  price_text text check (price_text is null or length(price_text) <= 120),
  public_url text check (public_url is null or public_url ~ '^https://'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.social_model_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  conversation_message_id uuid not null,
  reviewer_user_id uuid not null,
  rating text not null check (rating in ('accepted','edited','rejected','unsafe')),
  tags jsonb not null default '[]'::jsonb check (jsonb_typeof(tags) = 'array'),
  corrected_text text check (corrected_text is null or length(corrected_text) <= 1000),
  notes text check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),
  unique (conversation_message_id, reviewer_user_id),
  foreign key (conversation_message_id, organization_id)
    references public.instagram_conversation_messages(id, organization_id),
  foreign key (organization_id, reviewer_user_id)
    references public.organization_members(organization_id, user_id)
);

create table public.social_operational_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  dedup_key text not null,
  alert_type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  title text not null check (btrim(title) <> '' and length(title) <= 200),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedup_key),
  foreign key (organization_id, acknowledged_by)
    references public.organization_members(organization_id, user_id)
);

create index social_operational_alerts_open
  on public.social_operational_alerts(organization_id, severity, last_seen_at desc)
  where status <> 'resolved';

create trigger social_selling_settings_updated before update on public.social_selling_settings
  for each row execute function public.set_updated_at();
create trigger social_contact_preferences_updated before update on public.social_contact_preferences
  for each row execute function public.set_updated_at();
create trigger instagram_conversations_updated before update on public.instagram_conversations
  for each row execute function public.set_updated_at();
create trigger instagram_conversation_messages_updated before update on public.instagram_conversation_messages
  for each row execute function public.set_updated_at();
create trigger social_followup_tasks_updated before update on public.social_followup_tasks
  for each row execute function public.set_updated_at();
create trigger social_catalog_offers_updated before update on public.social_catalog_offers
  for each row execute function public.set_updated_at();
create trigger social_operational_alerts_updated before update on public.social_operational_alerts
  for each row execute function public.set_updated_at();

alter table public.social_selling_settings enable row level security;
alter table public.social_contact_preferences enable row level security;
alter table public.instagram_conversations enable row level security;
alter table public.instagram_conversation_messages enable row level security;
alter table public.social_followup_tasks enable row level security;
alter table public.social_catalog_offers enable row level security;
alter table public.social_model_feedback enable row level security;
alter table public.social_operational_alerts enable row level security;

revoke all on public.social_selling_settings, public.social_contact_preferences,
  public.instagram_conversations, public.instagram_conversation_messages,
  public.social_followup_tasks, public.social_catalog_offers,
  public.social_model_feedback, public.social_operational_alerts
from public, anon, authenticated, service_role;

grant select, insert, update on public.social_selling_settings,
  public.social_contact_preferences, public.instagram_conversations,
  public.instagram_conversation_messages, public.social_followup_tasks,
  public.social_catalog_offers, public.social_operational_alerts
to service_role;
grant select, insert, update on public.social_model_feedback to service_role;

insert into public.social_selling_settings(organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

insert into public.social_catalog_offers(
  organization_id, route_type, offer_kind, name, summary, audience, sort_order
)
select o.id, seed.route_type, seed.offer_kind, seed.name, '', '', seed.sort_order
from public.organizations o
cross join (values
  ('franchise','franchise','Franquia PHIQ',10),
  ('q3','service','Q3',20),
  ('hotmart','course','Cursos',30),
  ('nuy','product','NUY Creators',40)
) as seed(route_type, offer_kind, name, sort_order)
on conflict (organization_id, name) do nothing;

create or replace function public.assign_social_lead_round_robin(
  p_organization_id uuid,
  p_lead_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_lead public.social_leads%rowtype;
  v_owner uuid;
begin
  select * into v_lead
  from public.social_leads
  where id = p_lead_id and organization_id = p_organization_id
  for update;
  if not found then return null; end if;
  if v_lead.owner_user_id is not null then return v_lead.owner_user_id; end if;
  if not coalesce((select auto_assign_enabled from public.social_selling_settings
    where organization_id = p_organization_id), true) then return null; end if;

  select m.user_id into v_owner
  from public.organization_members m
  left join public.social_leads l
    on l.organization_id = m.organization_id
   and l.owner_user_id = m.user_id
   and l.status in ('active','awaiting_signal')
  where m.organization_id = p_organization_id and m.status = 'active'
  group by m.user_id, m.created_at
  order by count(l.id), m.created_at, m.user_id
  limit 1;

  if v_owner is null then return null; end if;
  update public.social_leads set owner_user_id = v_owner where id = v_lead.id;
  insert into public.social_lead_stage_history(
    organization_id, lead_id, pipeline, from_stage, to_stage, reason,
    source, changed_by_type, changed_by_id, route_type, from_status,
    to_status, operation_key, details
  ) values (
    p_organization_id, v_lead.id,
    case when v_lead.route_type in ('franchise','q3','hotmart','nuy')
      then v_lead.route_type else 'central' end,
    coalesce(v_lead.vertical_stage, v_lead.central_stage),
    coalesce(v_lead.vertical_stage, v_lead.central_stage),
    'automatic_round_robin_assignment', 'system', 'system', null,
    v_lead.route_type, v_lead.status, v_lead.status,
    'auto-assign:' || v_lead.id::text,
    jsonb_build_object('field','owner_user_id','to',v_owner)
  ) on conflict (organization_id, operation_key) where operation_key is not null do nothing;
  return v_owner;
end;
$function$;

create or replace function public.ingest_instagram_message_event(
  p_webhook_event_id uuid
)
returns table(
  conversation_id uuid,
  conversation_message_id uuid,
  contact_id uuid,
  lead_id uuid,
  owner_user_id uuid,
  already_exists boolean
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_event public.webhook_events%rowtype;
  v_payload jsonb;
  v_sender_id text;
  v_message_id text;
  v_text text;
  v_occurred timestamptz;
  v_contact uuid;
  v_lead uuid;
  v_owner uuid;
  v_conversation uuid;
  v_message uuid;
  v_existing boolean := false;
  v_sla integer;
begin
  select * into v_event from public.webhook_events
  where id = p_webhook_event_id for update;
  if not found or v_event.organization_id is null or v_event.instagram_account_id is null
     or v_event.event_type <> 'messages' then
    raise exception 'mapped_message_event_required' using errcode = '22023';
  end if;

  select message into v_payload
  from jsonb_array_elements(coalesce(v_event.payload->'entry','[]'::jsonb)) entry,
       jsonb_array_elements(coalesce(entry->'messaging','[]'::jsonb)) message
  where message->'message'->>'mid' = v_event.external_object_id
  limit 1;
  if v_payload is null then
    raise exception 'message_payload_not_found' using errcode = '22023';
  end if;
  if coalesce((v_payload->'message'->>'is_echo')::boolean, false) then
    raise exception 'echo_message_not_ingestable' using errcode = '22023';
  end if;

  v_sender_id := nullif(btrim(v_payload->'sender'->>'id'), '');
  v_message_id := nullif(btrim(v_payload->'message'->>'mid'), '');
  v_text := left(coalesce(v_payload->'message'->>'text', ''), 2000);
  if v_sender_id is null or v_message_id is null then
    raise exception 'message_identity_required' using errcode = '22023';
  end if;
  begin
    v_occurred := to_timestamp((v_payload->>'timestamp')::numeric / 1000.0);
  exception when others then
    v_occurred := v_event.received_at;
  end;
  v_occurred := coalesce(v_occurred, v_event.received_at);

  -- Meta pode repetir o mesmo evento. Retornar a conversa existente antes de
  -- incrementar unread_count ou reabrir SLA preserva idempotência real.
  select m.id,c.id,c.contact_id,c.lead_id,c.owner_user_id
  into v_message,v_conversation,v_contact,v_lead,v_owner
  from public.instagram_conversation_messages m
  join public.instagram_conversations c on c.id=m.conversation_id
  where m.organization_id=v_event.organization_id
    and m.idempotency_key='instagram-message:'||v_message_id;
  if found then
    return query select v_conversation,v_message,v_contact,v_lead,v_owner,true;
    return;
  end if;

  v_contact := public.upsert_social_contact(
    v_event.organization_id, v_event.instagram_account_id,
    v_sender_id, null, v_occurred
  );
  v_lead := public.get_or_create_social_lead(v_event.organization_id, v_contact);
  perform public.record_social_engagement(
    v_event.organization_id, v_contact, v_event.instagram_account_id,
    v_event.id, v_message_id, 'dm', 'realtime', v_occurred,
    null, jsonb_build_object('event_type','messages')
  );
  v_owner := public.assign_social_lead_round_robin(v_event.organization_id, v_lead);
  v_sla := coalesce((select response_sla_minutes from public.social_selling_settings
    where organization_id = v_event.organization_id), 30);

  insert into public.social_contact_preferences(organization_id, contact_id)
  values (v_event.organization_id, v_contact)
  on conflict on constraint social_contact_preferences_organization_id_contact_id_key do nothing;

  insert into public.instagram_conversations as c(
    organization_id, instagram_account_id, contact_id, lead_id,
    external_user_id, status, priority, owner_user_id, unread_count,
    first_message_at, last_message_at, last_inbound_at, reply_window_until,
    sla_due_at
  ) values (
    v_event.organization_id, v_event.instagram_account_id, v_contact, v_lead,
    v_sender_id, 'open', 'normal', v_owner, 1,
    v_occurred, v_occurred, v_occurred, v_occurred + interval '24 hours',
    v_occurred + make_interval(mins => v_sla)
  )
  on conflict (organization_id, instagram_account_id, external_user_id)
  do update set
    contact_id = excluded.contact_id,
    lead_id = excluded.lead_id,
    owner_user_id = coalesce(c.owner_user_id, excluded.owner_user_id),
    status = case when c.status = 'blocked' or c.opted_out then c.status else 'open' end,
    unread_count = c.unread_count + 1,
    last_message_at = greatest(c.last_message_at, excluded.last_message_at),
    last_inbound_at = greatest(coalesce(c.last_inbound_at, excluded.last_inbound_at), excluded.last_inbound_at),
    reply_window_until = greatest(coalesce(c.reply_window_until, excluded.reply_window_until), excluded.reply_window_until),
    sla_due_at = excluded.sla_due_at,
    resolved_at = case when c.status = 'resolved' then null else c.resolved_at end,
    updated_at = clock_timestamp()
  returning c.id, c.owner_user_id into v_conversation, v_owner;

  insert into public.instagram_conversation_messages as m(
    organization_id, conversation_id, webhook_event_id, direction, status,
    provider_message_id, message_text, idempotency_key, eligible_until
  ) values (
    v_event.organization_id, v_conversation, v_event.id, 'inbound', 'received',
    v_message_id, v_text, 'instagram-message:' || v_message_id,
    v_occurred + interval '24 hours'
  )
  on conflict (idempotency_key) do nothing
  returning m.id into v_message;
  if v_message is null then
    v_existing := true;
    select id into v_message from public.instagram_conversation_messages
    where idempotency_key = 'instagram-message:' || v_message_id;
  else
    insert into public.social_followup_tasks(
      organization_id, conversation_id, lead_id, source_message_id,
      assignee_user_id, task_type, title, due_at
    ) values (
      v_event.organization_id, v_conversation, v_lead, v_message,
      v_owner, 'reply', 'Responder nova mensagem do Instagram',
      v_occurred + make_interval(mins => v_sla)
    ) on conflict do nothing;
  end if;

  return query select v_conversation, v_message, v_contact, v_lead, v_owner, v_existing;
end;
$function$;

create or replace function public.claim_social_processing_job(
  p_worker_id text,
  p_job_types text[] default array['process_instagram_comment','process_instagram_message']
)
returns table(
  id uuid, organization_id uuid, webhook_event_id uuid, job_type text,
  status text, priority smallint, available_at timestamptz, locked_at timestamptz,
  locked_by text, attempts integer, max_attempts integer,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if nullif(btrim(p_worker_id),'') is null or p_job_types is null
     or cardinality(p_job_types) = 0 then return; end if;
  return query
  with candidate as (
    select pj.id
    from public.processing_jobs pj
    where pj.status = 'pending' and pj.available_at <= now()
      and pj.attempts < pj.max_attempts and pj.job_type = any(p_job_types)
    order by pj.priority desc, pj.created_at, pj.id
    for update skip locked limit 1
  ), claimed as (
    update public.processing_jobs pj
    set status='processing', locked_at=clock_timestamp(), locked_by=p_worker_id,
        attempts=pj.attempts+1, updated_at=clock_timestamp()
    from candidate c where pj.id=c.id returning pj.*
  )
  select c.id,c.organization_id,c.webhook_event_id,c.job_type,c.status,
    c.priority,c.available_at,c.locked_at,c.locked_by,c.attempts,c.max_attempts,
    c.created_at,c.updated_at from claimed c;
end;
$function$;

create or replace function public.save_instagram_conversation_draft(
  p_job_id uuid,
  p_worker_id text,
  p_message_text text,
  p_analysis_summary text,
  p_model_name text,
  p_prompt_version text
)
returns table(message_id uuid, conversation_id uuid, status text, already_exists boolean)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_job public.processing_jobs%rowtype;
  v_event public.webhook_events%rowtype;
  v_inbound public.instagram_conversation_messages%rowtype;
  v_conversation public.instagram_conversations%rowtype;
  v_message uuid;
begin
  if nullif(btrim(p_worker_id),'') is null or nullif(btrim(p_message_text),'') is null
     or length(btrim(p_message_text)) > 500 or octet_length(btrim(p_message_text)) > 1000
     or p_message_text ~* '(https?://|www[.]|```)' then
    raise exception 'invalid_conversation_draft' using errcode='22023';
  end if;
  select pj.* into v_job from public.processing_jobs pj
  where pj.id=p_job_id and pj.status='processing' and pj.locked_by=p_worker_id for update;
  if not found then return; end if;
  select id into v_message from public.instagram_conversation_messages
  where source_processing_job_id=v_job.id limit 1;
  if found then
    return query select m.id,m.conversation_id,m.status,true
    from public.instagram_conversation_messages m where m.id=v_message;
    return;
  end if;
  select * into v_event from public.webhook_events
  where id=v_job.webhook_event_id and organization_id=v_job.organization_id;
  if not found or v_event.event_type <> 'messages' then
    raise exception 'message_event_required' using errcode='22023';
  end if;
  select * into v_inbound from public.instagram_conversation_messages
  where webhook_event_id=v_event.id and direction='inbound';
  if not found then raise exception 'inbound_message_not_found' using errcode='P0002'; end if;
  select * into v_conversation from public.instagram_conversations
  where id=v_inbound.conversation_id and organization_id=v_job.organization_id for update;
  if not found or v_conversation.opted_out or v_conversation.status='blocked'
     or v_conversation.reply_window_until <= clock_timestamp() + interval '10 minutes' then
    raise exception 'conversation_not_replyable' using errcode='P0001';
  end if;
  insert into public.instagram_conversation_messages(
    organization_id,conversation_id,source_processing_job_id,direction,status,
    message_text,idempotency_key,model_provider,model_name,prompt_version,
    analysis_summary,eligible_until
  ) values (
    v_job.organization_id,v_conversation.id,v_job.id,'outbound','proposed',
    btrim(p_message_text),'conversation-draft:'||v_job.id::text,'google',
    btrim(p_model_name),btrim(p_prompt_version),left(btrim(p_analysis_summary),240),
    v_conversation.reply_window_until
  ) returning id into v_message;
  return query select v_message,v_conversation.id,'proposed'::text,false;
end;
$function$;

create or replace function public.panel_create_instagram_conversation_reply(
  p_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_text text,
  p_operation_key text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_conversation public.instagram_conversations%rowtype;
  v_text text := btrim(coalesce(p_message_text,''));
  v_url text;
  v_id uuid;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if v_text='' or length(v_text)>1000 or octet_length(v_text)>1000
     or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>120 then
    raise exception 'invalid_reply' using errcode='22023';
  end if;
  for v_url in select (regexp_matches(v_text,'https?://[^[:space:]]+','g'))[1]
  loop
    if not exists(select 1 from public.social_catalog_offers o
      where o.organization_id=p_organization_id and o.active
        and o.public_url is not null and rtrim(v_url,'.,;!?)')=o.public_url) then
      raise exception 'unapproved_catalog_url' using errcode='P0001';
    end if;
  end loop;
  select * into v_conversation from public.instagram_conversations
  where id=p_conversation_id and organization_id=p_organization_id for update;
  if not found then raise exception 'conversation_not_found' using errcode='P0002'; end if;
  if v_conversation.opted_out or v_conversation.status='blocked'
     or v_conversation.reply_window_until is null
     or v_conversation.reply_window_until <= clock_timestamp()+interval '10 minutes' then
    raise exception 'conversation_not_replyable' using errcode='P0001';
  end if;
  insert into public.instagram_conversation_messages(
    organization_id,conversation_id,direction,status,message_text,idempotency_key,
    created_by_user_id,eligible_until
  ) values (
    p_organization_id,p_conversation_id,'outbound','proposed',v_text,
    'panel-conversation:'||p_organization_id::text||':'||p_operation_key,
    p_user_id,v_conversation.reply_window_until
  ) on conflict (idempotency_key) do update set updated_at=excluded.updated_at
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.panel_approve_instagram_conversation_reply(
  p_user_id uuid,
  p_organization_id uuid,
  p_message_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_message public.instagram_conversation_messages%rowtype;
  v_conversation public.instagram_conversations%rowtype;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  select * into v_message from public.instagram_conversation_messages
  where id=p_message_id and organization_id=p_organization_id for update;
  if not found then raise exception 'message_not_found' using errcode='P0002'; end if;
  if v_message.direction <> 'outbound' or v_message.status <> 'proposed' then
    raise exception 'message_not_proposed' using errcode='P0001';
  end if;
  select * into v_conversation from public.instagram_conversations
  where id=v_message.conversation_id and organization_id=p_organization_id for update;
  if v_conversation.opted_out or v_conversation.status='blocked'
     or v_message.eligible_until <= clock_timestamp()+interval '5 minutes' then
    raise exception 'conversation_not_replyable' using errcode='P0001';
  end if;
  update public.instagram_conversation_messages
  set status='approved',approved_by_user_id=p_user_id,approved_at=clock_timestamp(),last_error=null
  where id=v_message.id;
  insert into public.audit_logs(organization_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  values(p_organization_id,'user',p_user_id::text,'conversation_message.approved',
    'instagram_conversation_message',v_message.id::text,
    jsonb_build_object('conversation_id',v_message.conversation_id));
  return v_message.id;
end;
$function$;

create or replace function public.panel_manage_instagram_conversation(
  p_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_action text,
  p_value text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_conversation public.instagram_conversations%rowtype;
  v_owner uuid;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  select * into v_conversation from public.instagram_conversations
  where id=p_conversation_id and organization_id=p_organization_id for update;
  if not found then raise exception 'conversation_not_found' using errcode='P0002'; end if;
  if p_action='mark_read' then
    update public.instagram_conversations set unread_count=0 where id=p_conversation_id;
  elsif p_action='assign' then
    v_owner := nullif(p_value,'')::uuid;
    if v_owner is not null and not exists(select 1 from public.organization_members
      where organization_id=p_organization_id and user_id=v_owner and status='active') then
      raise exception 'invalid_owner' using errcode='42501';
    end if;
    update public.instagram_conversations set owner_user_id=v_owner where id=p_conversation_id;
    if v_conversation.lead_id is not null then
      update public.social_leads set owner_user_id=v_owner where id=v_conversation.lead_id;
    end if;
  elsif p_action='priority' and p_value in ('low','normal','high','urgent') then
    update public.instagram_conversations set priority=p_value where id=p_conversation_id;
  elsif p_action='status' and p_value in ('open','pending','waiting_customer','resolved') then
    update public.instagram_conversations set status=p_value,
      resolved_at=case when p_value='resolved' then clock_timestamp() else null end
    where id=p_conversation_id;
  elsif p_action='opt_out' then
    update public.instagram_conversations set opted_out=true,opted_out_at=clock_timestamp(),status='blocked'
    where id=p_conversation_id;
    insert into public.social_contact_preferences(
      organization_id,contact_id,channel_status,do_not_contact,reason,source,opted_out_at
    ) values (
      p_organization_id,v_conversation.contact_id,'opted_out',true,
      left(coalesce(p_value,'operator_opt_out'),500),'operator',clock_timestamp()
    ) on conflict (organization_id,contact_id) do update set
      channel_status='opted_out',do_not_contact=true,reason=excluded.reason,
      source='operator',opted_out_at=excluded.opted_out_at,updated_at=clock_timestamp();
    update public.instagram_conversation_messages set status='blocked',last_error='contact_opted_out'
    where conversation_id=p_conversation_id and direction='outbound' and status in ('proposed','approved');
  else
    raise exception 'invalid_conversation_action' using errcode='22023';
  end if;
  insert into public.audit_logs(organization_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  values(p_organization_id,'user',p_user_id::text,'instagram_conversation.'||p_action,
    'instagram_conversation',p_conversation_id::text,jsonb_build_object('value',p_value));
  return p_conversation_id;
end;
$function$;

create or replace function public.claim_instagram_conversation_message(
  p_message_id uuid,
  p_dispatcher text,
  p_account_daily_limit integer default 100
)
returns table(
  message_id uuid,
  conversation_id uuid,
  message_text text,
  external_user_id text,
  instagram_account_external_id text
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_message public.instagram_conversation_messages%rowtype;
  v_conversation public.instagram_conversations%rowtype;
  v_account_count integer;
  v_conversation_count integer;
begin
  if nullif(btrim(p_dispatcher),'') is null or p_account_daily_limit not between 1 and 500 then
    raise exception 'invalid_dispatcher' using errcode='22023';
  end if;
  select m.* into v_message
  from public.instagram_conversation_messages m
  join public.instagram_conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
  where m.direction='outbound' and m.status='approved'
    and m.id=p_message_id
    and m.eligible_until > clock_timestamp()+interval '5 minutes'
    and not c.opted_out and c.status <> 'blocked'
  order by m.approved_at,m.id for update of m skip locked limit 1;
  if not found then return; end if;
  select * into v_conversation from public.instagram_conversations
  where id=v_message.conversation_id for update;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_conversation.instagram_account_id::text||':conversation-dispatch',0));
  select count(*) into v_account_count
  from public.instagram_conversation_messages m
  join public.instagram_conversations c on c.id=m.conversation_id
  where c.instagram_account_id=v_conversation.instagram_account_id
    and m.direction='outbound' and m.sent_at>clock_timestamp()-interval '24 hours';
  select count(*) into v_conversation_count
  from public.instagram_conversation_messages m
  where m.conversation_id=v_conversation.id and m.direction='outbound'
    and m.sent_at>clock_timestamp()-interval '24 hours';
  if v_account_count>=p_account_daily_limit or v_conversation_count>=5 then
    update public.instagram_conversation_messages set status='proposed',approved_at=null,
      approved_by_user_id=null,last_error=case when v_account_count>=p_account_daily_limit
        then 'account_daily_limit_reached' else 'conversation_daily_limit_reached' end
    where id=v_message.id;
    return;
  end if;
  update public.instagram_conversation_messages
  set status='dispatching',dispatch_started_at=clock_timestamp(),last_error=null
  where id=v_message.id;
  return query select v_message.id,v_conversation.id,v_message.message_text,
    v_conversation.external_user_id,a.external_id
  from public.instagram_accounts a where a.id=v_conversation.instagram_account_id;
end;
$function$;

create or replace function public.mark_instagram_conversation_message_sent(
  p_message_id uuid,
  p_provider_message_id text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare v_message public.instagram_conversation_messages%rowtype;
begin
  select * into v_message from public.instagram_conversation_messages
  where id=p_message_id and status='dispatching' for update;
  if not found then return null; end if;
  update public.instagram_conversation_messages set status='sent',sent_at=clock_timestamp(),
    provider_message_id=nullif(btrim(p_provider_message_id),''),last_error=null where id=p_message_id;
  update public.instagram_conversations set status='waiting_customer',last_outbound_at=clock_timestamp(),
    last_message_at=clock_timestamp(),unread_count=0 where id=v_message.conversation_id;
  update public.social_followup_tasks set status='done',completed_at=clock_timestamp()
  where conversation_id=v_message.conversation_id and task_type='reply' and status='open';
  return p_message_id;
end;
$function$;

create or replace function public.mark_instagram_conversation_message_error(
  p_message_id uuid,
  p_error text,
  p_uncertain boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.instagram_conversation_messages
  set status=case when p_uncertain then 'failed' else 'proposed' end,
      dispatch_started_at=null,
      approved_at=case when p_uncertain then approved_at else null end,
      approved_by_user_id=case when p_uncertain then approved_by_user_id else null end,
      last_error=left(coalesce(p_error,'dispatch_failed'),500)
  where id=p_message_id and status='dispatching';
  return case when found then p_message_id else null end;
end;
$function$;

revoke all on function public.assign_social_lead_round_robin(uuid,uuid),
  public.ingest_instagram_message_event(uuid),
  public.claim_social_processing_job(text,text[]),
  public.save_instagram_conversation_draft(uuid,text,text,text,text,text),
  public.panel_create_instagram_conversation_reply(uuid,uuid,uuid,text,text),
  public.panel_approve_instagram_conversation_reply(uuid,uuid,uuid),
  public.panel_manage_instagram_conversation(uuid,uuid,uuid,text,text),
  public.claim_instagram_conversation_message(uuid,text,integer),
  public.mark_instagram_conversation_message_sent(uuid,text),
  public.mark_instagram_conversation_message_error(uuid,text,boolean)
from public,anon,authenticated;

grant execute on function public.assign_social_lead_round_robin(uuid,uuid),
  public.ingest_instagram_message_event(uuid),
  public.claim_social_processing_job(text,text[]),
  public.save_instagram_conversation_draft(uuid,text,text,text,text,text),
  public.panel_create_instagram_conversation_reply(uuid,uuid,uuid,text,text),
  public.panel_approve_instagram_conversation_reply(uuid,uuid,uuid),
  public.panel_manage_instagram_conversation(uuid,uuid,uuid,text,text),
  public.claim_instagram_conversation_message(uuid,text,integer),
  public.mark_instagram_conversation_message_sent(uuid,text),
  public.mark_instagram_conversation_message_error(uuid,text,boolean)
to service_role;

comment on table public.instagram_conversations is
  'Inbox conversacional do Instagram. A janela de resposta nasce apenas de mensagem inbound real.';
comment on table public.instagram_conversation_messages is
  'Mensagens inbound e outbox aprovada. Nenhum rascunho é enviado sem status approved.';
comment on table public.social_contact_preferences is
  'Preferências e bloqueio de contato aplicados antes de qualquer dispatch.';
