-- ============================================================================
-- Migration: add_social_selling_composite_fk_indexes
--
-- Esta migration reflete exatamente o que já foi aplicado no banco remoto
-- (timestamp remoto: 20260825021149). Ela existe para manter o histórico
-- local versionado em sincronia com o estado real do banco.
--
-- Motivo: o PostgreSQL não cria índices automaticamente para as colunas
-- de origem de uma foreign key. As FKs compostas criadas na migration
-- inicial (webhook_events_account_org_fk e processing_jobs_event_org_fk)
-- ficavam sem índice do lado referenciante, o que penaliza tanto a
-- verificação da constraint quanto operações de DELETE na tabela
-- referenciada, que precisam varrer a tabela filha em busca de linhas
-- dependentes.
--
-- Os índices simples já existentes (idx_webhook_events_instagram_account_id
-- e idx_processing_jobs_organization_id) cobrem apenas uma coluna cada, e
-- não substituem um índice sobre o par completo.
-- ============================================================================

create index idx_webhook_events_account_org
  on public.webhook_events (instagram_account_id, organization_id);

create index idx_processing_jobs_event_org
  on public.processing_jobs (webhook_event_id, organization_id);
