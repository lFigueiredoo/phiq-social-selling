-- ============================================================================
-- Migration: add_outbound_action_rejected_state
--
-- Adiciona o estado 'rejected' (decisão humana explícita de NÃO enviar) ao
-- CHECK de outbound_actions.status.
--
-- 'cancelled' é PRESERVADO e continua reservado para cancelamento
-- sistêmico futuro (ex.: comentário apagado pelo autor antes do envio).
-- Reutilizar 'cancelled' para rejeição humana misturaria decisão humana com
-- cancelamento automático e corromperia, de forma irreversível, a métrica
-- de taxa de rejeição humana — o indicador que mede a qualidade das
-- respostas geradas pela IA.
--
-- Aditiva: o novo CHECK é um superconjunto do anterior, portanto nenhuma
-- linha existente é invalidada.
--
-- ATENÇÃO OPERACIONAL: DROP CONSTRAINT toma ACCESS EXCLUSIVE lock
-- momentaneamente. Aplicar em janela de baixa atividade do worker.
--
-- NÃO aplicada remotamente por esta execução.
-- ============================================================================

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
    'blocked'::text,
    'rejected'::text
  ]));

alter table public.outbound_actions
  add column rejected_at timestamptz,
  add column rejected_by text,
  add column rejection_reason text;

comment on column public.outbound_actions.rejected_by is
  'Rótulo de quem rejeitou, mesmo formato de approved_by (ex.: user:<uuid>). É text por ser polimórfico: pode vir a ser um humano ou uma regra sistêmica.';
comment on column public.outbound_actions.rejection_reason is
  'Motivo opcional informado pelo revisor. Texto livre curto, sem payload da Meta e sem dados sensíveis.';

-- ----------------------------------------------------------------------------
-- CORREÇÃO: apply_outbound_policy_result passa a tratar 'rejected' como
-- estado TERMINAL, junto de 'sent' e 'cancelled'.
--
-- Motivo: sem isso, uma checagem de política executada DEPOIS de um revisor
-- humano rejeitar a ação ainda conseguiria sobrescrever policy_check_status,
-- policy_reason, eligible_until e policy_context daquela linha. A decisão
-- humana continuaria valendo (status permanece 'rejected', pois o CASE só
-- muda para 'blocked' a partir de 'proposed'/'approved'), mas os campos de
-- auditoria da política seriam alterados após o fato — corrompendo o
-- registro do que o revisor viu no momento em que decidiu.
--
-- A função é recriada IDÊNTICA à versão da migration 20260825233237,
-- exceto por essa única cláusula. Nenhuma outra linha foi alterada.
-- ----------------------------------------------------------------------------

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
    and oa.status not in ('sent','cancelled','rejected');

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

-- CREATE OR REPLACE preserva privilégios existentes; as linhas abaixo
-- reafirmam o estado esperado de forma idempotente.
revoke all on function public.apply_outbound_policy_result(uuid,text,text,timestamptz,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.apply_outbound_policy_result(uuid,text,text,timestamptz,timestamptz,jsonb) to service_role;
