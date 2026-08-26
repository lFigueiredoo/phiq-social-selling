alter table public.comment_analyses
  alter column model_provider set default 'unknown';

update public.comment_analyses
set model_provider = case
  when lower(model_name) like 'gemini%' then 'google'
  when lower(model_name) like 'gpt-%' then 'openai'
  else model_provider
end
where model_provider = 'openai';

alter table public.comment_analyses
  add constraint comment_analyses_id_org_unique unique (id, organization_id);

create table public.decision_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  analysis_id uuid not null,
  processing_job_id uuid not null,
  webhook_event_id uuid not null,
  decision text not null check (decision in ('public_reply','private_reply_candidate','human_review','none')),
  reason text not null,
  rule_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint decision_records_org_fk foreign key (organization_id)
    references public.organizations(id) on delete restrict,
  constraint decision_records_analysis_fk foreign key (analysis_id)
    references public.comment_analyses(id) on delete restrict,
  constraint decision_records_analysis_org_fk foreign key (analysis_id, organization_id)
    references public.comment_analyses(id, organization_id),
  constraint decision_records_job_fk foreign key (processing_job_id)
    references public.processing_jobs(id) on delete restrict,
  constraint decision_records_job_org_fk foreign key (processing_job_id, organization_id)
    references public.processing_jobs(id, organization_id),
  constraint decision_records_event_fk foreign key (webhook_event_id)
    references public.webhook_events(id) on delete restrict,
  constraint decision_records_event_org_fk foreign key (webhook_event_id, organization_id)
    references public.webhook_events(id, organization_id),
  constraint decision_records_analysis_rule_unique unique (analysis_id, rule_version),
  constraint decision_records_id_org_unique unique (id, organization_id)
);

create table public.outbound_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  decision_record_id uuid not null,
  analysis_id uuid not null,
  processing_job_id uuid not null,
  webhook_event_id uuid not null,
  instagram_account_id uuid,
  action_type text not null check (action_type in ('public_reply','private_reply')),
  status text not null default 'proposed' check (status in ('proposed','approved','dispatching','sent','failed','cancelled','blocked')),
  policy_check_status text not null default 'not_checked' check (policy_check_status in ('not_checked','not_required','eligible','ineligible')),
  requires_human_review boolean not null default false,
  target_comment_id text not null,
  target_user_id text,
  target_username text,
  message_text text not null,
  idempotency_key text not null,
  provider_action_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint outbound_actions_org_fk foreign key (organization_id)
    references public.organizations(id) on delete restrict,
  constraint outbound_actions_decision_fk foreign key (decision_record_id)
    references public.decision_records(id) on delete restrict,
  constraint outbound_actions_decision_org_fk foreign key (decision_record_id, organization_id)
    references public.decision_records(id, organization_id),
  constraint outbound_actions_analysis_fk foreign key (analysis_id)
    references public.comment_analyses(id) on delete restrict,
  constraint outbound_actions_analysis_org_fk foreign key (analysis_id, organization_id)
    references public.comment_analyses(id, organization_id),
  constraint outbound_actions_job_fk foreign key (processing_job_id)
    references public.processing_jobs(id) on delete restrict,
  constraint outbound_actions_job_org_fk foreign key (processing_job_id, organization_id)
    references public.processing_jobs(id, organization_id),
  constraint outbound_actions_event_fk foreign key (webhook_event_id)
    references public.webhook_events(id) on delete restrict,
  constraint outbound_actions_event_org_fk foreign key (webhook_event_id, organization_id)
    references public.webhook_events(id, organization_id),
  constraint outbound_actions_instagram_account_fk foreign key (instagram_account_id)
    references public.instagram_accounts(id) on delete set null,
  constraint outbound_actions_idempotency_unique unique (idempotency_key),
  constraint outbound_actions_decision_unique unique (decision_record_id)
);

create index idx_decision_records_analysis_org on public.decision_records (analysis_id, organization_id);
create index idx_decision_records_job_org on public.decision_records (processing_job_id, organization_id);
create index idx_decision_records_event_org on public.decision_records (webhook_event_id, organization_id);
create index idx_outbound_actions_decision_org on public.outbound_actions (decision_record_id, organization_id);
create index idx_outbound_actions_analysis_org on public.outbound_actions (analysis_id, organization_id);
create index idx_outbound_actions_job_org on public.outbound_actions (processing_job_id, organization_id);
create index idx_outbound_actions_event_org on public.outbound_actions (webhook_event_id, organization_id);
create index idx_outbound_actions_status on public.outbound_actions (status, created_at);

alter table public.decision_records enable row level security;
alter table public.outbound_actions enable row level security;

revoke all on table public.decision_records from anon, authenticated, service_role;
revoke all on table public.outbound_actions from anon, authenticated, service_role;

grant select, insert, update on table public.decision_records to service_role;
grant select, insert, update on table public.outbound_actions to service_role;

create trigger decision_records_set_updated_at
before update on public.decision_records
for each row execute function public.set_updated_at();

create trigger outbound_actions_set_updated_at
before update on public.outbound_actions
for each row execute function public.set_updated_at();

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
returns table(
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
  v_model_provider text;
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

  v_model_provider := case
    when lower(p_model_name) like 'gemini%' then 'google'
    when lower(p_model_name) like 'gpt-%' then 'openai'
    else 'unknown'
  end;

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
    v_model_provider,
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

revoke all on function public.save_comment_analysis(uuid,text,text,text,text,integer,boolean,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.save_comment_analysis(uuid,text,text,text,text,integer,boolean,text,text,text,text,text,text) to service_role;

create or replace function public.decide_instagram_comment_action(
  p_job_id uuid,
  p_worker_id text,
  p_rule_version text default 'ig-decision-v1'
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
security invoker
set search_path = ''
as $$
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
     or v_analysis.intent in ('complaint','support','partnership')
     or v_analysis.recommended_action = 'human_review' then
    v_decision := 'human_review';
    v_reason := 'Conservative gate: review required by analysis, sentiment, intent, or recommendation.';
  elsif v_analysis.intent = 'spam' or v_analysis.recommended_action = 'none' then
    v_decision := 'none';
    v_reason := 'No outbound action for spam or explicit none recommendation.';
  elsif v_analysis.recommended_action = 'private_reply_candidate'
        and v_analysis.intent in ('purchase_interest','product_interest')
        and v_analysis.commercial_potential in ('medium','high')
        and v_analysis.lead_score >= 60
        and v_analysis.suggested_reply is not null then
    v_decision := 'private_reply_candidate';
    v_reason := 'Commercial intent passed score and potential thresholds; Meta eligibility still must be checked before dispatch.';
  elsif v_analysis.recommended_action = 'public_reply'
        and v_analysis.intent in ('engagement','question','other')
        and v_analysis.sentiment not in ('negative','mixed')
        and v_analysis.suggested_reply is not null then
    v_decision := 'public_reply';
    v_reason := 'Low-risk public interaction passed deterministic safety gates.';
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
$$;

revoke all on function public.decide_instagram_comment_action(uuid,text,text) from public, anon, authenticated;
grant execute on function public.decide_instagram_comment_action(uuid,text,text) to service_role;
