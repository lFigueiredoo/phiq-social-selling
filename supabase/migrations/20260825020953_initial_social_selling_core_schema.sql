create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_unique unique (slug)
);

comment on table public.organizations is 'Raiz de isolamento multiempresa. Cada organização representa uma empresa/cliente do sistema.';
comment on column public.organizations.slug is 'Identificador amigável opcional (ex.: para URLs). Único quando presente; múltiplas organizações podem ter slug NULL.';

create table public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  external_id text not null,
  username text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disconnected', 'error')),
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_accounts_external_id_unique unique (external_id),
  constraint instagram_accounts_id_org_unique unique (id, organization_id)
);

comment on table public.instagram_accounts is 'Conta Instagram Business/Creator conectada a uma organização. Não contém tokens/credenciais.';
comment on column public.instagram_accounts.external_id is 'Identificador da conta Instagram na Meta (IG User ID). Globalmente único no sistema — uma conta não pode pertencer a duas organizações ao mesmo tempo. É a referência estável; username pode mudar.';
comment on column public.instagram_accounts.token_expires_at is 'Apenas metadado de expiração para orientar renovação. O token em si fica em um mecanismo de secrets, fora desta tabela.';

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  instagram_account_id uuid references public.instagram_accounts (id) on delete set null,
  provider text not null default 'meta',
  object_type text not null,
  event_type text not null,
  external_object_id text,
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'queued', 'processing', 'processed', 'failed', 'dead_letter')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  constraint webhook_events_idempotency_key_unique unique (idempotency_key),
  constraint webhook_events_id_org_unique unique (id, organization_id),
  constraint webhook_events_account_org_fk foreign key (instagram_account_id, organization_id) references public.instagram_accounts (id, organization_id)
);

comment on table public.webhook_events is 'Evento bruto recebido de um webhook da Meta, antes de qualquer processamento. Fonte de idempotência de entrada.';
comment on column public.webhook_events.idempotency_key is 'Chave de idempotência calculada pela aplicação a partir de atributos ESTÁVEIS do evento da Meta (nunca a partir de received_at/created_at ou de qualquer timestamp gerado pelo nosso servidor). A fórmula exata de composição/hash será definida no PASSO 06/07, com payloads reais da Meta em mãos. Ver docs/database.md.';
comment on column public.webhook_events.payload is 'Payload bruto do webhook, preservado integralmente para auditoria e reprocessamento.';
comment on constraint webhook_events_account_org_fk on public.webhook_events is 'Garante integridade multitenant: quando organization_id e instagram_account_id estão ambos preenchidos, a conta precisa realmente pertencer àquela organização. NULL em qualquer um dos dois lados é permitido (MATCH SIMPLE) durante o estágio inicial de ingestão. Não substitui a FK simples de instagram_account_id — protege um invariante diferente (consistência multitenant, não existência da conta).';

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  webhook_event_id uuid not null,
  job_type text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  priority smallint not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint processing_jobs_event_type_unique unique (webhook_event_id, job_type),
  constraint processing_jobs_webhook_event_fk foreign key (webhook_event_id) references public.webhook_events (id) on delete restrict,
  constraint processing_jobs_event_org_fk foreign key (webhook_event_id, organization_id) references public.webhook_events (id, organization_id)
);

comment on table public.processing_jobs is 'Fila persistente em PostgreSQL para processamento assíncrono dos eventos recebidos. Sem worker implementado ainda.';
comment on column public.processing_jobs.priority is 'Maior valor = maior prioridade. Usado em conjunto com created_at para ordenar o consumo da fila.';
comment on constraint processing_jobs_webhook_event_fk on public.processing_jobs is 'Garante que webhook_event_id sempre referencia uma linha existente em webhook_events, independentemente de organization_id. Responsável pelo RESTRICT de exclusão.';
comment on constraint processing_jobs_event_org_fk on public.processing_jobs is 'Garante que organization_id (quando preenchido) seja sempre o mesmo organization_id do webhook_event de origem — impede um job de tenant cruzado. Não substitui processing_jobs_webhook_event_fk: com organization_id NULL, esta constraint não avalia nada, mas a existência do evento já está garantida pela outra.';

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  actor_type text not null check (actor_type in ('system', 'user', 'ai', 'automation')),
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is 'Log de auditoria append-only. Nenhum trigger de update/delete é criado para esta tabela.';

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is 'Trigger genérica que atualiza updated_at = now() antes de qualquer UPDATE. Aplicada apenas às tabelas que possuem a coluna updated_at. EXECUTE revogado de PUBLIC/anon/authenticated — uso exclusivo dos triggers desta migration.';

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;

create trigger set_updated_at_organizations before update on public.organizations for each row execute function public.set_updated_at();
create trigger set_updated_at_instagram_accounts before update on public.instagram_accounts for each row execute function public.set_updated_at();
create trigger set_updated_at_processing_jobs before update on public.processing_jobs for each row execute function public.set_updated_at();

create index idx_instagram_accounts_organization_id on public.instagram_accounts (organization_id);
create index idx_webhook_events_organization_id on public.webhook_events (organization_id);
create index idx_webhook_events_instagram_account_id on public.webhook_events (instagram_account_id);
create index idx_webhook_events_status on public.webhook_events (status);
create index idx_processing_jobs_organization_id on public.processing_jobs (organization_id);
create index idx_processing_jobs_queue on public.processing_jobs (status, available_at, priority desc, created_at asc);
create index idx_audit_logs_organization_id on public.audit_logs (organization_id);
create index idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);

alter table public.organizations enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.webhook_events enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.audit_logs enable row level security;

revoke all on table public.organizations from anon, authenticated;
revoke all on table public.instagram_accounts from anon, authenticated;
revoke all on table public.webhook_events from anon, authenticated;
revoke all on table public.processing_jobs from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;

grant select, insert, update, delete on table public.organizations, public.instagram_accounts, public.webhook_events, public.processing_jobs to service_role;
grant select, insert on table public.audit_logs to service_role;
