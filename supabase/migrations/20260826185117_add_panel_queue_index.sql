-- ============================================================================
-- Migration: add_panel_queue_index
--
-- Suporte à listagem paginada da fila do painel.
--
-- O índice existente idx_outbound_actions_status é (status, created_at) e
-- não cobre organization_id, que é o PRIMEIRO predicado de toda consulta do
-- painel (isolamento multi-tenant). Sem este índice, cada página da fila
-- faria varredura filtrando por organização depois.
--
-- Não é índice parcial: o painel também consulta outros status ao exibir
-- histórico/resultado de uma ação recém-decidida, e um predicado parcial em
-- status = 'proposed' deixaria essas consultas descobertas.
--
-- NÃO aplicada remotamente por esta execução.
-- ============================================================================

create index idx_outbound_actions_panel_queue
  on public.outbound_actions (organization_id, status, created_at desc);
