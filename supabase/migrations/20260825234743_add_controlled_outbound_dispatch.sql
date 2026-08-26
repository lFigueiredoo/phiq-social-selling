alter table public.outbound_actions
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists dispatch_started_at timestamptz;

alter table public.outbound_actions
  drop constraint if exists outbound_actions_status_check;

alter table public.outbound_actions
  add constraint outbound_actions_status_check
  check (status = any (array[
    'proposed'::text,
    'approved'::text,
    'dispatching'::text,
    'sent'::text,
    'failed'::text,
    'dispatch_uncertain'::text,
    'cancelled'::text,
    'blocked'::text
  ]));

create or replace function public.approve_outbound_action(
  p_action_id uuid,
  p_approver text
)
returns table(
  outbound_action_id uuid,
  status text,
  policy_check_status text,
  approved_at timestamptz,
  approved_by text
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
begin
  if p_approver is null or btrim(p_approver) = '' then
    raise exception 'approver is required';
  end if;

  select oa.*
  into v_action
  from public.outbound_actions as oa
  where oa.id = p_action_id
  for update;

  if not found then
    return;
  end if;

  if v_action.status = 'approved' then
    return query
    select oa.id, oa.status, oa.policy_check_status, oa.approved_at, oa.approved_by
    from public.outbound_actions as oa
    where oa.id = p_action_id;
    return;
  end if;

  if v_action.status <> 'proposed' then
    raise exception 'action is not proposed';
  end if;

  if v_action.requires_human_review then
    raise exception 'action requires human review';
  end if;

  if v_action.action_type = 'private_reply' then
    if v_action.policy_check_status <> 'eligible' then
      raise exception 'private reply is not policy eligible';
    end if;
    if v_action.eligible_until is null or v_action.eligible_until <= clock_timestamp() then
      raise exception 'private reply eligibility window expired';
    end if;
  elsif v_action.action_type = 'public_reply' then
    if v_action.policy_check_status not in ('not_required', 'eligible') then
      raise exception 'public reply policy state is not approvable';
    end if;
  else
    raise exception 'unsupported action type';
  end if;

  update public.outbound_actions as oa
  set status = 'approved',
      approved_at = clock_timestamp(),
      approved_by = btrim(p_approver),
      updated_at = clock_timestamp()
  where oa.id = p_action_id;

  return query
  select oa.id, oa.status, oa.policy_check_status, oa.approved_at, oa.approved_by
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

create or replace function public.claim_outbound_action_for_dispatch(
  p_action_id uuid,
  p_dispatcher text
)
returns table(
  outbound_action_id uuid,
  action_type text,
  target_comment_id text,
  target_user_id text,
  target_username text,
  message_text text,
  instagram_account_external_id text,
  idempotency_key text
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
begin
  if p_dispatcher is null or btrim(p_dispatcher) = '' then
    raise exception 'dispatcher is required';
  end if;

  select oa.*
  into v_action
  from public.outbound_actions as oa
  where oa.id = p_action_id
    and oa.status = 'approved'
    and oa.sent_at is null
  for update skip locked;

  if not found then
    return;
  end if;

  if v_action.action_type = 'private_reply' then
    if v_action.policy_check_status <> 'eligible' then
      raise exception 'private reply is not policy eligible';
    end if;
    if v_action.eligible_until is null or v_action.eligible_until <= clock_timestamp() then
      update public.outbound_actions as oa
      set status = 'blocked',
          last_error = 'private_reply_window_expired_before_dispatch',
          updated_at = clock_timestamp()
      where oa.id = p_action_id;
      return;
    end if;
  end if;

  update public.outbound_actions as oa
  set status = 'dispatching',
      dispatch_started_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where oa.id = p_action_id;

  return query
  select
    oa.id,
    oa.action_type,
    oa.target_comment_id,
    oa.target_user_id,
    oa.target_username,
    oa.message_text,
    ia.external_id,
    oa.idempotency_key
  from public.outbound_actions as oa
  left join public.instagram_accounts as ia on ia.id = oa.instagram_account_id
  where oa.id = p_action_id;
end;
$function$;

create or replace function public.mark_outbound_action_sent(
  p_action_id uuid,
  p_provider_action_id text
)
returns table(
  outbound_action_id uuid,
  status text,
  sent_at timestamptz,
  provider_action_id text
)
language plpgsql
set search_path = ''
as $function$
begin
  update public.outbound_actions as oa
  set status = 'sent',
      sent_at = coalesce(oa.sent_at, clock_timestamp()),
      provider_action_id = coalesce(nullif(btrim(coalesce(p_provider_action_id, '')), ''), oa.provider_action_id),
      last_error = null,
      updated_at = clock_timestamp()
  where oa.id = p_action_id
    and oa.status = 'dispatching'
    and oa.sent_at is null;

  return query
  select oa.id, oa.status, oa.sent_at, oa.provider_action_id
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

create or replace function public.mark_outbound_action_dispatch_error(
  p_action_id uuid,
  p_error text,
  p_uncertain boolean default false
)
returns table(
  outbound_action_id uuid,
  status text,
  last_error text
)
language plpgsql
set search_path = ''
as $function$
begin
  update public.outbound_actions as oa
  set status = case when coalesce(p_uncertain, false) then 'dispatch_uncertain' else 'failed' end,
      last_error = left(coalesce(p_error, 'dispatch_error'), 2000),
      updated_at = clock_timestamp()
  where oa.id = p_action_id
    and oa.status = 'dispatching'
    and oa.sent_at is null;

  return query
  select oa.id, oa.status, oa.last_error
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

revoke all on function public.approve_outbound_action(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_outbound_action_for_dispatch(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_outbound_action_sent(uuid, text) from public, anon, authenticated;
revoke all on function public.mark_outbound_action_dispatch_error(uuid, text, boolean) from public, anon, authenticated;

grant execute on function public.approve_outbound_action(uuid, text) to service_role;
grant execute on function public.claim_outbound_action_for_dispatch(uuid, text) to service_role;
grant execute on function public.mark_outbound_action_sent(uuid, text) to service_role;
grant execute on function public.mark_outbound_action_dispatch_error(uuid, text, boolean) to service_role;
