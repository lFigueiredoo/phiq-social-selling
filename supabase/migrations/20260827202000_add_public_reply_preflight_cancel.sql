create or replace function public.cancel_outbound_public_reply_already_replied(
  p_action_id uuid,
  p_dispatcher text
)
returns table(
  outbound_action_id uuid,
  status text,
  last_error text,
  cancelled boolean
)
language plpgsql
set search_path to ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
begin
  if p_action_id is null then
    raise exception 'action id is required';
  end if;

  if p_dispatcher is null or btrim(p_dispatcher) = '' then
    raise exception 'dispatcher is required';
  end if;

  update public.outbound_actions as oa
  set
    status = 'cancelled',
    last_error = 'public_reply_already_exists_before_dispatch',
    updated_at = clock_timestamp()
  where oa.id = p_action_id
    and oa.action_type = 'public_reply'
    and oa.status = 'dispatching'
    and oa.sent_at is null
  returning oa.*
  into v_action;

  if found then
    insert into public.audit_logs (
      organization_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      metadata
    )
    values (
      v_action.organization_id,
      'automation',
      btrim(p_dispatcher),
      'outbound_public_reply_cancelled_preflight',
      'outbound_action',
      v_action.id::text,
      jsonb_build_object(
        'reason',
        'public_reply_already_exists_before_dispatch',
        'action_type',
        v_action.action_type,
        'target_comment_id',
        v_action.target_comment_id,
        'dispatcher',
        btrim(p_dispatcher)
      )
    );

    return query
    select
      v_action.id,
      v_action.status,
      v_action.last_error,
      true;

    return;
  end if;

  return query
  select
    oa.id,
    oa.status,
    oa.last_error,
    false
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

revoke all
on function public.cancel_outbound_public_reply_already_replied(uuid, text)
from public, anon, authenticated;

grant execute
on function public.cancel_outbound_public_reply_already_replied(uuid, text)
to service_role;