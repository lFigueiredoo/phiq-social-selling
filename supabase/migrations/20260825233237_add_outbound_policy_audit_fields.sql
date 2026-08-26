alter table public.outbound_actions
  add column if not exists policy_checked_at timestamptz,
  add column if not exists policy_reason text,
  add column if not exists comment_created_at timestamptz,
  add column if not exists eligible_until timestamptz,
  add column if not exists policy_context jsonb;

create unique index if not exists uq_outbound_private_reply_per_comment
  on public.outbound_actions (instagram_account_id, target_comment_id)
  where action_type = 'private_reply';

create or replace function public.apply_outbound_policy_result(
  p_outbound_action_id uuid,
  p_policy_check_status text,
  p_policy_reason text,
  p_comment_created_at timestamptz default null,
  p_eligible_until timestamptz default null,
  p_policy_context jsonb default null
)
returns table (
  outbound_action_id uuid,
  action_type text,
  status text,
  policy_check_status text,
  policy_reason text,
  policy_checked_at timestamptz,
  comment_created_at timestamptz,
  eligible_until timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_policy_check_status not in ('eligible','ineligible','not_required') then
    raise exception 'invalid policy status';
  end if;

  update public.outbound_actions as oa
  set policy_check_status = p_policy_check_status,
      policy_reason = nullif(btrim(coalesce(p_policy_reason, '')), ''),
      policy_checked_at = v_now,
      comment_created_at = p_comment_created_at,
      eligible_until = p_eligible_until,
      policy_context = p_policy_context,
      status = case
        when p_policy_check_status = 'ineligible' and oa.status in ('proposed','approved') then 'blocked'
        else oa.status
      end,
      updated_at = v_now
  where oa.id = p_outbound_action_id
    and oa.status not in ('sent','cancelled');

  return query
  select oa.id,
         oa.action_type,
         oa.status,
         oa.policy_check_status,
         oa.policy_reason,
         oa.policy_checked_at,
         oa.comment_created_at,
         oa.eligible_until
  from public.outbound_actions as oa
  where oa.id = p_outbound_action_id;
end;
$$;

revoke all on function public.apply_outbound_policy_result(uuid,text,text,timestamptz,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.apply_outbound_policy_result(uuid,text,text,timestamptz,timestamptz,jsonb) to service_role;
