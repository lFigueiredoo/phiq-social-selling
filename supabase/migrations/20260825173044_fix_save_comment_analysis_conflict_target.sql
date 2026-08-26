create or replace function public.save_comment_analysis(
  p_job_id uuid,
  p_worker_id text,
  p_sentiment text,
  p_intent text,
  p_commercial_potential text,
  p_lead_score integer,
  p_requires_human_review boolean,
  p_recommended_action text,
  p_suggested_reply text,
  p_analysis_summary text,
  p_model_name text,
  p_prompt_version text,
  p_provider_response_id text default null
)
returns table (
  analysis_id uuid,
  processing_job_id uuid,
  webhook_event_id uuid,
  sentiment text,
  intent text,
  commercial_potential text,
  lead_score smallint,
  requires_human_review boolean,
  recommended_action text,
  suggested_reply text,
  analysis_summary text,
  model_name text,
  prompt_version text,
  provider_response_id text,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select pj.*
  into v_job
  from public.processing_jobs as pj
  where pj.id = p_job_id
    and pj.status = 'processing'
    and pj.locked_by = p_worker_id
  for update;

  if not found then
    return;
  end if;

  if v_job.organization_id is null then
    raise exception 'job organization is required';
  end if;

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
    prompt_version,
    provider_response_id
  ) values (
    v_job.organization_id,
    v_job.webhook_event_id,
    v_job.id,
    p_sentiment,
    p_intent,
    p_commercial_potential,
    p_lead_score,
    coalesce(p_requires_human_review, false),
    p_recommended_action,
    nullif(btrim(coalesce(p_suggested_reply, '')), ''),
    nullif(btrim(coalesce(p_analysis_summary, '')), ''),
    'openai',
    p_model_name,
    p_prompt_version,
    nullif(btrim(coalesce(p_provider_response_id, '')), '')
  )
  on conflict on constraint comment_analyses_processing_job_id_key do update
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
      provider_response_id = excluded.provider_response_id,
      updated_at = clock_timestamp();

  return query
  select
    ca.id,
    ca.processing_job_id,
    ca.webhook_event_id,
    ca.sentiment,
    ca.intent,
    ca.commercial_potential,
    ca.lead_score,
    ca.requires_human_review,
    ca.recommended_action,
    ca.suggested_reply,
    ca.analysis_summary,
    ca.model_name,
    ca.prompt_version,
    ca.provider_response_id,
    ca.updated_at
  from public.comment_analyses as ca
  where ca.processing_job_id = v_job.id;
end;
$$;

revoke all on function public.save_comment_analysis(uuid, text, text, text, text, integer, boolean, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_comment_analysis(uuid, text, text, text, text, integer, boolean, text, text, text, text, text, text)
  to service_role;
