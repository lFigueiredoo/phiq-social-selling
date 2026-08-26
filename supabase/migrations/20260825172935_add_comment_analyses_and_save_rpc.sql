alter table public.processing_jobs
  add constraint processing_jobs_id_org_unique unique (id, organization_id);

create table public.comment_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  webhook_event_id uuid not null references public.webhook_events(id) on delete restrict,
  processing_job_id uuid not null unique references public.processing_jobs(id) on delete restrict,
  sentiment text not null check (sentiment in ('positive','neutral','negative','mixed','unknown')),
  intent text not null check (intent in ('engagement','question','purchase_interest','product_interest','support','complaint','partnership','spam','other')),
  commercial_potential text not null check (commercial_potential in ('low','medium','high','unknown')),
  lead_score smallint not null check (lead_score between 0 and 100),
  requires_human_review boolean not null default false,
  recommended_action text not null check (recommended_action in ('none','public_reply','private_reply_candidate','human_review')),
  suggested_reply text,
  analysis_summary text,
  model_provider text not null default 'openai',
  model_name text not null,
  prompt_version text not null,
  provider_response_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comment_analyses_event_org_fk
    foreign key (webhook_event_id, organization_id)
    references public.webhook_events(id, organization_id),
  constraint comment_analyses_job_org_fk
    foreign key (processing_job_id, organization_id)
    references public.processing_jobs(id, organization_id)
);

comment on table public.comment_analyses is
  'Structured AI analysis for an Instagram comment processing job. The AI only recommends; sending decisions are handled elsewhere.';
comment on column public.comment_analyses.recommended_action is
  'AI recommendation only. private_reply_candidate is not permission to send a DM; policy/decision checks happen downstream.';

create index idx_comment_analyses_organization_id
  on public.comment_analyses (organization_id);
create index idx_comment_analyses_webhook_event_id
  on public.comment_analyses (webhook_event_id);

alter table public.comment_analyses enable row level security;

revoke all on table public.comment_analyses from anon, authenticated, service_role;
grant select, insert, update on table public.comment_analyses to service_role;

create trigger trg_comment_analyses_set_updated_at
before update on public.comment_analyses
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
