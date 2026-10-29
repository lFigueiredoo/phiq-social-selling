-- Persiste um rascunho Gemini como resposta pública proposta. O modelo fornece
-- somente texto/sentimento; canal, status, tenant, alvo e política são definidos
-- pelo banco. Nenhuma execução desta função aprova ou envia a resposta.

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
  v_target_user_id text;
  v_target_username text;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id_required' using errcode = '22023';
  end if;
  if p_message_text is null or btrim(p_message_text) = ''
     or length(btrim(p_message_text)) > 500
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

  insert into public.comment_analyses as ca (
    organization_id,
    webhook_event_id,
    processing_job_id,
    sentiment,
    intent,
    commercial_potential,
    lead_score,
    requires_human_review,
    recommended_action,
    suggested_reply,
    analysis_summary,
    model_provider,
    model_name,
    prompt_version
  ) values (
    v_job.organization_id,
    v_event.id,
    v_job.id,
    p_sentiment,
    v_legacy_intent,
    v_potential,
    v_score,
    v_sensitive,
    'public_reply',
    btrim(p_message_text),
    btrim(p_analysis_summary),
    'google',
    btrim(p_model_name),
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
    organization_id,
    analysis_id,
    processing_job_id,
    webhook_event_id,
    decision,
    reason,
    rule_version
  ) values (
    v_job.organization_id,
    v_analysis_id,
    v_job.id,
    v_event.id,
    'public_reply',
    'Gemini generated a public-reply draft; explicit human approval remains mandatory.',
    'ig-human-approved-draft-v1'
  )
  on conflict on constraint decision_records_analysis_rule_unique do update
  set decision = excluded.decision,
      reason = excluded.reason,
      updated_at = clock_timestamp()
  returning dr.id into v_decision_id;

  v_target_user_id := v_event.payload #>> '{entry,0,changes,0,value,from,id}';
  v_target_username := v_event.payload #>> '{entry,0,changes,0,value,from,username}';

  insert into public.outbound_actions as oa (
    organization_id,
    decision_record_id,
    analysis_id,
    processing_job_id,
    webhook_event_id,
    instagram_account_id,
    action_type,
    status,
    policy_check_status,
    requires_human_review,
    target_comment_id,
    target_user_id,
    target_username,
    message_text,
    idempotency_key
  ) values (
    v_job.organization_id,
    v_decision_id,
    v_analysis_id,
    v_job.id,
    v_event.id,
    v_event.instagram_account_id,
    'public_reply',
    'proposed',
    'not_required',
    false,
    v_event.external_object_id,
    v_target_user_id,
    v_target_username,
    btrim(p_message_text),
    'response-draft:' || v_job.id::text || ':public-reply'
  )
  on conflict (idempotency_key) do update
  set message_text = case
        when oa.status = 'proposed' then excluded.message_text
        else oa.message_text
      end,
      updated_at = clock_timestamp()
  returning oa.* into v_action;

  return query select
    v_action.id,
    v_action.status,
    v_action.action_type,
    v_source,
    false;
end;
$function$;

comment on function public.save_instagram_response_draft(
  uuid, text, text, text, text, text, text
) is
  'Persists a Gemini public-reply draft as proposed only; approval and dispatch remain separate.';

revoke all on function public.save_instagram_response_draft(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.save_instagram_response_draft(
  uuid, text, text, text, text, text, text
) to service_role;
