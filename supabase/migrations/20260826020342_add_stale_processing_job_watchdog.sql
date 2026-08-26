create or replace function public.claim_processing_job(
  p_worker_id text,
  p_job_type text default null
)
returns table(
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
language plpgsql
set search_path = ''
as $$
declare
  v_stale record;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    return;
  end if;

  for v_stale in
    update public.processing_jobs as pj
    set status = case
          when pj.attempts >= pj.max_attempts then 'dead_letter'
          else 'pending'
        end,
        available_at = case
          when pj.attempts >= pj.max_attempts then pj.available_at
          else clock_timestamp() + interval '5 minutes'
        end,
        locked_at = null,
        locked_by = null,
        last_error = 'stale_processing_lock_timeout',
        updated_at = clock_timestamp()
    where pj.status = 'processing'
      and pj.locked_at is not null
      and pj.locked_at < clock_timestamp() - interval '10 minutes'
    returning pj.id, pj.webhook_event_id, pj.status
  loop
    update public.webhook_events as we
    set status = case
          when v_stale.status = 'dead_letter' then 'dead_letter'
          else 'queued'
        end,
        last_error = 'stale_processing_lock_timeout'
    where we.id = v_stale.webhook_event_id;
  end loop;

  return query
  with candidate as (
    select pj.id
    from public.processing_jobs as pj
    where pj.status = 'pending'
      and pj.available_at <= now()
      and pj.attempts < pj.max_attempts
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
end;
$$;

revoke all on function public.claim_processing_job(text, text) from public;
revoke all on function public.claim_processing_job(text, text) from anon;
revoke all on function public.claim_processing_job(text, text) from authenticated;
grant execute on function public.claim_processing_job(text, text) to service_role;
