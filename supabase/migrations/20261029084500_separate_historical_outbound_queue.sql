-- Separa, na fonte, ações de comentários recebidos em tempo real das ações
-- originadas pela importação histórica. A UI não depende de convenção visual:
-- a RPC aplica o filtro de origem dentro do tenant antes da paginação.

drop function if exists public.panel_list_outbound_actions(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer
);

create function public.panel_list_outbound_actions(
  p_organization_id uuid,
  p_user_id uuid,
  p_intent text default null,
  p_commercial_potential text default null,
  p_action_type text default null,
  p_source text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  outbound_action_id uuid,
  source text,
  action_type text,
  status text,
  policy_check_status text,
  target_username text,
  target_user_id text,
  target_comment_id text,
  comment_text text,
  message_text text,
  eligible_until timestamptz,
  comment_created_at timestamptz,
  created_at timestamptz,
  sentiment text,
  intent text,
  commercial_potential text,
  lead_score smallint,
  analysis_summary text,
  total_count bigint
)
language plpgsql
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.panel_assert_membership(
    p_user_id,
    p_organization_id,
    'reviewer'
  );

  if p_action_type is not null
     and p_action_type not in ('public_reply', 'private_reply') then
    raise exception 'invalid action_type filter' using errcode = '22023';
  end if;

  if p_source is not null
     and p_source not in ('realtime', 'historical_backfill') then
    raise exception 'invalid source filter' using errcode = '22023';
  end if;

  return query
  with base as (
    select
      oa.id,
      case
        when we.payload ->> 'source' = 'historical_backfill'
          then 'historical_backfill'::text
        else 'realtime'::text
      end as action_source,
      oa.action_type,
      oa.status,
      oa.policy_check_status,
      oa.target_username,
      oa.target_user_id,
      oa.target_comment_id,
      cmt.comment_text,
      oa.message_text,
      oa.eligible_until,
      oa.comment_created_at,
      oa.created_at,
      ca.sentiment,
      ca.intent,
      ca.commercial_potential,
      ca.lead_score,
      ca.analysis_summary
    from public.outbound_actions as oa
    join public.comment_analyses as ca on ca.id = oa.analysis_id
    join public.webhook_events as we on we.id = oa.webhook_event_id
    left join lateral (
      select ch.elem #>> '{value,text}' as comment_text
      from jsonb_array_elements(
             case when jsonb_typeof(we.payload -> 'entry') = 'array'
                  then we.payload -> 'entry'
                  else '[]'::jsonb end
           ) as e(elem)
      cross join lateral jsonb_array_elements(
             case when jsonb_typeof(e.elem -> 'changes') = 'array'
                  then e.elem -> 'changes'
                  else '[]'::jsonb end
           ) as ch(elem)
      where ch.elem #>> '{value,id}'
            = coalesce(oa.target_comment_id, we.external_object_id)
      limit 1
    ) as cmt on true
    where oa.organization_id = p_organization_id
      and oa.status = 'proposed'
      and (
        (
          oa.action_type = 'public_reply'
          and oa.policy_check_status in ('not_required', 'eligible')
        )
        or
        (
          oa.action_type = 'private_reply'
          and oa.policy_check_status = 'eligible'
          and oa.eligible_until is not null
          and oa.eligible_until > clock_timestamp()
        )
      )
      and (p_intent is null or ca.intent = p_intent)
      and (
        p_commercial_potential is null
        or ca.commercial_potential = p_commercial_potential
      )
      and (p_action_type is null or oa.action_type = p_action_type)
      and (
        p_source is null
        or case
             when we.payload ->> 'source' = 'historical_backfill'
               then 'historical_backfill'::text
             else 'realtime'::text
           end = p_source
      )
  ),
  counted as (
    select count(*) as n from base
  )
  select
    b.id,
    b.action_source,
    b.action_type,
    b.status,
    b.policy_check_status,
    b.target_username,
    b.target_user_id,
    b.target_comment_id,
    b.comment_text,
    b.message_text,
    b.eligible_until,
    b.comment_created_at,
    b.created_at,
    b.sentiment,
    b.intent,
    b.commercial_potential,
    b.lead_score,
    b.analysis_summary,
    c.n
  from base as b
  cross join counted as c
  order by b.eligible_until asc nulls last, b.created_at asc
  limit v_limit
  offset v_offset;
end;
$function$;

comment on function public.panel_list_outbound_actions(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  integer,
  integer
) is
  'Fila paginada de ações aprováveis, com separação server-side entre eventos em tempo real e importação histórica.';

revoke all on function public.panel_list_outbound_actions(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  integer,
  integer
) from public, anon, authenticated;

grant execute on function public.panel_list_outbound_actions(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  integer,
  integer
) to service_role;
