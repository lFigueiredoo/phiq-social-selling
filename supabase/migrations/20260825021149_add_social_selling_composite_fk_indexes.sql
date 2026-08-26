create index idx_webhook_events_account_org
  on public.webhook_events (instagram_account_id, organization_id);

create index idx_processing_jobs_event_org
  on public.processing_jobs (webhook_event_id, organization_id);
