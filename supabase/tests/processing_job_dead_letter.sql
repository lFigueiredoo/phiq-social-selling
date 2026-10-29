begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $test$
declare
  v_org uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_event uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
begin
  insert into public.organizations(id, name)
    values (v_org, 'dead-letter-local');
  insert into public.instagram_accounts(id, organization_id, external_id, status)
    values (v_account, v_org, 'dead-letter-local-ig', 'active');
  insert into public.webhook_events(
    id, organization_id, instagram_account_id, object_type, event_type,
    external_object_id, idempotency_key, payload, status
  ) values (
    v_event, v_org, v_account, 'instagram', 'comments', 'terminal-comment',
    'meta:instagram:comments:dead-letter-local-ig:terminal-comment', '{}'::jsonb, 'processing'
  );
  insert into public.processing_jobs(
    id, organization_id, webhook_event_id, job_type, status,
    locked_at, locked_by, attempts
  ) values (
    v_job, v_org, v_event, 'process_instagram_comment', 'processing',
    clock_timestamp(), 'worker-terminal-test', 1
  );

  perform public.dead_letter_processing_job(
    v_job, 'worker-terminal-test', 'terminal:invalid_pipeline_input'
  );

  if not exists (
    select 1 from public.processing_jobs
    where id = v_job
      and status = 'dead_letter'
      and locked_at is null
      and locked_by is null
      and completed_at is not null
      and last_error = 'terminal:invalid_pipeline_input'
  ) then
    raise exception 'processing job was not atomically moved to dead_letter';
  end if;

  if not exists (
    select 1 from public.webhook_events
    where id = v_event
      and status = 'dead_letter'
      and processed_at is not null
      and processing_attempts = 1
      and last_error = 'terminal:invalid_pipeline_input'
  ) then
    raise exception 'webhook event did not follow terminal job state';
  end if;
end;
$test$;

select extensions.pass('terminal jobs move atomically to dead-letter with locks cleared');
select * from extensions.finish();
rollback;
