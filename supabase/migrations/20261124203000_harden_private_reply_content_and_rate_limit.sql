-- Endurecimento final do piloto de Private Reply.
--
-- 1. A regra de conteúdo vale para qualquer caminho de escrita, inclusive uma
--    edição humana posterior ao rascunho do Gemini.
-- 2. Ao atingir o teto móvel de 24 horas, a ação volta a proposed. Isso evita
--    que um item approved monopolize a fila e exige nova revisão humana.

create or replace function public.enforce_private_reply_pilot_content()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.action_type = 'private_reply'
     and (
       nullif(btrim(coalesce(new.message_text, '')), '') is null
       or length(btrim(new.message_text)) > 500
       or octet_length(btrim(new.message_text)) > 1000
       or new.message_text ~* '(https?://|www[.]|```)'
     ) then
    raise exception 'private_reply_content_not_allowed' using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_private_reply_pilot_content()
from public, anon, authenticated;

drop trigger if exists enforce_private_reply_pilot_content
on public.outbound_actions;

create trigger enforce_private_reply_pilot_content
before insert or update
on public.outbound_actions
for each row execute function public.enforce_private_reply_pilot_content();

create or replace function public.requeue_private_reply_daily_limit()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.action_type = 'private_reply'
     and new.status = 'approved'
     and new.last_error = 'private_reply_pilot_daily_limit_reached'
     and old.last_error is distinct from new.last_error then
    update public.outbound_actions as oa
    set status = 'proposed',
        approved_at = null,
        approved_by = null,
        dispatch_started_at = null,
        updated_at = clock_timestamp()
    where oa.id = new.id
      and oa.status = 'approved';

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
      'private-reply-pilot',
      'outbound_action.requeued_daily_limit',
      'outbound_action',
      new.id::text,
      jsonb_build_object(
        'previous_status', 'approved',
        'new_status', 'proposed',
        'reason', new.last_error
      )
    );
  end if;

  return null;
end;
$function$;

revoke all on function public.requeue_private_reply_daily_limit()
from public, anon, authenticated;

drop trigger if exists requeue_private_reply_daily_limit
on public.outbound_actions;

create trigger requeue_private_reply_daily_limit
after update of last_error
on public.outbound_actions
for each row execute function public.requeue_private_reply_daily_limit();

comment on function public.enforce_private_reply_pilot_content() is
  'Impõe até 500 caracteres/1.000 bytes e proíbe URL em Private Reply por qualquer caminho de escrita.';

comment on function public.requeue_private_reply_daily_limit() is
  'Ao atingir o limite do piloto, devolve o Direct a proposed para não bloquear a fila e exigir nova aprovação.';
