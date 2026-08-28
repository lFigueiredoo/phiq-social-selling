create or replace function public.panel_import_historical_instagram_comment(
    p_user_id uuid,
    p_organization_id uuid,
    p_instagram_account_id uuid,
    p_comment_id text,
    p_idempotency_key text,
    p_payload jsonb
)
returns table (
    result text,
    webhook_event_id uuid,
    processing_job_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_event_id uuid;
    v_job_id uuid;
begin
    if p_user_id is null then
        raise exception 'user_required'
            using errcode = '22023';
    end if;

    if p_organization_id is null then
        raise exception 'organization_required'
            using errcode = '22023';
    end if;

    if p_instagram_account_id is null then
        raise exception 'instagram_account_required'
            using errcode = '22023';
    end if;

    if nullif(btrim(p_comment_id), '') is null then
        raise exception 'comment_id_required'
            using errcode = '22023';
    end if;

    if nullif(btrim(p_idempotency_key), '') is null then
        raise exception 'idempotency_key_required'
            using errcode = '22023';
    end if;

    if p_payload is null then
        raise exception 'payload_required'
            using errcode = '22023';
    end if;

    -- Defense in depth:
    -- somente admin ativo pode importar comentários históricos.
    if not exists (
        select 1
        from public.organization_members om
        where om.organization_id = p_organization_id
          and om.user_id = p_user_id
          and om.role = 'admin'
          and om.status = 'active'
    ) then
        raise exception 'admin_required'
            using errcode = '42501';
    end if;

    -- A conta usada precisa pertencer à organização e estar ativa.
    if not exists (
        select 1
        from public.instagram_accounts ia
        where ia.id = p_instagram_account_id
          and ia.organization_id = p_organization_id
          and ia.status = 'active'
    ) then
        raise exception 'instagram_account_not_found'
            using errcode = 'P0001';
    end if;

    -- Se o webhook real ou um backfill anterior já registrou
    -- este comentário, não tocar nem reprocessar.
    select we.id
      into v_event_id
    from public.webhook_events we
    where we.idempotency_key = p_idempotency_key
    limit 1;

    if v_event_id is not null then
        select pj.id
          into v_job_id
        from public.processing_jobs pj
        where pj.webhook_event_id = v_event_id
          and pj.job_type = 'process_instagram_comment'
        limit 1;

        return query
        select
            'already_exists'::text,
            v_event_id,
            v_job_id;

        return;
    end if;

    -- Evento + job ficam dentro da MESMA transação da função.
    insert into public.webhook_events (
        organization_id,
        instagram_account_id,
        provider,
        object_type,
        event_type,
        external_object_id,
        idempotency_key,
        payload,
        status
    )
    values (
        p_organization_id,
        p_instagram_account_id,
        'meta',
        'instagram',
        'comments',
        p_comment_id,
        p_idempotency_key,
        p_payload,
        'received'
    )
    on conflict (idempotency_key) do nothing
    returning id into v_event_id;

    -- Proteção contra corrida concorrente:
    -- outra transação pode ter vencido o INSERT.
    if v_event_id is null then
        select we.id
          into v_event_id
        from public.webhook_events we
        where we.idempotency_key = p_idempotency_key
        limit 1;

        select pj.id
          into v_job_id
        from public.processing_jobs pj
        where pj.webhook_event_id = v_event_id
          and pj.job_type = 'process_instagram_comment'
        limit 1;

        return query
        select
            'already_exists'::text,
            v_event_id,
            v_job_id;

        return;
    end if;

    insert into public.processing_jobs (
        organization_id,
        webhook_event_id,
        job_type,
        status
    )
    values (
        p_organization_id,
        v_event_id,
        'process_instagram_comment',
        'pending'
    )
    returning id into v_job_id;

    update public.webhook_events
    set status = 'queued'
    where id = v_event_id
      and organization_id = p_organization_id
      and status = 'received';

    return query
    select
        'imported'::text,
        v_event_id,
        v_job_id;
end;
$function$;

revoke all
on function public.panel_import_historical_instagram_comment(
    uuid,
    uuid,
    uuid,
    text,
    text,
    jsonb
)
from public;

revoke all
on function public.panel_import_historical_instagram_comment(
    uuid,
    uuid,
    uuid,
    text,
    text,
    jsonb
)
from anon;

revoke all
on function public.panel_import_historical_instagram_comment(
    uuid,
    uuid,
    uuid,
    text,
    text,
    jsonb
)
from authenticated;

grant execute
on function public.panel_import_historical_instagram_comment(
    uuid,
    uuid,
    uuid,
    text,
    text,
    jsonb
)
to service_role;