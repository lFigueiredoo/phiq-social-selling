create or replace function public.claim_processing_job(
  p_worker_id text,
  p_job_type text default null
)
returns table (
  id uuid,
  organization_id uuid,
  webhook_event_id uuid,
  job_type text,
  status text,
  priority smallint,
  available_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  attempts integer,
  max_attempts integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  with candidate as (
    select pj.id
    from public.processing_jobs as pj
    where pj.status = 'pending'
      and pj.available_at <= now()
      and pj.attempts < pj.max_attempts
      and p_worker_id is not null
      and btrim(p_worker_id) <> ''
      and (p_job_type is null or pj.job_type = p_job_type)
    order by pj.priority desc, pj.created_at asc, pj.id asc
    for update skip locked
    limit 1
  ), claimed as (
    update public.processing_jobs as pj
    set status = 'processing',
        locked_at = clock_timestamp(),
        locked_by = p_worker_id,
        attempts = pj.attempts + 1,
        updated_at = clock_timestamp()
    from candidate as c
    where pj.id = c.id
    returning pj.*
  )
  select
    c.id,
    c.organization_id,
    c.webhook_event_id,
    c.job_type,
    c.status,
    c.priority,
    c.available_at,
    c.locked_at,
    c.locked_by,
    c.attempts,
    c.max_attempts,
    c.created_at,
    c.updated_at
  from claimed as c;
$$;

revoke execute on function public.claim_processing_job(text, text) from public;
revoke execute on function public.claim_processing_job(text, text) from anon;
revoke execute on function public.claim_processing_job(text, text) from authenticated;
grant execute on function public.claim_processing_job(text, text) to service_role;
