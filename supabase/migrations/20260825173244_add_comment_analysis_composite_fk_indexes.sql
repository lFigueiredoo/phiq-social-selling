create index idx_comment_analyses_event_org
  on public.comment_analyses (webhook_event_id, organization_id);

create index idx_comment_analyses_job_org
  on public.comment_analyses (processing_job_id, organization_id);
