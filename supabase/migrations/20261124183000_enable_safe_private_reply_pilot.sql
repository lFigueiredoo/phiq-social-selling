-- Piloto controlado de Private Reply.
--
-- Regras que permanecem no banco, independentemente do n8n/frontend:
--   * somente comentário realtime (nunca histórico ou Live);
--   * intenção comercial explícita, potencial médio/alto e score >= 70;
--   * uma mensagem com até 1.000 bytes, sem aprovação automática;
--   * política Meta elegível e ao menos 10 minutos restantes na janela;
--   * no máximo 5 envios por janela móvel de 24 horas e por conta.

create or replace function public.save_instagram_response_draft(
  p_job_id uuid,
  p_worker_id text,
  p_message_text text,
  p_sentiment text,
  p_analysis_summary text,
  p_model_name text,
  p_prompt_version text
)
returns table(
  outbound_action_id uuid,
  outbound_status text,
  action_type text,
  source text,
  already_exists boolean
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_job public.processing_jobs%rowtype;
  v_event public.webhook_events%rowtype;
  v_engagement public.social_engagements%rowtype;
  v_classification public.social_classifications%rowtype;
  v_analysis_id uuid;
  v_decision_id uuid;
  v_action public.outbound_actions%rowtype;
  v_source text;
  v_legacy_intent text;
  v_potential text;
  v_score integer;
  v_sensitive boolean;
  v_action_type text;
  v_decision text;
  v_target_user_id text;
  v_target_username text;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id_required' using errcode = '22023';
  end if;
  if p_message_text is null or btrim(p_message_text) = ''
     or length(btrim(p_message_text)) > 500
     or octet_length(btrim(p_message_text)) > 1000
     or p_message_text ~* '(https?://|www[.]|```)' then
    raise exception 'invalid_draft_message' using errcode = '22023';
  end if;
  if p_sentiment not in ('positive','neutral','negative','mixed','unknown') then
    raise exception 'invalid_draft_sentiment' using errcode = '22023';
  end if;
  if p_analysis_summary is null or btrim(p_analysis_summary) = ''
     or length(btrim(p_analysis_summary)) > 240 then
    raise exception 'invalid_draft_summary' using errcode = '22023';
  end if;
  if p_model_name is null or btrim(p_model_name) = ''
     or p_prompt_version is null or btrim(p_prompt_version) = '' then
    raise exception 'draft_model_metadata_required' using errcode = '22023';
  end if;

  select pj.* into v_job
  from public.processing_jobs as pj
  where pj.id = p_job_id
    and pj.status = 'processing'
    and pj.locked_by = p_worker_id
  for update;

  if not found then return; end if;

  select oa.* into v_action
  from public.outbound_actions as oa
  where oa.processing_job_id = v_job.id
  order by oa.created_at, oa.id
  limit 1;

  if found then
    select case when we.payload ->> 'source' = 'historical_backfill'
      then 'historical_backfill' else 'realtime' end
    into v_source
    from public.webhook_events as we
    where we.id = v_job.webhook_event_id;

    return query select
      v_action.id,
      v_action.status,
      v_action.action_type,
      coalesce(v_source, 'realtime'),
      true;
    return;
  end if;

  select we.* into v_event
  from public.webhook_events as we
  where we.id = v_job.webhook_event_id
    and we.organization_id = v_job.organization_id;
  if not found then
    raise exception 'webhook_event_not_found' using errcode = 'P0002';
  end if;
  if v_event.event_type not in ('comments','live_comments')
     or nullif(btrim(coalesce(v_event.external_object_id, '')), '') is null then
    raise exception 'unsupported_draft_event' using errcode = '22023';
  end if;

  select se.* into v_engagement
  from public.social_engagements as se
  where se.webhook_event_id = v_event.id
    and se.organization_id = v_job.organization_id;
  if not found or v_engagement.classification_status <> 'completed' then
    raise exception 'classification_not_completed' using errcode = '22023';
  end if;

  select sc.* into v_classification
  from public.social_classifications as sc
  where sc.engagement_id = v_engagement.id
    and sc.organization_id = v_job.organization_id;
  if not found then
    raise exception 'classification_not_found' using errcode = 'P0002';
  end if;

  v_source := case
    when v_event.payload ->> 'source' = 'historical_backfill'
      or v_engagement.source = 'historical_backfill'
    then 'historical_backfill'
    else 'realtime'
  end;
  v_legacy_intent := case v_classification.classification ->> 'intent'
    when 'franchise_interest' then 'purchase_interest'
    when 'q3_interest' then 'purchase_interest'
    when 'course_interest' then 'purchase_interest'
    when 'commercial_interest' then 'purchase_interest'
    when 'product_interest' then 'product_interest'
    when 'support' then 'support'
    when 'complaint' then 'complaint'
    when 'engagement' then 'engagement'
    else 'other'
  end;
  v_potential := case
    when v_classification.classification ->> 'commercial_potential'
      in ('low','medium','high','unknown')
    then v_classification.classification ->> 'commercial_potential'
    else 'unknown'
  end;
  begin
    v_score := greatest(0, least(100,
      (v_classification.classification ->> 'lead_score')::integer));
  exception when others then
    v_score := 0;
  end;
  v_sensitive := v_legacy_intent in ('support','complaint')
    or p_sentiment in ('negative','mixed');

  v_action_type := case
    when v_source = 'realtime'
      and v_event.event_type = 'comments'
      and v_classification.classification ->> 'intent' in (
        'franchise_interest',
        'q3_interest',
        'course_interest',
        'product_interest',
        'commercial_interest'
      )
      and v_potential in ('medium','high')
      and v_score >= 70
      and coalesce(v_classification.classification ->> 'needs_more_signal', 'true') = 'false'
    then 'private_reply'
    else 'public_reply'
  end;
  v_decision := case when v_action_type = 'private_reply'
    then 'private_reply_candidate' else 'public_reply' end;

  insert into public.comment_analyses as ca (
    organization_id, webhook_event_id, processing_job_id, sentiment, intent,
    commercial_potential, lead_score, requires_human_review,
    recommended_action, suggested_reply, analysis_summary, model_provider,
    model_name, prompt_version
  ) values (
    v_job.organization_id, v_event.id, v_job.id, p_sentiment, v_legacy_intent,
    v_potential, v_score, v_sensitive, v_action_type, btrim(p_message_text),
    btrim(p_analysis_summary), 'google', btrim(p_model_name),
    btrim(p_prompt_version)
  )
  on conflict (processing_job_id) do update
  set sentiment = excluded.sentiment,
      intent = excluded.intent,
      commercial_potential = excluded.commercial_potential,
      lead_score = excluded.lead_score,
      requires_human_review = excluded.requires_human_review,
      recommended_action = excluded.recommended_action,
      suggested_reply = excluded.suggested_reply,
      analysis_summary = excluded.analysis_summary,
      model_provider = excluded.model_provider,
      model_name = excluded.model_name,
      prompt_version = excluded.prompt_version,
      updated_at = clock_timestamp()
  returning ca.id into v_analysis_id;

  insert into public.decision_records as dr (
    organization_id, analysis_id, processing_job_id, webhook_event_id,
    decision, reason, rule_version
  ) values (
    v_job.organization_id, v_analysis_id, v_job.id, v_event.id, v_decision,
    case when v_action_type = 'private_reply'
      then 'Explicit realtime commercial interest met the controlled Private Reply pilot criteria; Meta policy and human approval remain mandatory.'
      else 'Gemini generated a public-reply draft; explicit human approval remains mandatory.'
    end,
    'ig-human-approved-draft-v2'
  )
  on conflict on constraint decision_records_analysis_rule_unique do update
  set decision = excluded.decision,
      reason = excluded.reason,
      updated_at = clock_timestamp()
  returning dr.id into v_decision_id;

  v_target_user_id := v_event.payload #>> '{entry,0,changes,0,value,from,id}';
  v_target_username := v_event.payload #>> '{entry,0,changes,0,value,from,username}';

  insert into public.outbound_actions as oa (
    organization_id, decision_record_id, analysis_id, processing_job_id,
    webhook_event_id, instagram_account_id, action_type, status,
    policy_check_status, requires_human_review, target_comment_id,
    target_user_id, target_username, message_text, idempotency_key
  ) values (
    v_job.organization_id, v_decision_id, v_analysis_id, v_job.id, v_event.id,
    v_event.instagram_account_id, v_action_type, 'proposed',
    case when v_action_type = 'private_reply' then 'not_checked' else 'not_required' end,
    false, v_event.external_object_id, v_target_user_id, v_target_username,
    btrim(p_message_text),
    'response-draft:' || v_job.id::text || ':' || replace(v_action_type, '_', '-')
  )
  on conflict (idempotency_key) do update
  set message_text = case
        when oa.status = 'proposed' then excluded.message_text
        else oa.message_text
      end,
      updated_at = clock_timestamp()
  returning oa.* into v_action;

  return query select
    v_action.id, v_action.status, v_action.action_type, v_source, false;
end;
$function$;

comment on function public.save_instagram_response_draft(
  uuid, text, text, text, text, text, text
) is
  'Persiste rascunho Gemini proposto. Private Reply exige sinal comercial realtime forte, checagem Meta e aprovação humana.';

create or replace function public.enforce_private_reply_pilot_approval()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_event public.webhook_events%rowtype;
  v_analysis public.comment_analyses%rowtype;
begin
  if new.action_type <> 'private_reply'
     or new.status <> 'approved'
     or old.status = 'approved' then
    return new;
  end if;

  select we.* into v_event
  from public.webhook_events as we
  where we.id = new.webhook_event_id
    and we.organization_id = new.organization_id;
  select ca.* into v_analysis
  from public.comment_analyses as ca
  where ca.id = new.analysis_id
    and ca.organization_id = new.organization_id;

  if v_event.id is null
     or v_event.event_type <> 'comments'
     or v_event.payload ->> 'source' = 'historical_backfill' then
    raise exception 'private_reply_realtime_comment_required' using errcode = 'P0001';
  end if;
  if v_analysis.id is null
     or v_analysis.intent not in ('purchase_interest','product_interest')
     or v_analysis.commercial_potential not in ('medium','high')
     or v_analysis.lead_score < 70
     or v_analysis.sentiment in ('negative','mixed')
     or v_analysis.requires_human_review then
    raise exception 'private_reply_commercial_criteria_not_met' using errcode = 'P0001';
  end if;
  if octet_length(new.message_text) > 1000 then
    raise exception 'private_reply_message_exceeds_1000_bytes' using errcode = 'P0001';
  end if;
  if new.policy_check_status <> 'eligible'
     or new.eligible_until is null
     or new.eligible_until <= clock_timestamp() + interval '10 minutes' then
    raise exception 'private_reply_policy_window_not_safe' using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_private_reply_pilot_approval()
from public, anon, authenticated;

drop trigger if exists enforce_private_reply_pilot_approval
on public.outbound_actions;

create trigger enforce_private_reply_pilot_approval
before update of status
on public.outbound_actions
for each row execute function public.enforce_private_reply_pilot_approval();

drop function if exists public.claim_outbound_action_for_dispatch(uuid, text);

create function public.claim_outbound_action_for_dispatch(
  p_action_id uuid,
  p_dispatcher text,
  p_private_reply_daily_limit integer default 5
)
returns table(
  outbound_action_id uuid,
  action_type text,
  target_comment_id text,
  target_user_id text,
  target_username text,
  message_text text,
  instagram_account_external_id text,
  idempotency_key text
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
  v_event public.webhook_events%rowtype;
  v_analysis public.comment_analyses%rowtype;
  v_recent_private_count integer;
begin
  if p_dispatcher is null or btrim(p_dispatcher) = '' then
    raise exception 'dispatcher is required';
  end if;
  if p_private_reply_daily_limit < 1 or p_private_reply_daily_limit > 20 then
    raise exception 'invalid private reply daily limit';
  end if;

  select oa.* into v_action
  from public.outbound_actions as oa
  where oa.id = p_action_id
    and oa.status = 'approved'
    and oa.sent_at is null
  for update skip locked;

  if not found then return; end if;

  if v_action.action_type = 'private_reply' then
    select we.* into v_event
    from public.webhook_events as we
    where we.id = v_action.webhook_event_id
      and we.organization_id = v_action.organization_id;
    select ca.* into v_analysis
    from public.comment_analyses as ca
    where ca.id = v_action.analysis_id
      and ca.organization_id = v_action.organization_id;

    if v_event.id is null
       or v_event.event_type <> 'comments'
       or v_event.payload ->> 'source' = 'historical_backfill'
       or v_analysis.id is null
       or v_analysis.intent not in ('purchase_interest','product_interest')
       or v_analysis.commercial_potential not in ('medium','high')
       or v_analysis.lead_score < 70
       or v_analysis.sentiment in ('negative','mixed')
       or v_analysis.requires_human_review
       or octet_length(v_action.message_text) > 1000 then
      update public.outbound_actions
      set status = 'blocked',
          last_error = 'private_reply_pilot_constraints_failed',
          updated_at = clock_timestamp()
      where id = p_action_id;
      return;
    end if;
    if v_action.policy_check_status <> 'eligible'
       or v_action.eligible_until is null
       or v_action.eligible_until <= clock_timestamp() + interval '10 minutes' then
      update public.outbound_actions
      set status = 'blocked',
          last_error = 'private_reply_window_expired_before_dispatch',
          updated_at = clock_timestamp()
      where id = p_action_id;
      return;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_action.instagram_account_id::text || ':private_reply_pilot',
        0
      )
    );

    select count(*)::integer into v_recent_private_count
    from public.outbound_actions as oa
    where oa.instagram_account_id = v_action.instagram_account_id
      and oa.action_type = 'private_reply'
      and oa.id <> v_action.id
      and (
        (oa.sent_at is not null
          and oa.sent_at > clock_timestamp() - interval '24 hours')
        or
        (oa.status = 'dispatching'
          and oa.dispatch_started_at > clock_timestamp() - interval '15 minutes')
      );

    if v_recent_private_count >= p_private_reply_daily_limit then
      update public.outbound_actions
      set last_error = 'private_reply_pilot_daily_limit_reached',
          updated_at = clock_timestamp()
      where id = p_action_id;
      return;
    end if;
  elsif v_action.action_type = 'public_reply' then
    if v_action.policy_check_status not in ('not_required', 'eligible') then
      raise exception 'public reply policy state is not dispatchable';
    end if;
  else
    raise exception 'unsupported action type';
  end if;

  update public.outbound_actions as oa
  set status = 'dispatching',
      dispatch_started_at = clock_timestamp(),
      last_error = null,
      updated_at = clock_timestamp()
  where oa.id = p_action_id;

  return query
  select oa.id, oa.action_type, oa.target_comment_id, oa.target_user_id,
    oa.target_username, oa.message_text, ia.external_id, oa.idempotency_key
  from public.outbound_actions as oa
  left join public.instagram_accounts as ia on ia.id = oa.instagram_account_id
  where oa.id = p_action_id;
end;
$function$;

revoke all on function public.claim_outbound_action_for_dispatch(uuid, text, integer)
from public, anon, authenticated;
grant execute on function public.claim_outbound_action_for_dispatch(uuid, text, integer)
to service_role;

