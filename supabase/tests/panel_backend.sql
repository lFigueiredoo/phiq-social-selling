-- ============================================================================
-- supabase/tests/panel_backend.sql
--
-- Testes de integridade do backend do Painel de Aprovação.
--
-- COMO EXECUTAR (Supabase de DESENVOLVIMENTO, nunca produção):
--   psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/panel_backend.sql
--
-- GARANTIAS DESTE ARQUIVO:
--   * Transacional: tudo roda dentro de BEGIN ... ROLLBACK. Nenhuma linha
--     persiste após a execução, mesmo se todos os testes passarem.
--   * Não destrutivo: nenhum DELETE, UPDATE ou TRUNCATE sobre dados
--     pré-existentes. Só cria fixtures próprias com UUIDs fixos e prefixo
--     'panel-test'.
--   * Independente de produção: não depende de nenhum ID real. Todos os
--     UUIDs são literais definidos aqui.
--   * Sem test hooks em produção: o teste de rollback de auditoria usa um
--     trigger criado DENTRO da transação de teste e desfeito pelo ROLLBACK.
--     Nenhuma flag condicional foi introduzida no código de produção.
--
-- CONVENÇÃO: cada teste levanta exceção com prefixo 'FALHOU Tnn' quando o
-- comportamento observado diverge do esperado. Com ON_ERROR_STOP=1 a
-- execução para no primeiro problema. Sucesso emite 'OK Tnn'.
--
-- NOTA SOBRE auth.users: as fixtures inserem diretamente em auth.users
-- porque organization_members possui FK para essa tabela. Se a versão do
-- schema de auth em uso exigir colunas adicionais NOT NULL, ajuste apenas
-- o bloco de fixtures — nenhum teste depende do formato do usuário além
-- do id.
-- ============================================================================

begin;

set local client_min_messages = notice;

-- ----------------------------------------------------------------------------
-- FIXTURES
-- Dois tenants (A e B) para exercitar isolamento cross-tenant.
-- ----------------------------------------------------------------------------

-- Organizações
insert into public.organizations (id, name, slug, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'panel-test org A', 'panel-test-org-a', 'active'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'panel-test org B', 'panel-test-org-b', 'active');

-- Usuários do Supabase Auth
insert into auth.users (id, email) values
  ('11111111-0000-4000-8000-000000000001', 'panel-test-reviewer-a@example.test'),
  ('22222222-0000-4000-8000-000000000001', 'panel-test-suspended-a@example.test'),
  ('33333333-0000-4000-8000-000000000001', 'panel-test-nomember@example.test'),
  ('44444444-0000-4000-8000-000000000001', 'panel-test-reviewer-b@example.test');

-- Memberships
insert into public.organization_members (organization_id, user_id, role, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'reviewer', 'active'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000001', 'reviewer', 'suspended'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '44444444-0000-4000-8000-000000000001', 'reviewer', 'active');
-- Usuário 3333 propositalmente SEM membership.

-- Contas Instagram
insert into public.instagram_accounts (id, organization_id, external_id, username, status) values
  ('a1111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'panel-test-ig-a', 'panel_test_a', 'active'),
  ('b1111111-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'panel-test-ig-b', 'panel_test_b', 'active');

-- ----------------------------------------------------------------------------
-- Webhook events.
-- O payload do primeiro evento tem DOIS entries e DOIS changes de propósito,
-- com o comentário-alvo NÃO sendo o primeiro. Isso reprova qualquer
-- implementação que assuma entry[0].changes[0].
-- ----------------------------------------------------------------------------
insert into public.webhook_events
  (id, organization_id, instagram_account_id, provider, object_type, event_type,
   external_object_id, idempotency_key, payload, status)
values
  ('e0000001-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'a1111111-0000-4000-8000-000000000001',
   'meta', 'instagram', 'comments',
   'panel-test-comment-1',
   'panel-test-idem-1',
   jsonb_build_object(
     'entry', jsonb_build_array(
       jsonb_build_object(
         'id', 'ig-entry-outro',
         'changes', jsonb_build_array(
           jsonb_build_object('field','comments','value',
             jsonb_build_object('id','panel-test-OUTRO-comentario','text','COMENTARIO ERRADO'))
         )
       ),
       jsonb_build_object(
         'id', 'ig-entry-alvo',
         'changes', jsonb_build_array(
           jsonb_build_object('field','comments','value',
             jsonb_build_object('id','panel-test-ainda-outro','text','TAMBEM ERRADO')),
           jsonb_build_object('field','comments','value',
             jsonb_build_object('id','panel-test-comment-1','text','quanto custa? tenho interesse'))
         )
       )
     )
   ),
   'processed'),
  -- Evento com payload malformado (entry ausente): a listagem deve
  -- devolver comment_text = null SEM quebrar.
  ('e0000002-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'a1111111-0000-4000-8000-000000000001',
   'meta', 'instagram', 'comments',
   'panel-test-comment-2', 'panel-test-idem-2',
   '{"objeto": "formato inesperado"}'::jsonb, 'processed'),
  ('e0000003-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'a1111111-0000-4000-8000-000000000001',
   'meta', 'instagram', 'comments',
   'panel-test-comment-3', 'panel-test-idem-3',
   jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('id','x','changes',
     jsonb_build_array(jsonb_build_object('field','comments','value',
       jsonb_build_object('id','panel-test-comment-3','text','comentario expirado')))))),
   'processed'),
  ('e0000004-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'a1111111-0000-4000-8000-000000000001',
   'meta', 'instagram', 'comments',
   'panel-test-comment-4', 'panel-test-idem-4',
   jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('id','x','changes',
     jsonb_build_array(jsonb_build_object('field','comments','value',
       jsonb_build_object('id','panel-test-comment-4','text','comentario publico')))))),
   'processed'),
  -- Evento do tenant B, para o teste cross-tenant.
  ('e0000005-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001',
   'b1111111-0000-4000-8000-000000000001',
   'meta', 'instagram', 'comments',
   'panel-test-comment-5', 'panel-test-idem-5',
   jsonb_build_object('entry', jsonb_build_array(jsonb_build_object('id','x','changes',
     jsonb_build_array(jsonb_build_object('field','comments','value',
       jsonb_build_object('id','panel-test-comment-5','text','comentario tenant B')))))),
   'processed');

-- Processing jobs
insert into public.processing_jobs
  (id, organization_id, webhook_event_id, job_type, status)
values
  ('30000001-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000001-0000-4000-8000-000000000001','analyze_comment','completed'),
  ('30000002-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000002-0000-4000-8000-000000000001','analyze_comment','completed'),
  ('30000003-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000003-0000-4000-8000-000000000001','analyze_comment','completed'),
  ('30000004-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000004-0000-4000-8000-000000000001','analyze_comment','completed'),
  ('30000005-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','e0000005-0000-4000-8000-000000000001','analyze_comment','completed');

-- Comment analyses
insert into public.comment_analyses
  (id, organization_id, webhook_event_id, processing_job_id, sentiment, intent,
   commercial_potential, lead_score, requires_human_review, recommended_action,
   suggested_reply, analysis_summary, model_name, prompt_version)
values
  ('ca000001-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000001-0000-4000-8000-000000000001','30000001-0000-4000-8000-000000000001','positive','purchase_interest','high',88,false,'private_reply_candidate','Oi! Te mando os detalhes no direct.','Interesse comercial claro.','gpt-test','v-test'),
  ('ca000002-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000002-0000-4000-8000-000000000001','30000002-0000-4000-8000-000000000001','neutral','question','medium',55,false,'public_reply','Claro, posso explicar!','Duvida simples.','gpt-test','v-test'),
  ('ca000003-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000003-0000-4000-8000-000000000001','30000003-0000-4000-8000-000000000001','positive','purchase_interest','high',91,false,'private_reply_candidate','Te chamo no direct!','Interesse, mas janela vencida.','gpt-test','v-test'),
  ('ca000004-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','e0000004-0000-4000-8000-000000000001','30000004-0000-4000-8000-000000000001','neutral','engagement','low',20,false,'public_reply','Obrigado pelo comentario!','Interacao simples.','gpt-test','v-test'),
  ('ca000005-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','e0000005-0000-4000-8000-000000000001','30000005-0000-4000-8000-000000000001','positive','purchase_interest','high',77,false,'private_reply_candidate','Resposta tenant B','Tenant B.','gpt-test','v-test');

-- Decision records
insert into public.decision_records
  (id, organization_id, analysis_id, processing_job_id, webhook_event_id, decision, reason, rule_version)
values
  ('d0000001-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','ca000001-0000-4000-8000-000000000001','30000001-0000-4000-8000-000000000001','e0000001-0000-4000-8000-000000000001','private_reply_candidate','teste','panel-test'),
  ('d0000002-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','ca000002-0000-4000-8000-000000000001','30000002-0000-4000-8000-000000000001','e0000002-0000-4000-8000-000000000001','public_reply','teste','panel-test'),
  ('d0000003-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','ca000003-0000-4000-8000-000000000001','30000003-0000-4000-8000-000000000001','e0000003-0000-4000-8000-000000000001','private_reply_candidate','teste','panel-test'),
  ('d0000004-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','ca000004-0000-4000-8000-000000000001','30000004-0000-4000-8000-000000000001','e0000004-0000-4000-8000-000000000001','public_reply','teste','panel-test'),
  ('d0000005-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','ca000005-0000-4000-8000-000000000001','30000005-0000-4000-8000-000000000001','e0000005-0000-4000-8000-000000000001','private_reply_candidate','teste','panel-test');

-- Outbound actions
--   oa1: private_reply elegível, janela FUTURA  -> deve aparecer na fila
--   oa2: public_reply not_required              -> deve aparecer na fila
--   oa3: private_reply elegível, janela VENCIDA -> NÃO deve aparecer
--   oa4: public_reply, alvo de testes de edição
--   oa5: tenant B                               -> cross-tenant
insert into public.outbound_actions
  (id, organization_id, decision_record_id, analysis_id, processing_job_id, webhook_event_id,
   instagram_account_id, action_type, status, policy_check_status, requires_human_review,
   target_comment_id, target_user_id, target_username, message_text, idempotency_key,
   eligible_until)
values
  ('0a000001-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','d0000001-0000-4000-8000-000000000001','ca000001-0000-4000-8000-000000000001','30000001-0000-4000-8000-000000000001','e0000001-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','private_reply','proposed','eligible',false,'panel-test-comment-1','ig-user-1','panel_user_1','Oi! Te mando os detalhes no direct.','panel-test-idem-oa1', now() + interval '5 days'),
  ('0a000002-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','d0000002-0000-4000-8000-000000000001','ca000002-0000-4000-8000-000000000001','30000002-0000-4000-8000-000000000001','e0000002-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','public_reply','proposed','not_required',false,'panel-test-comment-2','ig-user-2','panel_user_2','Claro, posso explicar!','panel-test-idem-oa2', null),
  ('0a000003-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','d0000003-0000-4000-8000-000000000001','ca000003-0000-4000-8000-000000000001','30000003-0000-4000-8000-000000000001','e0000003-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','private_reply','proposed','eligible',false,'panel-test-comment-3','ig-user-3','panel_user_3','Te chamo no direct!','panel-test-idem-oa3', now() - interval '1 hour'),
  ('0a000004-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','d0000004-0000-4000-8000-000000000001','ca000004-0000-4000-8000-000000000001','30000004-0000-4000-8000-000000000001','e0000004-0000-4000-8000-000000000001','a1111111-0000-4000-8000-000000000001','public_reply','proposed','not_required',false,'panel-test-comment-4','ig-user-4','panel_user_4','Obrigado pelo comentario!','panel-test-idem-oa4', null),
  ('0a000005-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001','d0000005-0000-4000-8000-000000000001','ca000005-0000-4000-8000-000000000001','30000005-0000-4000-8000-000000000001','e0000005-0000-4000-8000-000000000001','b1111111-0000-4000-8000-000000000001','private_reply','proposed','eligible',false,'panel-test-comment-5','ig-user-5','panel_user_5','Resposta tenant B','panel-test-idem-oa5', now() + interval '5 days');


-- ============================================================================
-- T01 — usuário sem membership não lista
-- ============================================================================
do $$
declare v_err text;
begin
  begin
    perform public.panel_list_outbound_actions(
      'aaaaaaaa-0000-4000-8000-000000000001',
      '33333333-0000-4000-8000-000000000001');
    raise exception 'FALHOU T01: usuario sem membership conseguiu listar';
  exception when insufficient_privilege then
    raise notice 'OK T01 usuario sem membership bloqueado (42501)';
  end;
end $$;

-- ============================================================================
-- T02 — membership suspenso é bloqueado
-- ============================================================================
do $$
begin
  begin
    perform public.panel_list_outbound_actions(
      'aaaaaaaa-0000-4000-8000-000000000001',
      '22222222-0000-4000-8000-000000000001');
    raise exception 'FALHOU T02: membership suspenso conseguiu listar';
  exception when insufficient_privilege then
    raise notice 'OK T02 membership suspenso bloqueado (42501)';
  end;
end $$;

-- ============================================================================
-- T03 — reviewer válido lista; fila contém exatamente oa1, oa2 e oa4
--        (oa3 fora por janela vencida; oa5 é de outro tenant)
-- ============================================================================
do $$
declare
  v_ids uuid[];
begin
  select array_agg(outbound_action_id order by outbound_action_id)
  into v_ids
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001');

  if v_ids is distinct from array[
      '0a000001-0000-4000-8000-000000000001'::uuid,
      '0a000002-0000-4000-8000-000000000001'::uuid,
      '0a000004-0000-4000-8000-000000000001'::uuid] then
    raise exception 'FALHOU T03: fila inesperada = %', v_ids;
  end if;
  raise notice 'OK T03 reviewer valido ve exatamente a fila esperada';
end $$;

-- ============================================================================
-- T04 — private reply com janela VENCIDA não aparece na fila (CORREÇÃO 2)
-- ============================================================================
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001')
  where outbound_action_id = '0a000003-0000-4000-8000-000000000001';

  if v_n <> 0 then
    raise exception 'FALHOU T04: private reply expirada apareceu na fila';
  end if;
  raise notice 'OK T04 private reply expirada fora da fila';
end $$;

-- ============================================================================
-- T05 — public reply not_required aparece na fila
-- ============================================================================
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001')
  where outbound_action_id = '0a000002-0000-4000-8000-000000000001';

  if v_n <> 1 then
    raise exception 'FALHOU T05: public reply not_required nao apareceu';
  end if;
  raise notice 'OK T05 public reply not_required na fila';
end $$;

-- ============================================================================
-- T06 — extração do comentário escolhe o change CORRETO (CORREÇÃO 3)
--        O payload tem 2 entries e 3 changes; o alvo é o último.
-- ============================================================================
do $$
declare v_text text;
begin
  select comment_text into v_text
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001')
  where outbound_action_id = '0a000001-0000-4000-8000-000000000001';

  if v_text is distinct from 'quanto custa? tenho interesse' then
    raise exception 'FALHOU T06: comentario extraido incorreto = %', v_text;
  end if;
  raise notice 'OK T06 comentario correto extraido entre multiplos entries/changes';
end $$;

-- ============================================================================
-- T07 — payload malformado devolve comment_text null sem quebrar a listagem
-- ============================================================================
do $$
declare v_text text; v_found boolean;
begin
  select comment_text, true into v_text, v_found
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001')
  where outbound_action_id = '0a000002-0000-4000-8000-000000000001';

  if not coalesce(v_found,false) then
    raise exception 'FALHOU T07: linha sumiu da fila por payload malformado';
  end if;
  if v_text is not null then
    raise exception 'FALHOU T07: esperado null, obtido %', v_text;
  end if;
  raise notice 'OK T07 payload malformado -> comment_text null, linha preservada';
end $$;

-- ============================================================================
-- T08 — cross-tenant: reviewer do tenant A não acessa ação do tenant B.
--        Deve resultar em P0002 (mesmo erro de inexistente).
-- ============================================================================
do $$
begin
  begin
    perform public.panel_approve_outbound_action(
      '0a000005-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001');
    raise exception 'FALHOU T08: aprovacao cross-tenant permitida';
  exception when no_data_found then
    raise notice 'OK T08 cross-tenant bloqueado como not_found (P0002)';
  end;
end $$;

-- ============================================================================
-- T09 — reviewer do tenant A informando organization_id do tenant B:
--        o organization_id do navegador nunca é aceito como verdade.
-- ============================================================================
do $$
begin
  begin
    perform public.panel_approve_outbound_action(
      '0a000005-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001');
    raise exception 'FALHOU T09: organization_id forjado foi aceito';
  exception when insufficient_privilege then
    raise notice 'OK T09 organization_id forjado rejeitado por membership (42501)';
  end;
end $$;

-- ============================================================================
-- T10 — private reply EXPIRADA é recusada na aprovação
--        (a RPC de aprovação continua sendo a autoridade final)
-- ============================================================================
do $$
begin
  begin
    perform public.panel_approve_outbound_action(
      '0a000003-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001');
    raise exception 'FALHOU T10: private reply expirada foi aprovada';
  exception when raise_exception then
    raise notice 'OK T10 aprovacao de private reply expirada recusada (P0001)';
  end;
end $$;

-- ============================================================================
-- T11 — edição em 'proposed' funciona e gera EXATAMENTE 1 audit log
-- ============================================================================
do $$
declare v_before bigint; v_after bigint; v_prev text; v_new text;
begin
  select count(*) into v_before from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001';

  select previous_message_text, message_text into v_prev, v_new
  from public.panel_update_outbound_action_message(
    '0a000004-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001',
    'Obrigado! Qualquer duvida e so chamar.');

  if v_new is distinct from 'Obrigado! Qualquer duvida e so chamar.' then
    raise exception 'FALHOU T11: mensagem nao foi atualizada';
  end if;

  select count(*) into v_after from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.message_edited';

  if v_after - v_before <> 1 then
    raise exception 'FALHOU T11: esperado 1 audit log, obtido %', v_after - v_before;
  end if;
  raise notice 'OK T11 edicao em proposed + exatamente 1 audit log';
end $$;

-- ============================================================================
-- T12 — audit log da edição contém previous e new message text
-- ============================================================================
do $$
declare v_meta jsonb;
begin
  select metadata into v_meta from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.message_edited'
  order by created_at desc limit 1;

  if v_meta ->> 'previous_message_text' is distinct from 'Obrigado pelo comentario!' then
    raise exception 'FALHOU T12: previous_message_text incorreto: %', v_meta;
  end if;
  if v_meta ->> 'new_message_text' is distinct from 'Obrigado! Qualquer duvida e so chamar.' then
    raise exception 'FALHOU T12: new_message_text incorreto: %', v_meta;
  end if;
  raise notice 'OK T12 metadata da edicao com previous e new';
end $$;

-- ============================================================================
-- T13 — edição para o MESMO texto não gera novo audit log
-- ============================================================================
do $$
declare v_before bigint; v_after bigint;
begin
  select count(*) into v_before from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.message_edited';

  perform public.panel_update_outbound_action_message(
    '0a000004-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001',
    'Obrigado! Qualquer duvida e so chamar.');

  select count(*) into v_after from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.message_edited';

  if v_after <> v_before then
    raise exception 'FALHOU T13: no-op gerou audit log adicional';
  end if;
  raise notice 'OK T13 edicao para mesmo texto nao gera audit log';
end $$;

-- ============================================================================
-- T14 — aprovação funciona e gera EXATAMENTE 1 audit log
-- ============================================================================
do $$
declare v_status text; v_by text; v_n bigint;
begin
  select status, approved_by into v_status, v_by
  from public.panel_approve_outbound_action(
    '0a000004-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001');

  if v_status is distinct from 'approved' then
    raise exception 'FALHOU T14: status pos-aprovacao = %', v_status;
  end if;
  if v_by is distinct from 'user:11111111-0000-4000-8000-000000000001' then
    raise exception 'FALHOU T14: approved_by = % (esperado prefixo user:)', v_by;
  end if;

  select count(*) into v_n from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.approved';
  if v_n <> 1 then
    raise exception 'FALHOU T14: esperado 1 audit log de aprovacao, obtido %', v_n;
  end if;
  raise notice 'OK T14 aprovacao + approved_by user:<uuid> + 1 audit log';
end $$;

-- ============================================================================
-- T15 — audit log da aprovação usa actor_type=user e actor_id UUID puro
-- ============================================================================
do $$
declare v_actor_type text; v_actor_id text; v_entity text;
begin
  select actor_type, actor_id, entity_type into v_actor_type, v_actor_id, v_entity
  from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.approved';

  if v_actor_type is distinct from 'user' then
    raise exception 'FALHOU T15: actor_type = %', v_actor_type;
  end if;
  if v_actor_id is distinct from '11111111-0000-4000-8000-000000000001' then
    raise exception 'FALHOU T15: actor_id deve ser UUID puro, obtido %', v_actor_id;
  end if;
  if v_entity is distinct from 'outbound_action' then
    raise exception 'FALHOU T15: entity_type = %', v_entity;
  end if;
  raise notice 'OK T15 actor_type=user, actor_id=UUID puro, entity_type=outbound_action';
end $$;

-- ============================================================================
-- T16 — segunda aprovação é idempotente e NÃO gera segundo audit log
-- ============================================================================
do $$
declare v_already boolean; v_n bigint;
begin
  select already_approved into v_already
  from public.panel_approve_outbound_action(
    '0a000004-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001');

  if not coalesce(v_already,false) then
    raise exception 'FALHOU T16: segunda aprovacao nao reportou already_approved';
  end if;

  select count(*) into v_n from public.audit_logs
  where entity_id = '0a000004-0000-4000-8000-000000000001'
    and action = 'outbound_action.approved';
  if v_n <> 1 then
    raise exception 'FALHOU T16: audit logs de aprovacao = % (esperado 1)', v_n;
  end if;
  raise notice 'OK T16 segunda aprovacao idempotente sem segundo audit log';
end $$;

-- ============================================================================
-- T17 — edição DEPOIS da aprovação é recusada
-- ============================================================================
do $$
declare v_msg text;
begin
  begin
    perform public.panel_update_outbound_action_message(
      '0a000004-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001',
      'TEXTO ALTERADO APOS APROVACAO');
    raise exception 'FALHOU T17: edicao pos-aprovacao foi permitida';
  exception when raise_exception then
    null;
  end;

  select message_text into v_msg from public.outbound_actions
  where id = '0a000004-0000-4000-8000-000000000001';
  if v_msg = 'TEXTO ALTERADO APOS APROVACAO' then
    raise exception 'FALHOU T17: mensagem foi alterada apos aprovacao';
  end if;
  raise notice 'OK T17 edicao pos-aprovacao recusada e texto preservado';
end $$;

-- ============================================================================
-- T18 — approve x reject: rejeitar algo já aprovado é recusado
-- ============================================================================
do $$
declare v_status text;
begin
  begin
    perform public.panel_reject_outbound_action(
      '0a000004-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001',
      'tentativa apos aprovacao');
    raise exception 'FALHOU T18: rejeicao de acao ja aprovada foi permitida';
  exception when raise_exception then
    null;
  end;

  select status into v_status from public.outbound_actions
  where id = '0a000004-0000-4000-8000-000000000001';
  if v_status is distinct from 'approved' then
    raise exception 'FALHOU T18: status mudou para %', v_status;
  end if;
  raise notice 'OK T18 reject apos approve recusado, estado preservado';
end $$;

-- ============================================================================
-- T19 — rejeição funciona e gera EXATAMENTE 1 audit log
-- ============================================================================
do $$
declare v_status text; v_by text; v_reason text; v_n bigint;
begin
  select status, rejected_by, rejection_reason into v_status, v_by, v_reason
  from public.panel_reject_outbound_action(
    '0a000002-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001',
    'resposta fora de tom');

  if v_status is distinct from 'rejected' then
    raise exception 'FALHOU T19: status = %', v_status;
  end if;
  if v_by is distinct from 'user:11111111-0000-4000-8000-000000000001' then
    raise exception 'FALHOU T19: rejected_by = %', v_by;
  end if;
  if v_reason is distinct from 'resposta fora de tom' then
    raise exception 'FALHOU T19: rejection_reason = %', v_reason;
  end if;

  select count(*) into v_n from public.audit_logs
  where entity_id = '0a000002-0000-4000-8000-000000000001'
    and action = 'outbound_action.rejected';
  if v_n <> 1 then
    raise exception 'FALHOU T19: audit logs de rejeicao = %', v_n;
  end if;
  raise notice 'OK T19 rejeicao + rejected_by user:<uuid> + 1 audit log';
end $$;

-- ============================================================================
-- T20 — segunda rejeição é idempotente e NÃO gera segundo audit log
-- ============================================================================
do $$
declare v_already boolean; v_n bigint;
begin
  select already_rejected into v_already
  from public.panel_reject_outbound_action(
    '0a000002-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001',
    'outra tentativa');

  if not coalesce(v_already,false) then
    raise exception 'FALHOU T20: segunda rejeicao nao reportou already_rejected';
  end if;

  select count(*) into v_n from public.audit_logs
  where entity_id = '0a000002-0000-4000-8000-000000000001'
    and action = 'outbound_action.rejected';
  if v_n <> 1 then
    raise exception 'FALHOU T20: audit logs = % (esperado 1)', v_n;
  end if;
  raise notice 'OK T20 segunda rejeicao idempotente sem segundo audit log';
end $$;

-- ============================================================================
-- T21 — ação rejeitada sai da fila
-- ============================================================================
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from public.panel_list_outbound_actions(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001')
  where outbound_action_id = '0a000002-0000-4000-8000-000000000001';
  if v_n <> 0 then
    raise exception 'FALHOU T21: acao rejeitada continua na fila';
  end if;
  raise notice 'OK T21 acao rejeitada fora da fila';
end $$;

-- ============================================================================
-- T22 — 'rejected' é TERMINAL: apply_outbound_policy_result não altera
--        campos de política de uma decisão humana já rejeitada (CORREÇÃO 1)
-- ============================================================================
do $$
declare
  v_before record;
  v_after record;
begin
  select status, policy_check_status, policy_reason, eligible_until, policy_checked_at
  into v_before
  from public.outbound_actions where id = '0a000002-0000-4000-8000-000000000001';

  perform public.apply_outbound_policy_result(
    '0a000002-0000-4000-8000-000000000001',
    'ineligible',
    'tentativa de sobrescrever apos rejeicao',
    now(), now() + interval '3 days',
    '{"origem":"teste"}'::jsonb);

  select status, policy_check_status, policy_reason, eligible_until, policy_checked_at
  into v_after
  from public.outbound_actions where id = '0a000002-0000-4000-8000-000000000001';

  if v_after.status is distinct from 'rejected' then
    raise exception 'FALHOU T22: status mudou de rejected para %', v_after.status;
  end if;
  if v_after.policy_check_status is distinct from v_before.policy_check_status
     or v_after.policy_reason is distinct from v_before.policy_reason
     or v_after.eligible_until is distinct from v_before.eligible_until
     or v_after.policy_checked_at is distinct from v_before.policy_checked_at then
    raise exception 'FALHOU T22: campos de politica alterados apos rejeicao';
  end if;
  raise notice 'OK T22 rejected e terminal para apply_outbound_policy_result';
end $$;

-- ============================================================================
-- T23 — ROLLBACK DA MUTAÇÃO QUANDO A AUDITORIA FALHA
--
-- Cenário controlado criado DENTRO desta transação de teste: um trigger que
-- rejeita qualquer INSERT em audit_logs. Nenhum hook condicional existe no
-- código de produção; o trigger é desfeito pelo ROLLBACK final.
--
-- Verifica que a aprovação de oa1 NÃO persiste quando a auditoria falha.
-- ============================================================================
create function pg_temp.panel_test_block_audit()
returns trigger
language plpgsql
as $trg$
begin
  raise exception 'FALHA SIMULADA DE AUDITORIA';
end;
$trg$;

create trigger panel_test_block_audit_trg
  before insert on public.audit_logs
  for each row execute function pg_temp.panel_test_block_audit();

do $$
declare
  v_status_before text;
  v_status_after text;
  v_failed boolean := false;
begin
  select status into v_status_before from public.outbound_actions
  where id = '0a000001-0000-4000-8000-000000000001';

  begin
    perform public.panel_approve_outbound_action(
      '0a000001-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '11111111-0000-4000-8000-000000000001');
  exception when others then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'FALHOU T23: aprovacao concluiu apesar da falha de auditoria';
  end if;

  select status into v_status_after from public.outbound_actions
  where id = '0a000001-0000-4000-8000-000000000001';

  if v_status_after is distinct from v_status_before then
    raise exception
      'FALHOU T23: mutacao persistiu sem auditoria (% -> %)',
      v_status_before, v_status_after;
  end if;
  if v_status_after is distinct from 'proposed' then
    raise exception 'FALHOU T23: estado inesperado %', v_status_after;
  end if;

  raise notice 'OK T23 rollback completo da mutacao quando a auditoria falha';
end $$;

drop trigger panel_test_block_audit_trg on public.audit_logs;

-- ============================================================================
-- T24 — após remover o bloqueio, a mesma aprovação funciona normalmente
--        (prova que T23 falhou pela auditoria, não por outro motivo)
-- ============================================================================
do $$
declare v_status text;
begin
  select status into v_status
  from public.panel_approve_outbound_action(
    '0a000001-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000001');

  if v_status is distinct from 'approved' then
    raise exception 'FALHOU T24: status = %', v_status;
  end if;
  raise notice 'OK T24 aprovacao normal apos remover bloqueio de auditoria';
end $$;

-- ============================================================================
-- T25 — panel_list_memberships devolve apenas memberships ativos
-- ============================================================================
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from public.panel_list_memberships('22222222-0000-4000-8000-000000000001');
  if v_n <> 0 then
    raise exception 'FALHOU T25: usuario suspenso listou % memberships', v_n;
  end if;

  select count(*) into v_n
  from public.panel_list_memberships('11111111-0000-4000-8000-000000000001');
  if v_n <> 1 then
    raise exception 'FALHOU T25: reviewer ativo listou % memberships', v_n;
  end if;
  raise notice 'OK T25 memberships ativos filtrados corretamente';
end $$;


-- ============================================================================
-- Nada persiste. ROLLBACK obrigatório.
-- ============================================================================
rollback;
