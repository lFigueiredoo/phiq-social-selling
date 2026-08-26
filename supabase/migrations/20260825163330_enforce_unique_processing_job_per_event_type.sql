create unique index if not exists uq_processing_jobs_event_job_type
  on public.processing_jobs (webhook_event_id, job_type);
