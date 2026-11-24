-- Correções detectadas pelo plpgsql_check remoto depois da criação do
-- Inbox. Mantém a migração incremental e torna os nomes de coluna inequívocos.

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
    select m.id into v_message from public.instagram_conversation_messages m
    where m.idempotency_key = 'instagram-message:' || v_message_id;
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
  select m.id into v_message from public.instagram_conversation_messages m
  where m.source_processing_job_id=v_job.id limit 1;
  if found then
    return query select m.id,m.conversation_id,m.status,true
    from public.instagram_conversation_messages m where m.id=v_message;
    return;
  end if;
  select e.* into v_event from public.webhook_events e
  where e.id=v_job.webhook_event_id and e.organization_id=v_job.organization_id;
  if not found or v_event.event_type <> 'messages' then
    raise exception 'message_event_required' using errcode='22023';
  end if;
  select m.* into v_inbound from public.instagram_conversation_messages m
  where m.webhook_event_id=v_event.id and m.direction='inbound';
  if not found then raise exception 'inbound_message_not_found' using errcode='P0002'; end if;
  select c.* into v_conversation from public.instagram_conversations c
  where c.id=v_inbound.conversation_id and c.organization_id=v_job.organization_id for update;
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

-- A versão já aplicada usa clock_timestamp() nos indicadores; declarar
-- VOLATILE evita uma promessa incorreta ao planejador. Em instalações novas,
-- a função usa now(), mas VOLATILE continua segura para o endpoint de leitura.
alter function public.panel_social_operations_summary(uuid,uuid) volatile;

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

