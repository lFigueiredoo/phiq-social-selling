-- ============================================================================
-- Migration: harden_social_selling_service_role_privileges
--
-- Esta migration reflete exatamente o que já foi aplicado no banco remoto
-- (timestamp remoto: 20260825021058). Ela existe para manter o histórico
-- local versionado em sincronia com o estado real do banco.
--
-- Objetivo: partir de um estado de privilégios conhecido para o
-- service_role, em vez de depender do que o projeto Supabase concede por
-- padrão. Primeiro revogamos tudo, depois concedemos explicitamente o
-- mínimo necessário.
--
-- Diferença em relação à migration inicial:
--   - o REVOKE ALL agora inclui service_role (antes cobria apenas anon e
--     authenticated), garantindo que os GRANTs abaixo sejam a única
--     origem dos privilégios desse papel;
--   - EXECUTE em public.set_updated_at() passa a ser revogado também de
--     service_role.
-- ============================================================================

revoke all on table
  public.organizations,
  public.instagram_accounts,
  public.webhook_events,
  public.processing_jobs,
  public.audit_logs
from service_role;

grant select, insert, update, delete
  on table
    public.organizations,
    public.instagram_accounts,
    public.webhook_events,
    public.processing_jobs
  to service_role;

-- audit_logs permanece append-only: apenas SELECT e INSERT, sem UPDATE
-- nem DELETE, nem mesmo para o service_role.
grant select, insert
  on table public.audit_logs
  to service_role;

-- A função existe exclusivamente para ser chamada pelos triggers
-- definidos na migration inicial. Nenhum papel precisa de EXECUTE direto
-- sobre ela — nem o service_role. Isso não afeta os triggers: eles são
-- disparados pelo motor de execução de DML, e não por uma chamada de
-- função sujeita à checagem de privilégio EXECUTE de um papel de sessão.
revoke execute on function public.set_updated_at() from service_role;
