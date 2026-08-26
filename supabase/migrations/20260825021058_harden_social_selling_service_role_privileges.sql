revoke all on table
  public.organizations,
  public.instagram_accounts,
  public.webhook_events,
  public.processing_jobs,
  public.audit_logs
from service_role;

grant select, insert, update, delete
  on table
    public.organizations,
    public.instagram_accounts,
    public.webhook_events,
    public.processing_jobs
  to service_role;

grant select, insert
  on table public.audit_logs
  to service_role;

revoke execute on function public.set_updated_at() from service_role;
