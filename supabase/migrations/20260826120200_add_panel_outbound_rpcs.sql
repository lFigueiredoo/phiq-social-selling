-- ============================================================================
-- Migration: add_panel_outbound_rpcs
--
-- RPCs do Painel de Aprovação. Três princípios governam este arquivo:
--
-- 1. AUDITORIA ATÔMICA
--    A mutação e o INSERT em audit_logs acontecem DENTRO DA MESMA função
--    plpgsql, portanto dentro da mesma transação. Se a gravação de
--    auditoria falhar, a mutação inteira sofre rollback. Não existe
--    caminho em que uma ação mude de estado sem deixar registro.
--
-- 2. DEFESA EM PROFUNDIDADE DE TENANT
--    A verificação de membership e de propriedade da ação é feita AQUI,
--    além de ser feita na Edge Function. O organization_id vindo do
--    navegador nunca é aceito como verdade: ele é confrontado com
--    organization_members (para o usuário do JWT) e com o
--    outbound_actions.organization_id real.
--
-- 3. NÃO DUPLICAR REGRAS DE ELEGIBILIDADE
--    panel_approve_outbound_action delega a public.approve_outbound_action,
--    que já contém as regras de policy_check_status, eligible_until e
--    requires_human_review. Reimplementá-las aqui criaria uma segunda
--    fonte de verdade fadada a divergir.
--
-- CONVENÇÃO DE SQLSTATE (mapeada para HTTP pela Edge Function):
--   42501 -> 403  membership ausente/suspenso ou papel insuficiente
--   P0002 -> 404  ação inexistente OU de outro tenant (mesma resposta, de
--                 propósito: não revelar existência de recurso alheio)
--   22023 -> 400  parâmetro inválido
--   P0001 -> 409  conflito de regra de negócio (estado errado, janela
--                 expirada, política não elegível) — inclui as exceções
--                 levantadas por approve_outbound_action
--
-- NÃO aplicada remotamente por esta execução.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Helper interno: valida membership ativo e papel, devolve o papel.
-- Levanta 42501 se o usuário não puder atuar naquela organização.
-- ----------------------------------------------------------------------------
create or replace function public.panel_assert_membership(
  p_user_id uuid,
  p_organization_id uuid,
  p_min_role text default 'reviewer'
)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_role text;
begin
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;
  if p_organization_id is null then
    raise exception 'organization_id is required' using errcode = '22023';
  end if;

  select om.role
  into v_role
  from public.organization_members as om
  where om.user_id = p_user_id
    and om.organization_id = p_organization_id
    and om.status = 'active';

  if not found then
    raise exception 'no active membership for organization' using errcode = '42501';
  end if;

  -- Hierarquia atual: admin >= reviewer. Se p_min_role = 'admin', apenas
  -- admin passa. Se 'reviewer', ambos passam.
  if p_min_role = 'admin' and v_role <> 'admin' then
    raise exception 'insufficient role' using errcode = '42501';
  end if;

  return v_role;
end;
$function$;

comment on function public.panel_assert_membership(uuid, uuid, text) is
  'Valida que o usuário possui membership ATIVO na organização informada e papel suficiente. Levanta 42501 caso contrário. Usada por todas as RPCs panel_*.';


-- ----------------------------------------------------------------------------
-- Helper interno: carrega a ação COM lock, confirmando que ela pertence à
-- organização informada. Ação de outro tenant é tratada como inexistente.
-- ----------------------------------------------------------------------------
create or replace function public.panel_lock_outbound_action(
  p_action_id uuid,
  p_organization_id uuid
)
returns public.outbound_actions
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
begin
  if p_action_id is null then
    raise exception 'action_id is required' using errcode = '22023';
  end if;

  select oa.*
  into v_action
  from public.outbound_actions as oa
  where oa.id = p_action_id
  for update;

  if not found then
    raise exception 'outbound action not found' using errcode = 'P0002';
  end if;

  -- Cross-tenant devolve exatamente o mesmo erro de "não existe", para não
  -- permitir enumeração de UUIDs de outras organizações.
  if v_action.organization_id is distinct from p_organization_id then
    raise exception 'outbound action not found' using errcode = 'P0002';
  end if;

  return v_action;
end;
$function$;

comment on function public.panel_lock_outbound_action(uuid, uuid) is
  'Carrega um outbound_action com FOR UPDATE validando que pertence à organização informada. Ação de outro tenant levanta P0002 (mesmo erro de inexistente), evitando enumeração.';


-- ----------------------------------------------------------------------------
-- APROVAÇÃO
-- Delega a public.approve_outbound_action e grava auditoria na mesma
-- transação. Idempotente: aprovar algo já aprovado devolve o estado atual
-- SEM gravar um segundo audit log (a regra é um log por mutação concluída,
-- e nesse caso não houve mutação).
-- ----------------------------------------------------------------------------
create or replace function public.panel_approve_outbound_action(
  p_action_id uuid,
  p_organization_id uuid,
  p_user_id uuid
)
returns table(
  outbound_action_id uuid,
  status text,
  policy_check_status text,
  approved_at timestamptz,
  approved_by text,
  already_approved boolean
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
  v_already boolean := false;
  v_approver text;
begin
  perform public.panel_assert_membership(p_user_id, p_organization_id, 'reviewer');

  v_action := public.panel_lock_outbound_action(p_action_id, p_organization_id);

  if v_action.status = 'approved' then
    v_already := true;
  end if;

  v_approver := 'user:' || p_user_id::text;

  -- Delegação: todas as regras de elegibilidade (policy_check_status,
  -- eligible_until, requires_human_review, action_type) vivem lá.
  -- Exceções levantadas por ela (P0001) propagam e desfazem a transação.
  perform public.approve_outbound_action(p_action_id, v_approver);

  -- Auditoria SOMENTE quando houve mutação real.
  if not v_already then
    insert into public.audit_logs (
      organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata
    ) values (
      p_organization_id,
      'user',
      p_user_id::text,
      'outbound_action.approved',
      'outbound_action',
      p_action_id::text,
      jsonb_build_object(
        'action_type', v_action.action_type,
        'policy_check_status', v_action.policy_check_status,
        'previous_status', v_action.status
      )
    );
  end if;

  return query
  select oa.id, oa.status, oa.policy_check_status, oa.approved_at, oa.approved_by, v_already
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

comment on function public.panel_approve_outbound_action(uuid, uuid, uuid) is
  'Aprovação pelo painel: valida membership e tenant, delega a approve_outbound_action e grava audit_logs na MESMA transação. Não dispara envio ao Instagram — apenas muda o estado para approved.';


-- ----------------------------------------------------------------------------
-- REJEIÇÃO
-- Estado terminal por decisão humana. Só a partir de 'proposed'.
-- Idempotente para 'rejected' (sem segundo audit log).
-- ----------------------------------------------------------------------------
create or replace function public.panel_reject_outbound_action(
  p_action_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_reason text default null
)
returns table(
  outbound_action_id uuid,
  status text,
  rejected_at timestamptz,
  rejected_by text,
  rejection_reason text,
  already_rejected boolean
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.panel_assert_membership(p_user_id, p_organization_id, 'reviewer');

  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'rejection_reason too long' using errcode = '22023';
  end if;

  v_action := public.panel_lock_outbound_action(p_action_id, p_organization_id);

  if v_action.status = 'rejected' then
    return query
    select oa.id, oa.status, oa.rejected_at, oa.rejected_by, oa.rejection_reason, true
    from public.outbound_actions as oa
    where oa.id = p_action_id;
    return;
  end if;

  if v_action.status <> 'proposed' then
    raise exception 'action is not proposed' using errcode = 'P0001';
  end if;

  update public.outbound_actions as oa
  set status = 'rejected',
      rejected_at = clock_timestamp(),
      rejected_by = 'user:' || p_user_id::text,
      rejection_reason = v_reason,
      updated_at = clock_timestamp()
  where oa.id = p_action_id;

  insert into public.audit_logs (
    organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata
  ) values (
    p_organization_id,
    'user',
    p_user_id::text,
    'outbound_action.rejected',
    'outbound_action',
    p_action_id::text,
    jsonb_build_object(
      'action_type', v_action.action_type,
      'previous_status', v_action.status,
      'rejection_reason', v_reason
    )
  );

  return query
  select oa.id, oa.status, oa.rejected_at, oa.rejected_by, oa.rejection_reason, false
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

comment on function public.panel_reject_outbound_action(uuid, uuid, uuid, text) is
  'Rejeição humana pelo painel: só a partir de proposed, grava audit_logs na MESMA transação. Estado terminal distinto de cancelled (reservado a cancelamento sistêmico).';


-- ----------------------------------------------------------------------------
-- EDIÇÃO DA MENSAGEM
-- Permitida EXCLUSIVAMENTE enquanto status = 'proposed'. Depois de
-- aprovada, a mensagem é imutável por este caminho — nada de alteração
-- silenciosa entre a aprovação e o envio.
-- ----------------------------------------------------------------------------
create or replace function public.panel_update_outbound_action_message(
  p_action_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_message_text text
)
returns table(
  outbound_action_id uuid,
  status text,
  message_text text,
  previous_message_text text
)
language plpgsql
set search_path = ''
as $function$
declare
  v_action public.outbound_actions%rowtype;
  v_new text := btrim(coalesce(p_message_text, ''));
begin
  perform public.panel_assert_membership(p_user_id, p_organization_id, 'reviewer');

  if v_new = '' then
    raise exception 'message_text is required' using errcode = '22023';
  end if;
  if length(v_new) > 2000 then
    raise exception 'message_text too long' using errcode = '22023';
  end if;

  v_action := public.panel_lock_outbound_action(p_action_id, p_organization_id);

  if v_action.status <> 'proposed' then
    raise exception 'message can only be edited while proposed' using errcode = 'P0001';
  end if;

  -- No-op explícito: texto idêntico não é mutação, não gera audit log.
  if v_action.message_text = v_new then
    return query
    select oa.id, oa.status, oa.message_text, v_action.message_text
    from public.outbound_actions as oa
    where oa.id = p_action_id;
    return;
  end if;

  update public.outbound_actions as oa
  set message_text = v_new,
      updated_at = clock_timestamp()
  where oa.id = p_action_id;

  insert into public.audit_logs (
    organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata
  ) values (
    p_organization_id,
    'user',
    p_user_id::text,
    'outbound_action.message_edited',
    'outbound_action',
    p_action_id::text,
    jsonb_build_object(
      'previous_message_text', v_action.message_text,
      'new_message_text', v_new
    )
  );

  return query
  select oa.id, oa.status, oa.message_text, v_action.message_text
  from public.outbound_actions as oa
  where oa.id = p_action_id;
end;
$function$;

comment on function public.panel_update_outbound_action_message(uuid, uuid, uuid, text) is
  'Edita message_text SOMENTE enquanto a ação está proposed, gravando o diff em audit_logs na MESMA transação. Após a aprovação a mensagem é imutável por este caminho.';


-- ----------------------------------------------------------------------------
-- LISTAGEM PAGINADA DA FILA
--
-- Projeção específica do painel. Extrai apenas comment_text do payload —
-- o JSON bruto de webhook_events NUNCA sai daqui.
--
-- Filtro base espelha exatamente as regras de approve_outbound_action:
-- a fila mostra o que é de fato aprovável, nem mais nem menos.
-- ----------------------------------------------------------------------------
create or replace function public.panel_list_outbound_actions(
  p_organization_id uuid,
  p_user_id uuid,
  p_intent text default null,
  p_commercial_potential text default null,
  p_action_type text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  outbound_action_id uuid,
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
-- Deliberadamente VOLATILE (padrão), não STABLE: a função usa
-- clock_timestamp() para avaliar a janela de elegibilidade, e
-- clock_timestamp() é volátil. Declarar STABLE aqui autorizaria o
-- planejador a assumir estabilidade dentro da consulta e poderia
-- congelar/reaproveitar o instante avaliado — o oposto do que queremos ao
-- checar um prazo que expira.
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.panel_assert_membership(p_user_id, p_organization_id, 'reviewer');

  if p_action_type is not null and p_action_type not in ('public_reply', 'private_reply') then
    raise exception 'invalid action_type filter' using errcode = '22023';
  end if;

  return query
  with base as (
    select
      oa.id,
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
    -- Extração robusta do comentário: o payload da Meta pode conter mais de
    -- um entry e mais de um change. Assumir entry[0].changes[0] exibiria o
    -- comentário ERRADO em qualquer lote com múltiplos eventos — um erro
    -- silencioso e grave, já que o revisor aprovaria uma resposta com base
    -- em um texto que não é o do comentário-alvo.
    --
    -- Localizamos o change cujo value.id corresponde ao comentário-alvo,
    -- usando target_comment_id e, como equivalente, external_object_id.
    -- Os guards de jsonb_typeof evitam que um payload com formato
    -- inesperado (entry/changes ausente ou não-array) derrube a listagem
    -- inteira. LEFT JOIN LATERAL garante que a ausência do change resulte
    -- em comment_text = null, sem eliminar a linha da fila.
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
        (oa.action_type = 'public_reply'
           and oa.policy_check_status in ('not_required', 'eligible'))
        or
        -- Para private_reply, policy_check_status = 'eligible' NÃO basta:
        -- a elegibilidade tem prazo (janela de 7 dias da Meta). Sem checar
        -- eligible_until aqui, a fila mostraria ações que a RPC de
        -- aprovação recusaria — o revisor leria, decidiria e só então
        -- levaria erro. A RPC de aprovação continua sendo a autoridade
        -- final e revalida o prazo no momento da decisão.
        (oa.action_type = 'private_reply'
           and oa.policy_check_status = 'eligible'
           and oa.eligible_until is not null
           and oa.eligible_until > clock_timestamp())
      )
      and (p_intent is null or ca.intent = p_intent)
      and (p_commercial_potential is null or ca.commercial_potential = p_commercial_potential)
      and (p_action_type is null or oa.action_type = p_action_type)
  ),
  counted as (
    select count(*) as n from base
  )
  select
    b.id, b.action_type, b.status, b.policy_check_status,
    b.target_username, b.target_user_id, b.target_comment_id,
    b.comment_text, b.message_text,
    b.eligible_until, b.comment_created_at, b.created_at,
    b.sentiment, b.intent, b.commercial_potential, b.lead_score,
    b.analysis_summary,
    c.n
  from base as b
  cross join counted as c
  -- Ordenação: primeiro o que expira antes (NULLs por último, pois
  -- public_reply não tem janela), depois o mais antigo.
  order by b.eligible_until asc nulls last, b.created_at asc
  limit v_limit
  offset v_offset;
end;
$function$;

comment on function public.panel_list_outbound_actions(uuid, uuid, text, text, text, integer, integer) is
  'Fila paginada do painel. Filtro base espelha as regras de approve_outbound_action. Extrai apenas comment_text do payload — o JSON bruto do webhook nunca é exposto.';


-- ----------------------------------------------------------------------------
-- MEMBERSHIPS DO USUÁRIO
-- Bootstrap da UI. Um usuário pode pertencer a várias organizações.
-- ----------------------------------------------------------------------------
create or replace function public.panel_list_memberships(
  p_user_id uuid
)
returns table(
  organization_id uuid,
  organization_name text,
  role text
)
language plpgsql
stable
set search_path = ''
as $function$
begin
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;

  return query
  select om.organization_id, o.name, om.role
  from public.organization_members as om
  join public.organizations as o on o.id = om.organization_id
  where om.user_id = p_user_id
    and om.status = 'active'
    and o.status = 'active'
  order by o.name asc;
end;
$function$;

comment on function public.panel_list_memberships(uuid) is
  'Lista as organizações ativas em que o usuário possui membership ativo, com o papel. Bootstrap do painel — o usuário escolhe a organização ativa.';


-- ============================================================================
-- Privilégios
--
-- Nenhuma dessas funções é executável por anon/authenticated: o navegador
-- nunca fala com o banco diretamente. Só as Edge Functions panel-*, que
-- rodam com service_role APÓS validarem o JWT, podem executá-las.
-- ============================================================================

revoke all on function public.panel_assert_membership(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.panel_lock_outbound_action(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.panel_approve_outbound_action(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.panel_reject_outbound_action(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.panel_update_outbound_action_message(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.panel_list_outbound_actions(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.panel_list_memberships(uuid)
  from public, anon, authenticated;

grant execute on function public.panel_assert_membership(uuid, uuid, text)
  to service_role;
grant execute on function public.panel_lock_outbound_action(uuid, uuid)
  to service_role;
grant execute on function public.panel_approve_outbound_action(uuid, uuid, uuid)
  to service_role;
grant execute on function public.panel_reject_outbound_action(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.panel_update_outbound_action_message(uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.panel_list_outbound_actions(uuid, uuid, text, text, text, integer, integer)
  to service_role;
grant execute on function public.panel_list_memberships(uuid)
  to service_role;
