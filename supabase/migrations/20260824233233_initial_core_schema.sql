-- ============================================================================
-- Migration: initial_core_schema
-- Escopo: núcleo mínimo do banco (PASSO 02A, com hardening 02A.1 e 02A.2).
--
-- Cria apenas: public.organizations, public.instagram_accounts,
-- public.webhook_events, public.processing_jobs, public.audit_logs.
--
-- Não cria: tabelas de domínio de negócio (leads, comments, messages, etc.),
-- que virão em migrations futuras, quando seus fluxos forem implementados.
--
-- Convenções adotadas nesta migration:
--   - UUID como chave primária, gerado com gen_random_uuid() (função nativa
--     do PostgreSQL 13+, sem necessidade de extensão pgcrypto/uuid-ossp).
--   - timestamptz em todos os campos de data/hora (sempre UTC).
--   - status como TEXT + CHECK constraint em vez de ENUM nativo do
--     PostgreSQL, para facilitar evolução futura (adicionar um novo valor
--     de status é um ALTER TABLE simples, sem as restrições de transação
--     que ALTER TYPE ... ADD VALUE impõe em versões mais antigas do PG).
--   - Nenhuma credencial, token ou segredo é armazenado nesta migration.
--   - Todos os objetos são schema-qualificados com "public." explicitamente
--     (CREATE TABLE, REFERENCES, CREATE INDEX, ALTER TABLE, REVOKE, GRANT,
--     TRIGGERS, COMMENTS), para não depender do search_path da sessão que
--     aplica a migration.
--   - Fail-fast: nenhum CREATE TABLE / CREATE INDEX usa IF NOT EXISTS.
--     Este é um projeto novo; se algum objeto já existir com este nome
--     durante a aplicação da migration, preferimos que ela FALHE e revele
--     o drift, em vez de mascarar silenciosamente uma estrutura
--     pré-existente incorreta.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. public.organizations
--    Raiz de isolamento multiempresa. Toda entidade de negócio referenciará
--    organization_id, direta ou indiretamente.
-- ----------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text,
  status      text not null default 'active'
                check (status in ('active', 'inactive', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint organizations_slug_unique unique (slug)
);

comment on table public.organizations is
  'Raiz de isolamento multiempresa. Cada organização representa uma empresa/cliente do sistema.';
comment on column public.organizations.slug is
  'Identificador amigável opcional (ex.: para URLs). Único quando presente; múltiplas organizações podem ter slug NULL.';


-- ----------------------------------------------------------------------------
-- 2. public.instagram_accounts
--    Representa uma conta profissional do Instagram conectada a uma
--    organização. NÃO armazena credenciais/tokens em texto puro — isso será
--    tratado por um mecanismo de secrets em passo futuro.
-- ----------------------------------------------------------------------------
create table public.instagram_accounts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null
                       references public.organizations (id)
                       on delete restrict,
  external_id        text not null,
  username           text,
  status             text not null default 'pending'
                       check (status in ('pending', 'active', 'disconnected', 'error')),
  token_expires_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Unicidade GLOBAL (não por organização). O identificador da Meta
  -- (external_id) é globalmente único no sistema: uma conta Instagram não
  -- pode pertencer simultaneamente a duas organizações. Isso também é o
  -- que permite ao webhook resolver a conta pelo external_id ANTES de
  -- saber a qual organização ela pertence.
  constraint instagram_accounts_external_id_unique unique (external_id),

  -- Constraint composta (id, organization_id) — não introduz uma nova
  -- regra de negócio (id já é PK, portanto já é único sozinho); existe
  -- exclusivamente para servir de alvo de uma FK composta a partir de
  -- webhook_events, permitindo ao banco impedir que um evento aponte
  -- para uma conta cuja organização real seja diferente da organização
  -- informada no próprio evento.
  constraint instagram_accounts_id_org_unique unique (id, organization_id)
);

comment on table public.instagram_accounts is
  'Conta Instagram Business/Creator conectada a uma organização. Não contém tokens/credenciais.';
comment on column public.instagram_accounts.external_id is
  'Identificador da conta Instagram na Meta (IG User ID). Globalmente único no sistema — uma conta não pode pertencer a duas organizações ao mesmo tempo. É a referência estável; username pode mudar.';
comment on column public.instagram_accounts.token_expires_at is
  'Apenas metadado de expiração para orientar renovação. O token em si fica em um mecanismo de secrets, fora desta tabela.';

-- Decisão de FK (organizations -> instagram_accounts): ON DELETE RESTRICT.
-- Organizações não devem ser removidas fisicamente enquanto possuírem
-- contas conectadas; a remoção de uma organização deve ser uma decisão
-- explícita e tratada (ex.: desconectar contas primeiro), nunca um efeito
-- colateral silencioso de uma exclusão em cascata.


-- ----------------------------------------------------------------------------
-- 3. public.webhook_events
--    Armazena o evento bruto recebido da Meta antes de qualquer
--    processamento. É a base da idempotência de entrada.
-- ----------------------------------------------------------------------------
create table public.webhook_events (
  id                     uuid primary key default gen_random_uuid(),

  -- Nullable de propósito: a Edge Function deve conseguir persistir o
  -- evento bruto mesmo antes de resolver a qual organização/conta ele
  -- pertence. A resolução pode ocorrer em um passo posterior de
  -- enriquecimento, sem bloquear a persistência inicial rápida.
  organization_id        uuid
                           references public.organizations (id)
                           on delete set null,
  instagram_account_id   uuid
                           references public.instagram_accounts (id)
                           on delete set null,

  provider               text not null default 'meta',
  object_type            text not null,
  event_type             text not null,

  external_object_id     text,

  -- Gerada pela aplicação a partir de atributos ESTÁVEIS do evento da Meta
  -- (ex.: provider + identificador externo da conta + event_type +
  -- external_object_id + outro identificador estável presente no payload),
  -- já que a Meta não garante um event_id global único em todos os tipos
  -- de webhook. NUNCA deve ser composta usando received_at, created_at ou
  -- qualquer timestamp gerado pelo nosso servidor. A fórmula exata
  -- (incluindo hash/canonicalização) será definida no PASSO 06/07, com
  -- payloads reais em mãos — ver docs/database.md.
  idempotency_key        text not null,

  payload                jsonb not null,

  status                 text not null default 'received'
                           check (status in (
                             'received', 'queued', 'processing',
                             'processed', 'failed', 'dead_letter'
                           )),

  received_at            timestamptz not null default now(),
  processed_at           timestamptz,
  processing_attempts    integer not null default 0
                           check (processing_attempts >= 0),
  last_error             text,

  created_at             timestamptz not null default now(),

  constraint webhook_events_idempotency_key_unique unique (idempotency_key),

  -- Constraint composta (id, organization_id) — mesma finalidade da
  -- equivalente em instagram_accounts: serve de alvo para a FK composta
  -- de processing_jobs, garantindo que um job nunca tenha organization_id
  -- diferente do organization_id do seu próprio webhook_event.
  constraint webhook_events_id_org_unique unique (id, organization_id),

  -- Integridade multitenant: se organization_id e instagram_account_id
  -- estiverem AMBOS preenchidos, eles precisam corresponder a uma linha
  -- real de instagram_accounts em que aquela conta pertence àquela
  -- organização. Isso impede, por construção no banco, que um evento
  -- registre organization_id = organização A ao mesmo tempo que
  -- instagram_account_id aponta para uma conta da organização B.
  --
  -- MATCH SIMPLE (comportamento padrão do PostgreSQL, não precisa ser
  -- escrito explicitamente) permite que QUALQUER uma das colunas da FK
  -- composta seja NULL — nesse caso a constraint é considerada satisfeita
  -- e não é verificada. Isso é exatamente o que precisamos no estágio
  -- inicial de ingestão, quando a Edge Function pode persistir o evento
  -- antes de resolver conta/organização. A verificação só passa a valer
  -- quando AMBAS as colunas estão preenchidas.
  --
  -- Esta FK composta NÃO substitui a FK simples de instagram_account_id
  -- definida acima — as duas protegem invariantes diferentes: a simples
  -- garante que instagram_account_id (quando preenchido) referencia uma
  -- conta que existe; a composta garante que, quando ambos os campos
  -- estão preenchidos, a conta pertence à organização informada.
  constraint webhook_events_account_org_fk
    foreign key (instagram_account_id, organization_id)
    references public.instagram_accounts (id, organization_id)
);

comment on table public.webhook_events is
  'Evento bruto recebido de um webhook da Meta, antes de qualquer processamento. Fonte de idempotência de entrada.';
comment on column public.webhook_events.idempotency_key is
  'Chave de idempotência calculada pela aplicação a partir de atributos ESTÁVEIS do evento da Meta (nunca a partir de received_at/created_at ou de qualquer timestamp gerado pelo nosso servidor). A fórmula exata de composição/hash será definida no PASSO 06/07, com payloads reais da Meta em mãos. Ver docs/database.md.';
comment on column public.webhook_events.payload is
  'Payload bruto do webhook, preservado integralmente para auditoria e reprocessamento.';
comment on constraint webhook_events_account_org_fk on public.webhook_events is
  'Garante integridade multitenant: quando organization_id e instagram_account_id estão ambos preenchidos, a conta precisa realmente pertencer àquela organização. NULL em qualquer um dos dois lados é permitido (MATCH SIMPLE) durante o estágio inicial de ingestão. Não substitui a FK simples de instagram_account_id — protege um invariante diferente (consistência multitenant, não existência da conta).';

-- Decisão de FK (organizations/instagram_accounts -> webhook_events):
-- ON DELETE SET NULL nas FKs simples. Este é um log de entrada; ele nunca
-- deve ser apagado silenciosamente por uma cascata. Se a organização ou
-- conta for removida, o evento histórico permanece, apenas perde a
-- referência.
--
-- Comportamento de DELETE a testar no PASSO 02B (banco real), sem tentar
-- adivinhar a resposta aqui:
--   A) apagar uma instagram_account sem nenhum webhook_event associado;
--   B) apagar uma instagram_account referenciada por webhook_event;
--   C) confirmar que instagram_account_id vira NULL (efeito da FK simples
--      SET NULL) na linha de webhook_events afetada;
--   D) confirmar que organization_id permanece intacto nessa mesma linha
--      (a organização não foi removida, só a conta);
--   E) confirmar que, após o SET NULL, a FK composta
--      webhook_events_account_org_fk continua satisfeita (uma vez que
--      instagram_account_id passou a ser NULL, MATCH SIMPLE deixa de
--      exigir correspondência).
-- Ver "Testes obrigatórios na aplicação da primeira migration" em
-- docs/database.md.


-- ----------------------------------------------------------------------------
-- 4. public.processing_jobs
--    Fila persistente simples em PostgreSQL. Não há worker implementado
--    neste passo — apenas a estrutura da fila.
-- ----------------------------------------------------------------------------
create table public.processing_jobs (
  id                 uuid primary key default gen_random_uuid(),

  -- Denormalizado a partir de webhook_events.organization_id para permitir
  -- filtragem/RLS por organização sem precisar de join na fila.
  organization_id    uuid
                       references public.organizations (id)
                       on delete set null,

  webhook_event_id   uuid not null,

  job_type           text not null,

  status             text not null default 'pending'
                       check (status in (
                         'pending', 'processing', 'completed', 'failed', 'dead_letter'
                       )),

  priority           smallint not null default 0,
  available_at       timestamptz not null default now(),

  locked_at          timestamptz,
  locked_by          text,

  attempts           integer not null default 0
                       check (attempts >= 0),
  max_attempts       integer not null default 5
                       check (max_attempts > 0),
  last_error         text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,

  -- Evita dois jobs equivalentes para o mesmo evento (mesmo tipo de
  -- trabalho sobre o mesmo webhook_event não deve ser enfileirado duas
  -- vezes).
  constraint processing_jobs_event_type_unique unique (webhook_event_id, job_type),

  -- Corrigido no PASSO 02A.2: a FK composta abaixo sozinha NÃO é
  -- suficiente. Como ela usa MATCH SIMPLE, quando organization_id é NULL
  -- a FK composta simplesmente não é avaliada — o que abriria uma brecha
  -- real: seria possível inserir um processing_job com webhook_event_id
  -- apontando para um UUID que não existe em webhook_events, desde que
  -- organization_id fosse NULL. Por isso mantemos DUAS constraints
  -- separadas, cada uma protegendo um invariante diferente:
  --
  --   (1) processing_jobs_webhook_event_fk (FK simples) — garante que
  --       webhook_event_id SEMPRE referencia uma linha existente em
  --       webhook_events, independentemente do valor de organization_id.
  --       É esta constraint que efetivamente impõe RESTRICT sobre a
  --       exclusão de um webhook_event ainda referenciado.
  --
  --   (2) processing_jobs_event_org_fk (FK composta) — garante que,
  --       QUANDO organization_id estiver preenchido, ele corresponda ao
  --       organization_id real daquele mesmo webhook_event. Com MATCH
  --       SIMPLE, se organization_id for NULL esta constraint não é
  --       avaliada — mas isso já não é um problema, porque a existência
  --       do webhook_event já está garantida pela constraint (1).
  --
  -- As duas constraints NÃO são redundantes: cada uma cobre um caso que a
  -- outra sozinha deixaria passar.
  constraint processing_jobs_webhook_event_fk
    foreign key (webhook_event_id)
    references public.webhook_events (id)
    on delete restrict,

  -- Sem ON DELETE explícito aqui de propósito (equivale a NO ACTION, o
  -- padrão do PostgreSQL): a responsabilidade de bloquear a exclusão de
  -- um webhook_event referenciado já pertence inteiramente à constraint
  -- (1) acima (RESTRICT). Definir também RESTRICT aqui seria redundante
  -- e definir qualquer outra ação (ex.: SET NULL) poderia entrar em
  -- conflito com o RESTRICT da constraint (1), que sempre dispararia
  -- primeiro impedindo a exclusão de qualquer forma.
  constraint processing_jobs_event_org_fk
    foreign key (webhook_event_id, organization_id)
    references public.webhook_events (id, organization_id)
);

comment on table public.processing_jobs is
  'Fila persistente em PostgreSQL para processamento assíncrono dos eventos recebidos. Sem worker implementado ainda.';
comment on column public.processing_jobs.priority is
  'Maior valor = maior prioridade. Usado em conjunto com created_at para ordenar o consumo da fila.';
comment on constraint processing_jobs_webhook_event_fk on public.processing_jobs is
  'Garante que webhook_event_id sempre referencia uma linha existente em webhook_events, independentemente de organization_id. Responsável pelo RESTRICT de exclusão.';
comment on constraint processing_jobs_event_org_fk on public.processing_jobs is
  'Garante que organization_id (quando preenchido) seja sempre o mesmo organization_id do webhook_event de origem — impede um job de "tenant cruzado". Não substitui processing_jobs_webhook_event_fk: com organization_id NULL, esta constraint não avalia nada, mas a existência do evento já está garantida pela outra.';

-- Decisão de FK (webhook_events -> processing_jobs): ON DELETE RESTRICT,
-- imposto pela constraint (1) processing_jobs_webhook_event_fk. Um job
-- não faz sentido sem seu evento de origem; bloqueamos a exclusão do
-- webhook_event enquanto existir um job associado, em vez de apagar o
-- job silenciosamente ou deixá-lo órfão.


-- ----------------------------------------------------------------------------
-- 5. public.audit_logs
--    Log de auditoria, conceitualmente append-only. Nenhum mecanismo de
--    update/delete automático é criado.
-- ----------------------------------------------------------------------------
create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  organization_id uuid
                    references public.organizations (id)
                    on delete set null,

  actor_type     text not null
                    check (actor_type in ('system', 'user', 'ai', 'automation')),
  actor_id       text,

  action         text not null,
  entity_type    text not null,
  entity_id      text,

  metadata       jsonb not null default '{}'::jsonb,

  created_at     timestamptz not null default now()
);

comment on table public.audit_logs is
  'Log de auditoria append-only. Nenhum trigger de update/delete é criado para esta tabela.';

-- Decisão de FK (organizations -> audit_logs): ON DELETE SET NULL, pelo
-- mesmo motivo de webhook_events: um log de auditoria não deve desaparecer
-- porque a organização à qual se referia foi removida.
--
-- Proteção append-only: neste estágio, apenas o service_role tem qualquer
-- acesso a esta tabela (ver seção de GRANT/REVOKE abaixo), e o
-- service_role é controlado exclusivamente pelo nosso próprio backend.
-- Por isso nenhum trigger bloqueando UPDATE/DELETE é criado agora — seria
-- proteção contra um cenário (múltiplos papéis de backend com acessos
-- diferentes) que ainda não existe. Isso deverá ser reforçado com um
-- trigger explícito quando outros papéis de backend existirem.


-- ============================================================================
-- Função utilitária: public.set_updated_at()
--
-- Evita repetir a lógica de atualização de updated_at em toda a aplicação.
--
-- Decisões de segurança:
--   - Sem "OR REPLACE": esta é a migration inicial: se a função já existir
--     por algum motivo, queremos que a migration falhe (fail-fast) em vez
--     de substituir silenciosamente algo que já estava lá.
--   - search_path fixado vazio (exige qualificação total de qualquer
--     objeto referenciado dentro da função — não há nenhum aqui, mas o
--     padrão é mantido por segurança e consistência).
--   - SECURITY INVOKER (padrão — não usamos SECURITY DEFINER, pois a
--     função só manipula a própria linha sendo inserida/atualizada, sem
--     acessar outras tabelas nem exigir privilégios elevados).
--   - EXECUTE é revogado de PUBLIC/anon/authenticated logo abaixo: esta
--     função existe exclusivamente para ser chamada pelos triggers
--     definidos nesta mesma migration, nunca para ser invocada
--     diretamente por um papel de aplicação.
-- ============================================================================
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

comment on function public.set_updated_at() is
  'Trigger genérica que atualiza updated_at = now() antes de qualquer UPDATE. Aplicada apenas às tabelas que possuem a coluna updated_at. EXECUTE revogado de PUBLIC/anon/authenticated — uso exclusivo dos triggers desta migration.';

-- Revoga a permissão de execução direta que o PostgreSQL concede a PUBLIC
-- por padrão na criação de uma função. Isso não afeta o funcionamento dos
-- triggers abaixo: um trigger é disparado automaticamente pelo motor de
-- execução de DML, não por uma chamada de função sujeita à checagem de
-- privilégio EXECUTE de um papel de sessão.
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;

-- Triggers aplicadas somente onde a coluna updated_at existe:
create trigger set_updated_at_organizations
  before update on public.organizations
  for each row
  execute function public.set_updated_at();

create trigger set_updated_at_instagram_accounts
  before update on public.instagram_accounts
  for each row
  execute function public.set_updated_at();

create trigger set_updated_at_processing_jobs
  before update on public.processing_jobs
  for each row
  execute function public.set_updated_at();

-- webhook_events e audit_logs não recebem este trigger:
--   - webhook_events usa processed_at para marcar progresso, não updated_at;
--   - audit_logs é conceitualmente append-only e não deveria ser atualizado.


-- ============================================================================
-- Índices
--
-- Criados apenas para: foreign keys relevantes que ainda não possuem
-- índice implícito via UNIQUE (o PostgreSQL não indexa FKs
-- automaticamente), e a consulta de fila descrita no PASSO 02A
-- (status = 'pending' AND available_at <= now() ORDER BY priority DESC,
-- created_at ASC). idempotency_key e external_id já têm índice implícito
-- vindo das respectivas constraints UNIQUE, então não repetimos aqui.
--
-- Fail-fast: sem IF NOT EXISTS — se algum destes índices já existir, a
-- migration deve falhar em vez de mascarar o drift.
-- ============================================================================

-- instagram_accounts
create index idx_instagram_accounts_organization_id
  on public.instagram_accounts (organization_id);

-- Nenhum índice adicional para external_id: a constraint
-- instagram_accounts_external_id_unique já cria implicitamente um índice
-- único sobre essa coluna, que atende tanto a regra de unicidade quanto
-- a busca da conta pelo identificador da Meta durante o processamento de
-- um webhook. Um índice extra aqui seria redundante.

-- webhook_events
create index idx_webhook_events_organization_id
  on public.webhook_events (organization_id);

create index idx_webhook_events_instagram_account_id
  on public.webhook_events (instagram_account_id);

create index idx_webhook_events_status
  on public.webhook_events (status);

-- processing_jobs
create index idx_processing_jobs_organization_id
  on public.processing_jobs (organization_id);

-- Índice composto para a consulta de consumo da fila:
--   WHERE status = 'pending' AND available_at <= now()
--   ORDER BY priority DESC, created_at ASC
-- Não é um índice parcial porque now() não é uma expressão IMMUTABLE
-- (não pode compor o predicado de um índice parcial); em vez disso,
-- available_at entra como coluna do próprio índice.
create index idx_processing_jobs_queue
  on public.processing_jobs (status, available_at, priority desc, created_at asc);

-- audit_logs
create index idx_audit_logs_organization_id
  on public.audit_logs (organization_id);

create index idx_audit_logs_entity
  on public.audit_logs (entity_type, entity_id);


-- ============================================================================
-- Row Level Security (RLS) e privilégios
--
-- RLS habilitada em todas as tabelas com dados de negócio/isolamento por
-- organização. Nenhuma policy é criada neste passo, propositalmente:
-- ainda não existe autenticação de usuários no dashboard, e criar
-- policies agora exigiria decisões (ex.: USING (true)) que dariam uma
-- falsa sensação de segurança.
--
-- RLS e GRANT são controles DISTINTOS e este passo trata os dois
-- explicitamente, sem depender dos privilégios default do projeto
-- Supabase:
--   1. REVOKE ALL de anon/authenticated — nenhum desses papéis deve ter
--      qualquer privilégio de tabela nestas cinco tabelas.
--   2. RLS habilitada — mesmo que algum privilégio de tabela existisse,
--      RLS sem policy nega tudo a anon/authenticated de qualquer forma.
--   3. GRANT explícito e mínimo ao service_role — SELECT, INSERT,
--      UPDATE, DELETE nas quatro tabelas operacionais. TRUNCATE,
--      REFERENCES e TRIGGER não são concedidos por não serem necessários
--      na operação normal do backend neste estágio (TRUNCATE apagaria
--      dados em massa sem passar por regras de aplicação; REFERENCES e
--      TRIGGER permitiriam ao papel criar novas constraints/triggers
--      nestas tabelas, o que não é uma operação esperada em tempo de
--      execução). audit_logs recebe um GRANT à parte, somente SELECT e
--      INSERT — reforçando no nível de privilégio, e não apenas de
--      convenção, que é append-only mesmo para o service_role.
--   4. service_role, por padrão no Supabase, IGNORA RLS independente
--      destes GRANTs — mas os GRANTs continuam sendo a camada de defesa
--      caso essa premissa do Supabase mude ou seja mal configurada.
--
-- Policies reais (baseadas em usuário autenticado e sua organização)
-- serão desenhadas quando a autenticação do dashboard for implementada
-- (fase do MVP 3).
-- ============================================================================

alter table public.organizations       enable row level security;
alter table public.instagram_accounts  enable row level security;
alter table public.webhook_events      enable row level security;
alter table public.processing_jobs     enable row level security;
alter table public.audit_logs          enable row level security;

revoke all on table public.organizations       from anon, authenticated;
revoke all on table public.instagram_accounts  from anon, authenticated;
revoke all on table public.webhook_events      from anon, authenticated;
revoke all on table public.processing_jobs     from anon, authenticated;
revoke all on table public.audit_logs          from anon, authenticated;

-- audit_logs recebe um GRANT separado e mais restrito: apenas SELECT e
-- INSERT. Isso reforça, também no nível de privilégio (não só de
-- convenção), que audit_logs é append-only para o service_role — nem o
-- próprio backend pode UPDATE ou DELETE linhas de auditoria através do
-- caminho normal de acesso ao banco.
grant select, insert, update, delete
  on table
    public.organizations,
    public.instagram_accounts,
    public.webhook_events,
    public.processing_jobs
  to service_role;

grant select, insert
  on table public.audit_logs
  to service_role;
