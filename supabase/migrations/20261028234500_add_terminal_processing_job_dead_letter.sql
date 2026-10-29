create or replace function public.dead_letter_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text
)
returns table (
  job_id uuid,
  job_status text,
  webhook_event_id uuid,
  webhook_status text,
  attempts integer,
  completed_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  if p_error is null or btrim(p_error) = '' then
    raise exception 'error is required';
  end if;

  select *
  into v_job
  from public.processing_jobs
  where id = p_job_id
    and status = 'processing'
    and locked_by = p_worker_id
  for update;

  if not found then
    return;
  end if;

  update public.processing_jobs
  set status = 'dead_letter',
      last_error = left(btrim(p_error), 500),
      locked_at = null,
      locked_by = null,
      updated_at = v_now,
      completed_at = v_now
  where id = p_job_id;

  update public.webhook_events
  set status = 'dead_letter',
      processing_attempts = greatest(processing_attempts, v_job.attempts),
      last_error = left(btrim(p_error), 500),
      processed_at = v_now
  where id = v_job.webhook_event_id;

  return query
  select pj.id,
         pj.status,
         pj.webhook_event_id,
         we.status,
         pj.attempts,
         pj.completed_at
  from public.processing_jobs pj
  join public.webhook_events we on we.id = pj.webhook_event_id
  where pj.id = p_job_id;
end;
$$;

revoke all on function public.dead_letter_processing_job(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.dead_letter_processing_job(uuid, text, text)
  to service_role;
