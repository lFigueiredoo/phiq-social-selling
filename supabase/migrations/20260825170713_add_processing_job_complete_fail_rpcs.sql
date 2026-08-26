create or replace function public.complete_processing_job(
  p_job_id uuid,
  p_worker_id text
)
returns table (
  job_id uuid,
  job_status text,
  webhook_event_id uuid,
  webhook_status text,
  completed_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_webhook_event_id uuid;
  v_completed_at timestamptz := clock_timestamp();
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  update public.processing_jobs
  set status = 'completed',
      completed_at = v_completed_at,
      updated_at = v_completed_at,
      last_error = null
  where id = p_job_id
    and status = 'processing'
    and locked_by = p_worker_id
  returning webhook_event_id into v_webhook_event_id;

  if v_webhook_event_id is null then
    return;
  end if;

  update public.webhook_events
  set status = 'processed',
      processed_at = v_completed_at,
      processing_attempts = greatest(processing_attempts, (
        select attempts from public.processing_jobs where id = p_job_id
      )),
      last_error = null
  where id = v_webhook_event_id;

  return query
  select pj.id,
         pj.status,
         pj.webhook_event_id,
         we.status,
         pj.completed_at
  from public.processing_jobs pj
  join public.webhook_events we on we.id = pj.webhook_event_id
  where pj.id = p_job_id;
end;
$$;

create or replace function public.fail_processing_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text,
  p_retry_after_seconds integer default 60
)
returns table (
  job_id uuid,
  job_status text,
  webhook_event_id uuid,
  webhook_status text,
  attempts integer,
  max_attempts integer,
  available_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_terminal boolean;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  if p_error is null or btrim(p_error) = '' then
    raise exception 'error is required';
  end if;

  if p_retry_after_seconds is null or p_retry_after_seconds < 0 then
    raise exception 'retry_after_seconds must be >= 0';
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

  v_terminal := v_job.attempts >= v_job.max_attempts;

  if v_terminal then
    update public.processing_jobs
    set status = 'dead_letter',
        last_error = p_error,
        updated_at = v_now,
        completed_at = v_now
    where id = p_job_id;

    update public.webhook_events
    set status = 'dead_letter',
        processing_attempts = greatest(processing_attempts, v_job.attempts),
        last_error = p_error,
        processed_at = v_now
    where id = v_job.webhook_event_id;
  else
    update public.processing_jobs
    set status = 'pending',
        available_at = v_now + make_interval(secs => p_retry_after_seconds),
        locked_at = null,
        locked_by = null,
        last_error = p_error,
        updated_at = v_now
    where id = p_job_id;

    update public.webhook_events
    set status = 'queued',
        processing_attempts = greatest(processing_attempts, v_job.attempts),
        last_error = p_error
    where id = v_job.webhook_event_id;
  end if;

  return query
  select pj.id,
         pj.status,
         pj.webhook_event_id,
         we.status,
         pj.attempts,
         pj.max_attempts,
         pj.available_at
  from public.processing_jobs pj
  join public.webhook_events we on we.id = pj.webhook_event_id
  where pj.id = p_job_id;
end;
$$;

revoke all on function public.complete_processing_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_processing_job(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text) to service_role;
grant execute on function public.fail_processing_job(uuid, text, text, integer) to service_role;
