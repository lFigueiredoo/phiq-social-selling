-- APIs service-only para Inbox, indicadores, catálogo, alertas e direitos de
-- privacidade. As funções panel_* exigem membership ativa no próprio banco.

create table public.social_suppression_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  instagram_account_id uuid not null,
  identity_hash text not null check (identity_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, instagram_account_id, identity_hash),
  foreign key (instagram_account_id, organization_id)
    references public.instagram_accounts(id, organization_id),
  foreign key (organization_id, created_by)
    references public.organization_members(organization_id, user_id)
);

alter table public.social_suppression_identities enable row level security;
revoke all on public.social_suppression_identities from public,anon,authenticated,service_role;
grant select,insert on public.social_suppression_identities to service_role;

create or replace function public.social_identity_hash(p_external_user_id text)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(btrim(p_external_user_id),'UTF8'),'sha256'),'hex')
$function$;

create or replace function public.is_social_identity_suppressed(
  p_organization_id uuid,
  p_instagram_account_id uuid,
  p_external_user_id text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select exists(
    select 1 from public.social_suppression_identities s
    where s.organization_id=p_organization_id
      and s.instagram_account_id=p_instagram_account_id
      and s.identity_hash=public.social_identity_hash(p_external_user_id)
  )
$function$;

create or replace function public.panel_social_inbox(
  p_user_id uuid,
  p_organization_id uuid,
  p_status text default null,
  p_owner uuid default null,
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if p_limit not between 1 and 100 or p_offset<0 then
    raise exception 'invalid_pagination' using errcode='22023';
  end if;
  with filtered as (
    select c.*,coalesce(sc.username,c.username) as display_username,
      l.route_type,l.lead_score,l.status as lead_status,l.vertical_stage,
      public.panel_social_owner_email(c.owner_user_id) as owner_email,
      (select m.message_text from public.instagram_conversation_messages m
       where m.conversation_id=c.id order by m.created_at desc,m.id desc limit 1) as latest_message,
      (select m.direction from public.instagram_conversation_messages m
       where m.conversation_id=c.id order by m.created_at desc,m.id desc limit 1) as latest_direction
    from public.instagram_conversations c
    join public.social_contacts sc on sc.id=c.contact_id
    left join public.social_leads l on l.id=c.lead_id
    where c.organization_id=p_organization_id
      and (p_status is null or c.status=p_status)
      and (p_owner is null or c.owner_user_id=p_owner)
      and (nullif(btrim(p_search),'') is null
        or coalesce(sc.username,'') ilike '%'||btrim(p_search)||'%'
        or c.external_user_id ilike '%'||btrim(p_search)||'%')
  ), page as (
    select * from filtered
    order by case priority when 'urgent' then 4 when 'high' then 3
      when 'normal' then 2 else 1 end desc,
      unread_count desc,last_message_at desc,id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total',(select count(*) from filtered),
    'limit',p_limit,'offset',p_offset,
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'contact_id',p.contact_id,'lead_id',p.lead_id,
      'username',p.display_username,'external_user_id',p.external_user_id,
      'status',p.status,'priority',p.priority,'owner_user_id',p.owner_user_id,
      'owner_email',p.owner_email,'unread_count',p.unread_count,
      'last_message_at',p.last_message_at,'last_inbound_at',p.last_inbound_at,
      'reply_window_until',p.reply_window_until,'sla_due_at',p.sla_due_at,
      'opted_out',p.opted_out,'route_type',p.route_type,'lead_score',p.lead_score,
      'lead_status',p.lead_status,'vertical_stage',p.vertical_stage,
      'latest_message',left(coalesce(p.latest_message,''),240),
      'latest_direction',p.latest_direction
    ) order by case p.priority when 'urgent' then 4 when 'high' then 3
      when 'normal' then 2 else 1 end desc,p.unread_count desc,p.last_message_at desc)
      from page p),
      '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.panel_social_conversation_detail(
  p_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if not exists(select 1 from public.instagram_conversations
    where id=p_conversation_id and organization_id=p_organization_id) then
    raise exception 'conversation_not_found' using errcode='P0002';
  end if;
  select jsonb_build_object(
    'conversation',jsonb_build_object(
      'id',c.id,'contact_id',c.contact_id,'lead_id',c.lead_id,
      'username',coalesce(sc.username,c.username),'external_user_id',c.external_user_id,
      'status',c.status,'priority',c.priority,'owner_user_id',c.owner_user_id,
      'owner_email',public.panel_social_owner_email(c.owner_user_id),
      'unread_count',c.unread_count,'last_message_at',c.last_message_at,
      'last_inbound_at',c.last_inbound_at,'last_outbound_at',c.last_outbound_at,
      'reply_window_until',c.reply_window_until,'sla_due_at',c.sla_due_at,
      'opted_out',c.opted_out,'route_type',l.route_type,'lead_score',l.lead_score,
      'lead_status',l.status,'vertical_stage',l.vertical_stage
    ),
    'messages',coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'direction',m.direction,'status',m.status,
      'message_text',m.message_text,'provider_message_id',m.provider_message_id,
      'model_name',m.model_name,'prompt_version',m.prompt_version,
      'analysis_summary',m.analysis_summary,'created_by_user_id',m.created_by_user_id,
      'approved_by_user_id',m.approved_by_user_id,'approved_at',m.approved_at,
      'sent_at',m.sent_at,'eligible_until',m.eligible_until,'last_error',m.last_error,
      'created_at',m.created_at
    ) order by m.created_at,m.id) from public.instagram_conversation_messages m
      where m.conversation_id=c.id),'[]'::jsonb),
    'tasks',coalesce((select jsonb_agg(jsonb_build_object(
      'id',t.id,'task_type',t.task_type,'status',t.status,'title',t.title,
      'due_at',t.due_at,'assignee_user_id',t.assignee_user_id
    ) order by t.due_at) from public.social_followup_tasks t
      where t.conversation_id=c.id and t.status='open'),'[]'::jsonb),
    'offers',coalesce((select jsonb_agg(jsonb_build_object(
      'id',o.id,'route_type',o.route_type,'offer_kind',o.offer_kind,'name',o.name,
      'summary',o.summary,'audience',o.audience,'approved_claims',o.approved_claims,
      'price_text',o.price_text,'public_url',o.public_url
    ) order by o.sort_order,o.name) from public.social_catalog_offers o
      where o.organization_id=c.organization_id and o.active
        and (o.route_type is null or o.route_type=l.route_type)),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(jsonb_build_object(
      'user_id',m.user_id,'role',m.role,'email',public.panel_social_owner_email(m.user_id)
    ) order by public.panel_social_owner_email(m.user_id))
      from public.organization_members m where m.organization_id=c.organization_id
        and m.status='active'),'[]'::jsonb)
  ) into v_result
  from public.instagram_conversations c
  join public.social_contacts sc on sc.id=c.contact_id
  left join public.social_leads l on l.id=c.lead_id
  where c.id=p_conversation_id and c.organization_id=p_organization_id;
  return v_result;
end;
$function$;

create or replace function public.panel_social_operations_summary(
  p_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  select jsonb_build_object(
    'metrics',jsonb_build_object(
      'open_conversations',(select count(*) from public.instagram_conversations
        where organization_id=p_organization_id and status in ('open','pending')),
      'unread_conversations',(select count(*) from public.instagram_conversations
        where organization_id=p_organization_id and unread_count>0),
      'sla_overdue',(select count(*) from public.instagram_conversations
        where organization_id=p_organization_id and status in ('open','pending')
          and sla_due_at<now()),
      'inbound_24h',(select count(*) from public.instagram_conversation_messages
        where organization_id=p_organization_id and direction='inbound'
          and created_at>now()-interval '24 hours'),
      'outbound_sent_24h',(select count(*) from public.instagram_conversation_messages
        where organization_id=p_organization_id and direction='outbound' and status='sent'
          and sent_at>now()-interval '24 hours'),
      'private_replies_sent_24h',(select count(*) from public.outbound_actions
        where organization_id=p_organization_id and action_type='private_reply' and status='sent'
          and sent_at>now()-interval '24 hours'),
      'won_leads',(select count(*) from public.social_leads
        where organization_id=p_organization_id and status='won'),
      'active_leads',(select count(*) from public.social_leads
        where organization_id=p_organization_id and status in ('active','awaiting_signal')),
      'model_acceptance_rate',coalesce((select round(100.0*count(*) filter(where rating='accepted')/
        nullif(count(*),0),1) from public.social_model_feedback
        where organization_id=p_organization_id),0)
    ),
    'settings',(select to_jsonb(s)-'organization_id'-'updated_by' from public.social_selling_settings s
      where s.organization_id=p_organization_id),
    'alerts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',a.id,'alert_type',a.alert_type,'severity',a.severity,'status',a.status,
      'title',a.title,'details',a.details,'first_seen_at',a.first_seen_at,
      'last_seen_at',a.last_seen_at
    ) order by case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end desc,
      a.last_seen_at desc) from public.social_operational_alerts a
      where a.organization_id=p_organization_id and a.status<>'resolved'),'[]'::jsonb),
    'offers',coalesce((select jsonb_agg(to_jsonb(o) order by o.sort_order,o.name)
      from public.social_catalog_offers o where o.organization_id=p_organization_id),'[]'::jsonb),
    'feedback',jsonb_build_object(
      'total',(select count(*) from public.social_model_feedback where organization_id=p_organization_id),
      'edited',(select count(*) from public.social_model_feedback where organization_id=p_organization_id and rating='edited'),
      'rejected',(select count(*) from public.social_model_feedback where organization_id=p_organization_id and rating in ('rejected','unsafe'))
    )
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.panel_update_social_selling_settings(
  p_user_id uuid,
  p_organization_id uuid,
  p_response_sla_minutes integer,
  p_retention_days integer,
  p_retention_enabled boolean,
  p_auto_assign_enabled boolean,
  p_auto_suggest_enabled boolean,
  p_conversation_daily_limit integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  insert into public.social_selling_settings(
    organization_id,response_sla_minutes,retention_days,retention_enabled,
    auto_assign_enabled,auto_suggest_enabled,conversation_daily_limit,updated_by
  ) values (
    p_organization_id,p_response_sla_minutes,p_retention_days,p_retention_enabled,
    p_auto_assign_enabled,p_auto_suggest_enabled,p_conversation_daily_limit,p_user_id
  ) on conflict (organization_id) do update set
    response_sla_minutes=excluded.response_sla_minutes,
    retention_days=excluded.retention_days,
    retention_enabled=excluded.retention_enabled,
    auto_assign_enabled=excluded.auto_assign_enabled,
    auto_suggest_enabled=excluded.auto_suggest_enabled,
    conversation_daily_limit=excluded.conversation_daily_limit,
    updated_by=p_user_id,updated_at=clock_timestamp();
  return p_organization_id;
end;
$function$;

create or replace function public.panel_upsert_social_catalog_offer(
  p_user_id uuid,
  p_organization_id uuid,
  p_offer_id uuid,
  p_route_type text,
  p_offer_kind text,
  p_name text,
  p_summary text,
  p_audience text,
  p_approved_claims jsonb,
  p_prohibited_claims jsonb,
  p_price_text text,
  p_public_url text,
  p_active boolean
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare v_id uuid := coalesce(p_offer_id,gen_random_uuid());
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  if p_route_type is not null and p_route_type not in ('franchise','q3','hotmart','nuy')
     or p_offer_kind not in ('franchise','course','product','service')
     or nullif(btrim(p_name),'') is null then
    raise exception 'invalid_offer' using errcode='22023';
  end if;
  insert into public.social_catalog_offers(
    id,organization_id,route_type,offer_kind,name,summary,audience,
    approved_claims,prohibited_claims,price_text,public_url,active
  ) values (
    v_id,p_organization_id,p_route_type,p_offer_kind,btrim(p_name),
    left(coalesce(p_summary,''),1000),left(coalesce(p_audience,''),500),
    coalesce(p_approved_claims,'[]'::jsonb),coalesce(p_prohibited_claims,'[]'::jsonb),
    nullif(btrim(p_price_text),''),nullif(btrim(p_public_url),''),p_active
  ) on conflict (id) do update set
    route_type=excluded.route_type,offer_kind=excluded.offer_kind,name=excluded.name,
    summary=excluded.summary,audience=excluded.audience,
    approved_claims=excluded.approved_claims,prohibited_claims=excluded.prohibited_claims,
    price_text=excluded.price_text,public_url=excluded.public_url,active=excluded.active,
    updated_at=clock_timestamp()
  where public.social_catalog_offers.organization_id=p_organization_id;
  return v_id;
end;
$function$;

create or replace function public.panel_acknowledge_social_alert(
  p_user_id uuid,p_organization_id uuid,p_alert_id uuid,p_resolve boolean default false
)
returns uuid language plpgsql security invoker set search_path = '' as $function$
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  update public.social_operational_alerts set
    status=case when p_resolve then 'resolved' else 'acknowledged' end,
    acknowledged_by=p_user_id,acknowledged_at=clock_timestamp(),
    resolved_at=case when p_resolve then clock_timestamp() else null end
  where id=p_alert_id and organization_id=p_organization_id;
  if not found then raise exception 'alert_not_found' using errcode='P0002'; end if;
  return p_alert_id;
end;
$function$;

create or replace function public.panel_submit_social_model_feedback(
  p_user_id uuid,p_organization_id uuid,p_message_id uuid,p_rating text,
  p_tags jsonb default '[]'::jsonb,p_corrected_text text default null,p_notes text default null
)
returns uuid language plpgsql security invoker set search_path = '' as $function$
declare v_id uuid;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'reviewer');
  if p_rating not in ('accepted','edited','rejected','unsafe') then
    raise exception 'invalid_rating' using errcode='22023'; end if;
  insert into public.social_model_feedback(
    organization_id,conversation_message_id,reviewer_user_id,rating,tags,corrected_text,notes
  ) values (
    p_organization_id,p_message_id,p_user_id,p_rating,coalesce(p_tags,'[]'::jsonb),
    nullif(btrim(p_corrected_text),''),nullif(btrim(p_notes),'')
  ) on conflict (conversation_message_id,reviewer_user_id) do update set
    rating=excluded.rating,tags=excluded.tags,corrected_text=excluded.corrected_text,
    notes=excluded.notes
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.panel_request_social_contact_erasure(
  p_user_id uuid,p_organization_id uuid,p_contact_id uuid,p_reason text
)
returns uuid language plpgsql security invoker set search_path = '' as $function$
declare v_contact public.social_contacts%rowtype; v_hash text; v_placeholder text;
begin
  perform public.panel_assert_membership(p_user_id,p_organization_id,'admin');
  if nullif(btrim(p_reason),'') is null then raise exception 'reason_required' using errcode='22023'; end if;
  select * into v_contact from public.social_contacts
  where id=p_contact_id and organization_id=p_organization_id for update;
  if not found then raise exception 'contact_not_found' using errcode='P0002'; end if;
  if v_contact.external_user_id is not null then
    v_hash:=public.social_identity_hash(v_contact.external_user_id);
    insert into public.social_suppression_identities(
      organization_id,instagram_account_id,identity_hash,reason,created_by
    ) values (p_organization_id,v_contact.instagram_account_id,v_hash,left(btrim(p_reason),500),p_user_id)
    on conflict do nothing;
    v_placeholder:='erased:'||left(v_hash,24);
  else
    v_placeholder:='erased:'||replace(p_contact_id::text,'-','');
  end if;
  update public.instagram_conversation_messages m set message_text='[conteúdo anonimizado]',
    analysis_summary=null where m.organization_id=p_organization_id
      and m.conversation_id in (select id from public.instagram_conversations where contact_id=p_contact_id);
  update public.instagram_conversations set external_user_id=v_placeholder,username=null,
    opted_out=true,opted_out_at=coalesce(opted_out_at,clock_timestamp()),status='blocked'
    where organization_id=p_organization_id and contact_id=p_contact_id;
  update public.social_contacts set external_user_id=v_placeholder,username=null,display_name=null,
    profile_url=null where id=p_contact_id;
  update public.social_engagements set metadata=jsonb_build_object('redacted',true)
    where organization_id=p_organization_id and contact_id=p_contact_id;
  insert into public.social_contact_preferences(
    organization_id,contact_id,channel_status,do_not_contact,reason,source,opted_out_at
  ) values (p_organization_id,p_contact_id,'blocked',true,left(btrim(p_reason),500),
    'operator',clock_timestamp()) on conflict (organization_id,contact_id) do update set
    channel_status='blocked',do_not_contact=true,reason=excluded.reason,
    source='operator',opted_out_at=excluded.opted_out_at;
  insert into public.audit_logs(organization_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
  values(p_organization_id,'user',p_user_id::text,'social_contact.erased','social_contact',
    p_contact_id::text,jsonb_build_object('reason',left(btrim(p_reason),500)));
  return p_contact_id;
end;
$function$;

create or replace function public.run_social_retention(p_organization_id uuid default null)
returns table(organization_id uuid,redacted_messages bigint,redacted_webhooks bigint)
language plpgsql security invoker set search_path = '' as $function$
declare v_setting public.social_selling_settings%rowtype; v_messages bigint; v_webhooks bigint;
begin
  for v_setting in select * from public.social_selling_settings s
    where s.retention_enabled and (p_organization_id is null or s.organization_id=p_organization_id)
  loop
    update public.instagram_conversation_messages as m
      set message_text='[conteúdo removido por retenção]',analysis_summary=null
      where m.organization_id=v_setting.organization_id
      and m.created_at<clock_timestamp()-make_interval(days=>v_setting.retention_days)
      and m.status in ('received','sent','failed','cancelled','blocked')
      and m.message_text<>'[conteúdo removido por retenção]';
    get diagnostics v_messages=row_count;
    update public.webhook_events as w set payload='{}'::jsonb
      where w.organization_id=v_setting.organization_id
      and w.received_at<clock_timestamp()-make_interval(days=>v_setting.retention_days)
      and w.status in ('processed','failed','dead_letter') and w.payload<>'{}'::jsonb;
    get diagnostics v_webhooks=row_count;
    organization_id:=v_setting.organization_id;
    redacted_messages:=v_messages;
    redacted_webhooks:=v_webhooks;
    return next;
  end loop;
end;
$function$;

revoke all on function public.social_identity_hash(text),
  public.is_social_identity_suppressed(uuid,uuid,text),
  public.panel_social_inbox(uuid,uuid,text,uuid,text,integer,integer),
  public.panel_social_conversation_detail(uuid,uuid,uuid),
  public.panel_social_operations_summary(uuid,uuid),
  public.panel_update_social_selling_settings(uuid,uuid,integer,integer,boolean,boolean,boolean,integer),
  public.panel_upsert_social_catalog_offer(uuid,uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,text,boolean),
  public.panel_acknowledge_social_alert(uuid,uuid,uuid,boolean),
  public.panel_submit_social_model_feedback(uuid,uuid,uuid,text,jsonb,text,text),
  public.panel_request_social_contact_erasure(uuid,uuid,uuid,text),
  public.run_social_retention(uuid)
from public,anon,authenticated;

grant execute on function public.social_identity_hash(text),
  public.is_social_identity_suppressed(uuid,uuid,text),
  public.panel_social_inbox(uuid,uuid,text,uuid,text,integer,integer),
  public.panel_social_conversation_detail(uuid,uuid,uuid),
  public.panel_social_operations_summary(uuid,uuid),
  public.panel_update_social_selling_settings(uuid,uuid,integer,integer,boolean,boolean,boolean,integer),
  public.panel_upsert_social_catalog_offer(uuid,uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,text,boolean),
  public.panel_acknowledge_social_alert(uuid,uuid,uuid,boolean),
  public.panel_submit_social_model_feedback(uuid,uuid,uuid,text,jsonb,text,text),
  public.panel_request_social_contact_erasure(uuid,uuid,uuid,text),
  public.run_social_retention(uuid)
to service_role;
