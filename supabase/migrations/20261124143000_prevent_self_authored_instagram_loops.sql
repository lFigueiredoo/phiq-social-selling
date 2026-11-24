-- Defesa em profundidade contra loops de resposta: comentários publicados
-- pela própria conta Instagram não podem permanecer elegíveis para outbound.
-- O webhook já os ignora antes da fila; este trigger cobre importações, retries
-- e qualquer outro produtor backend que chegue a outbound_actions.

create or replace function public.cancel_self_targeted_outbound_action()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_external_id text;
  v_username text;
begin
  if new.instagram_account_id is null then
    return new;
  end if;

  select ia.external_id, ia.username
  into v_external_id, v_username
  from public.instagram_accounts as ia
  where ia.id = new.instagram_account_id
    and ia.organization_id = new.organization_id;

  if found and (
    (
      nullif(btrim(coalesce(new.target_user_id, '')), '') is not null
      and new.target_user_id = v_external_id
    )
    or (
      nullif(btrim(coalesce(new.target_username, '')), '') is not null
      and nullif(btrim(coalesce(v_username, '')), '') is not null
      and lower(btrim(new.target_username)) = lower(btrim(v_username))
    )
  ) then
    new.status := 'cancelled';
    new.last_error := 'self_authored_comment_ignored';
    new.sent_at := null;
    new.provider_action_id := null;
  end if;

  return new;
end;
$function$;

revoke all on function public.cancel_self_targeted_outbound_action()
from public, anon, authenticated;

drop trigger if exists cancel_self_targeted_outbound_action
on public.outbound_actions;

create trigger cancel_self_targeted_outbound_action
before insert or update of
  organization_id,
  instagram_account_id,
  target_user_id,
  target_username
on public.outbound_actions
for each row execute function public.cancel_self_targeted_outbound_action();

-- Reconcilia qualquer rascunho autoendereçado que já exista antes da trava.
with cancelled as (
  update public.outbound_actions as oa
  set status = 'cancelled',
      last_error = 'self_authored_comment_ignored',
      updated_at = clock_timestamp()
  from public.instagram_accounts as ia
  where ia.id = oa.instagram_account_id
    and ia.organization_id = oa.organization_id
    and oa.status in ('proposed', 'approved')
    and oa.sent_at is null
    and (
      oa.target_user_id = ia.external_id
      or (
        nullif(btrim(coalesce(oa.target_username, '')), '') is not null
        and nullif(btrim(coalesce(ia.username, '')), '') is not null
        and lower(btrim(oa.target_username)) = lower(btrim(ia.username))
      )
    )
  returning oa.id, oa.organization_id, oa.action_type, oa.target_comment_id
)
insert into public.audit_logs (
  organization_id,
  actor_type,
  actor_id,
  action,
  entity_type,
  entity_id,
  metadata
)
select
  cancelled.organization_id,
  'system',
  'self-authored-webhook-guard',
  'outbound_action.cancelled_self_target',
  'outbound_action',
  cancelled.id::text,
  jsonb_build_object(
    'reason', 'self_authored_comment_ignored',
    'action_type', cancelled.action_type,
    'target_comment_id', cancelled.target_comment_id
  )
from cancelled;

create or replace function public.audit_self_targeted_outbound_cancellation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status = 'cancelled'
     and new.last_error = 'self_authored_comment_ignored'
     and (
       tg_op = 'INSERT'
       or old.status is distinct from new.status
       or old.last_error is distinct from new.last_error
     ) then
    insert into public.audit_logs (
      organization_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      metadata
    ) values (
      new.organization_id,
      'system',
      'self-authored-webhook-guard',
      'outbound_action.cancelled_self_target',
      'outbound_action',
      new.id::text,
      jsonb_build_object(
        'reason', new.last_error,
        'action_type', new.action_type,
        'target_comment_id', new.target_comment_id
      )
    );
  end if;

  return new;
end;
$function$;

revoke all on function public.audit_self_targeted_outbound_cancellation()
from public, anon, authenticated;

drop trigger if exists audit_self_targeted_outbound_cancellation
on public.outbound_actions;

create trigger audit_self_targeted_outbound_cancellation
after insert or update of status, last_error
on public.outbound_actions
for each row execute function public.audit_self_targeted_outbound_cancellation();

comment on function public.cancel_self_targeted_outbound_action() is
  'Cancela antes da persistência qualquer outbound direcionado à própria conta Instagram da organização.';

