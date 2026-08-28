create or replace function public.decide_instagram_comment_action(
  p_job_id uuid,
  p_worker_id text,
  p_rule_version text default 'ig-decision-v2'
)
returns table(
  decision_record_id uuid,
  decision text,
  reason text,
  outbound_action_id uuid,
  outbound_status text,
  action_type text,
  policy_check_status text
)
language plpgsql
set search_path to ''
as $function$
declare
  v_job public.processing_jobs%rowtype;
  v_analysis public.comment_analyses%rowtype;
  v_event public.webhook_events%rowtype;
  v_decision text;
  v_reason text;
  v_decision_id uuid;
  v_outbound_id uuid;
  v_action_type text;
  v_policy_status text;
  v_target_user_id text;
  v_target_username text;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_rule_version is null or btrim(p_rule_version) = '' then
    raise exception 'rule_version is required';
  end if;

  select pj.* into v_job
  from public.processing_jobs as pj
  where pj.id = p_job_id
    and pj.status = 'processing'
    and pj.locked_by = p_worker_id
  for update;

  if not found then
    return;
  end if;

  select ca.* into v_analysis
  from public.comment_analyses as ca
  where ca.processing_job_id = v_job.id;

  if not found then
    raise exception 'analysis not found';
  end if;

  select we.* into v_event
  from public.webhook_events as we
  where we.id = v_job.webhook_event_id;

  if not found then
    raise exception 'webhook event not found';
  end if;

  if v_analysis.requires_human_review
     or v_analysis.sentiment in ('negative','mixed')
     or v_analysis.intent in ('complaint','support','partnership') then
    v_decision := 'human_review';
    v_reason := 'Conservative gate: review required by analysis, sentiment, or sensitive intent.';
  elsif v_analysis.intent = 'spam' then
    v_decision := 'none';
    v_reason := 'No outbound action for spam.';
  elsif v_analysis.intent in ('purchase_interest','product_interest')
        and v_analysis.commercial_potential in ('medium','high')
        and v_analysis.lead_score >= 60
        and v_analysis.suggested_reply is not null
        and btrim(v_analysis.suggested_reply) <> '' then

    if v_event.payload #>> '{source}' = 'historical_backfill' then
      v_decision := 'public_reply';
      v_reason := 'Historical backfill: commercial intent is routed to public reply; private reply is not attempted.';
    else
      v_decision := 'private_reply_candidate';
      v_reason := 'Deterministic commercial rule passed; Meta eligibility still must be checked before dispatch.';
    end if;
  elsif v_analysis.intent in ('engagement','question','other')
        and v_analysis.sentiment not in ('negative','mixed')
        and v_analysis.suggested_reply is not null
        and btrim(v_analysis.suggested_reply) <> '' then
    v_decision := 'public_reply';
    v_reason := 'Deterministic low-risk public interaction rule passed.';
  else
    v_decision := 'human_review';
    v_reason := 'Analysis did not match an approved deterministic auto-action rule.';
  end if;

  insert into public.decision_records as dr (
    organization_id, analysis_id, processing_job_id, webhook_event_id,
    decision, reason, rule_version
  ) values (
    v_analysis.organization_id, v_analysis.id, v_job.id, v_event.id,
    v_decision, v_reason, btrim(p_rule_version)
  )
  on conflict on constraint decision_records_analysis_rule_unique do update
  set decision = excluded.decision,
      reason = excluded.reason,
      updated_at = clock_timestamp()
  returning dr.id into v_decision_id;

  if v_decision in ('public_reply','private_reply_candidate') then
    v_action_type := case when v_decision = 'public_reply' then 'public_reply' else 'private_reply' end;
    v_policy_status := case when v_action_type = 'public_reply' then 'not_required' else 'not_checked' end;
    v_target_user_id := v_event.payload #>> '{entry,0,changes,0,value,from,id}';
    v_target_username := v_event.payload #>> '{entry,0,changes,0,value,from,username}';

    insert into public.outbound_actions as oa (
      organization_id, decision_record_id, analysis_id, processing_job_id, webhook_event_id,
      instagram_account_id, action_type, status, policy_check_status, requires_human_review,
      target_comment_id, target_user_id, target_username, message_text, idempotency_key
    ) values (
      v_analysis.organization_id, v_decision_id, v_analysis.id, v_job.id, v_event.id,
      v_event.instagram_account_id, v_action_type, 'proposed', v_policy_status, false,
      v_event.external_object_id, v_target_user_id, v_target_username, v_analysis.suggested_reply,
      'analysis:' || v_analysis.id::text || ':decision:' || v_decision_id::text || ':action:' || v_action_type
    )
    on conflict on constraint outbound_actions_decision_unique do update
    set message_text = case when oa.status = 'proposed' then excluded.message_text else oa.message_text end,
        target_user_id = coalesce(oa.target_user_id, excluded.target_user_id),
        target_username = coalesce(oa.target_username, excluded.target_username),
        updated_at = clock_timestamp()
    returning oa.id into v_outbound_id;
  end if;

  return query
  select
    dr.id,
    dr.decision,
    dr.reason,
    oa.id,
    oa.status,
    oa.action_type,
    oa.policy_check_status
  from public.decision_records as dr
  left join public.outbound_actions as oa on oa.decision_record_id = dr.id
  where dr.id = v_decision_id;
end;
$function$;
