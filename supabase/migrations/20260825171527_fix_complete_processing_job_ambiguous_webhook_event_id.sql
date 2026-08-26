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

  update public.processing_jobs as pj
  set status = 'completed',
      completed_at = v_completed_at,
      updated_at = v_completed_at,
      last_error = null
  where pj.id = p_job_id
    and pj.status = 'processing'
    and pj.locked_by = p_worker_id
  returning pj.webhook_event_id into v_webhook_event_id;

  if v_webhook_event_id is null then
    return;
  end if;

  update public.webhook_events as we
  set status = 'processed',
      processed_at = v_completed_at,
      processing_attempts = greatest(we.processing_attempts, (
        select pj2.attempts from public.processing_jobs as pj2 where pj2.id = p_job_id
      )),
      last_error = null
  where we.id = v_webhook_event_id;

  return query
  select pj.id,
         pj.status,
         pj.webhook_event_id,
         we.status,
         pj.completed_at
  from public.processing_jobs as pj
  join public.webhook_events as we on we.id = pj.webhook_event_id
  where pj.id = p_job_id;
end;
$$;

revoke all on function public.complete_processing_job(uuid, text) from public, anon, authenticated;
grant execute on function public.complete_processing_job(uuid, text) to service_role;
