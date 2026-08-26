-- ============================================================================
-- Migration: add_organization_members
--
-- Vincula usuários do Supabase Auth a organizações, com papel. É a base de
-- autorização do Painel de Aprovação.
--
-- Um usuário PODE pertencer a múltiplas organizações. A unicidade é por
-- (organization_id, user_id), não por user_id — o painel terá uma
-- organização ativa escolhida pelo usuário, e todas as operações informam
-- explicitamente qual é.
--
-- NÃO aplicada remotamente por esta execução.
-- ============================================================================

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete restrict,
  user_id uuid not null
    references auth.users (id) on delete cascade,
  role text not null default 'reviewer'
    check (role in ('reviewer', 'admin')),
  status text not null default 'active'
    check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_org_user_unique unique (organization_id, user_id)
);

comment on table public.organization_members is
  'Vincula um usuário do Supabase Auth a uma organização, com papel. Base de autorização do painel. Um usuário pode pertencer a várias organizações.';
comment on column public.organization_members.role is
  'reviewer: lista, edita mensagem em proposed, aprova e rejeita. admin: tudo de reviewer, mais gestão de membros (não implementada nesta fase).';
comment on column public.organization_members.status is
  'suspended revoga o acesso sem apagar a linha, preservando o histórico do vínculo.';

-- Decisões de FK:
--   organization_id -> ON DELETE RESTRICT, coerente com as demais tabelas:
--     uma organização não some enquanto tiver vínculos.
--   user_id -> ON DELETE CASCADE: se a conta de auth é removida, o vínculo
--     deixa de fazer sentido. O histórico de QUEM fez o quê permanece
--     intacto em audit_logs e em outbound_actions.approved_by/rejected_by,
--     que são text e não FKs — de propósito.

create index idx_organization_members_user_id
  on public.organization_members (user_id);

create index idx_organization_members_organization_id
  on public.organization_members (organization_id);

create trigger set_updated_at_organization_members
  before update on public.organization_members
  for each row
  execute function public.set_updated_at();

alter table public.organization_members enable row level security;

revoke all on table public.organization_members from anon, authenticated;

-- Sem DELETE: desativar um membro é status = 'suspended', não remoção de
-- linha. Isso preserva a auditoria de que o vínculo existiu.
grant select, insert, update on table public.organization_members to service_role;
