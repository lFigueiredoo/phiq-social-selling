# Banco de Dados — Núcleo Mínimo (PASSO 02A, com hardening 02A.1 e 02A.2)

Este documento descreve o schema criado na migration
`supabase/migrations/20260824233233_initial_core_schema.sql`, já
incluindo o hardening de integridade multitenant do PASSO 02A.1 e o
hardening final de FKs/segurança/schema-qualification do PASSO 02A.2.
Será expandido a cada nova migration.

> Status: schema **aplicado e validado em banco real** (PASSO 02B
> concluído). Ver a seção "Aplicação e validação em banco real" ao final
> deste documento para o registro completo do que foi executado,
> incluindo as duas migrations de hardening aplicadas depois da inicial.

## Diagrama de relacionamento

```
public.organizations
     │
     └── public.instagram_accounts
              │
              └── public.webhook_events
                       │
                       └── public.processing_jobs

public.organizations
     │
     └── public.audit_logs
```

`webhook_events` e `processing_jobs` também guardam `organization_id`
diretamente (denormalizado), para permitir filtragem por organização sem
depender de join — importante tanto para performance quanto para uma
futura política de RLS por organização.

Essa denormalização é reforçada por FKs compostas que impedem, no
próprio banco, que o `organization_id` denormalizado diverja do
`organization_id` real da entidade-pai (ver seção "Integridade
multitenant" abaixo). Sem essas FKs, nada impediria essa divergência
além de disciplina na camada de aplicação.

## Convenções gerais desta migration

- Todos os objetos são **schema-qualificados** com `public.` de forma
  explícita — `CREATE TABLE`, `REFERENCES`, `CREATE INDEX`, `ALTER
  TABLE`, `REVOKE`, `GRANT`, `TRIGGER`, `COMMENT` — para não depender do
  `search_path` da sessão que aplica a migration.
- **Fail-fast:** nenhum `CREATE TABLE` ou `CREATE INDEX` usa `IF NOT
  EXISTS`. Este é um projeto novo; se algum objeto já existir com esse
  nome ao aplicar a migration, ela deve **falhar** e revelar o drift, em
  vez de mascarar silenciosamente uma estrutura pré-existente incorreta.
- A função `set_updated_at()` é criada com `CREATE FUNCTION` (sem `OR
  REPLACE`) pelo mesmo motivo.

## Tabelas

### public.organizations
Raiz de isolamento multiempresa. Toda entidade de negócio se conecta a
ela, direta ou indiretamente.

- **PK:** `id` (UUID)
- **UNIQUE:** `slug` (permite múltiplos `NULL`, já que nem toda
  organização precisa de slug ainda)
- **Campos:** `name`, `slug`, `status` (`active` / `inactive` /
  `suspended`), `created_at`, `updated_at`
- **DELETE:** não há FK apontando *para fora* desta tabela; ela é a raiz.

### public.instagram_accounts
Conta Instagram Business/Creator conectada a uma organização. **Não**
armazena tokens — apenas metadado de expiração (`token_expires_at`) para
orientar renovação futura via mecanismo de secrets.

- **PK:** `id` (UUID)
- **FK:** `organization_id → organizations.id`, `ON DELETE RESTRICT`
- **UNIQUE:** `external_id` — **global**, não por organização (ver
  decisão abaixo). O próprio `UNIQUE` já fornece o índice necessário
  para resolver a conta pelo identificador da Meta; nenhum índice
  adicional é criado para essa coluna.
- **UNIQUE técnica:** `(id, organization_id)` — não é uma regra de
  negócio nova (`id` já é PK, portanto já é único sozinho); existe
  exclusivamente para servir de alvo de uma FK composta a partir de
  `webhook_events` (ver seção "Integridade multitenant" abaixo).

> **Decisão (PASSO 02A.1):** *Instagram external ID é globalmente único
> no sistema e uma conta não pode pertencer simultaneamente a duas
> organizações.* A constraint original era `UNIQUE(organization_id,
> external_id)`, que permitiria — incorretamente — a mesma conta do
> Instagram ser cadastrada em duas organizações diferentes, e também era
> insuficiente para o caso de uso real do webhook, que resolve a conta
> pelo `external_id` antes de saber a organização.

### public.webhook_events
Evento bruto recebido de um webhook da Meta, antes de qualquer
processamento. É a tabela central da idempotência de entrada.

- **PK:** `id` (UUID)
- **FK simples:** `organization_id → organizations.id` (nullable, `SET
  NULL`), `instagram_account_id → instagram_accounts.id` (nullable,
  `SET NULL`)
- **FK composta (multitenant):** `(instagram_account_id,
  organization_id) → instagram_accounts (id, organization_id)` — ver
  seção "Integridade multitenant" abaixo
- **UNIQUE:** `idempotency_key` — calculada pela aplicação a partir de
  atributos estáveis do payload (não presumimos um `event_id` global
  único fornecido pela Meta)
- **UNIQUE técnica:** `(id, organization_id)` — mesma finalidade da
  equivalente em `instagram_accounts`: serve de alvo para a FK composta
  de `processing_jobs`
- **Campos de controle:** `status` (`received` → `queued` →
  `processing` → `processed` / `failed` / `dead_letter`),
  `processing_attempts` (`CHECK >= 0`), `last_error`, `received_at`,
  `processed_at`

`organization_id` e `instagram_account_id` são **nullable de propósito**:
a Edge Function deve conseguir persistir o payload bruto rapidamente
mesmo antes de resolver a qual conta/organização ele pertence — essa
resolução pode acontecer como um enriquecimento posterior, sem bloquear
a gravação inicial.

### public.processing_jobs
Fila persistente simples em PostgreSQL (sem pgmq, sem Redis, sem
LISTEN/NOTIFY neste passo — apenas a estrutura de tabela).

- **PK:** `id` (UUID)
- **FK simples:** `organization_id → organizations.id` (nullable,
  denormalizado, `SET NULL`)
- **Duas FKs sobre `webhook_event_id`/`organization_id`** (ver seção
  "Duas FKs em processing_jobs" abaixo — correção do PASSO 02A.2)
- **UNIQUE:** `(webhook_event_id, job_type)` — evita dois jobs
  equivalentes para o mesmo evento
- **Campos de controle de fila:** `status` (`pending` / `processing` /
  `completed` / `failed` / `dead_letter`), `priority`, `available_at`,
  `locked_at`, `locked_by`, `attempts` (`CHECK >= 0`), `max_attempts`
  (`CHECK > 0`), `last_error`

### public.audit_logs
Log de auditoria, conceitualmente **append-only**. Nenhum trigger de
update/delete é criado.

- **PK:** `id` (UUID)
- **FK:** `organization_id → organizations.id` (nullable, `SET NULL`)
- **Campos:** `actor_type` (`system` / `user` / `ai` / `automation`),
  `actor_id`, `action`, `entity_type`, `entity_id`, `metadata` (JSONB)

## Integridade multitenant

Antes do PASSO 02A.1, nada impedia (no nível de banco) que um
`webhook_event` fosse gravado com `organization_id` = organização A e
`instagram_account_id` apontando para uma conta que na verdade pertence
à organização B. Isso seria uma falha grave de isolamento multiempresa.

**Solução adotada:** FK composta em vez de trigger.

```sql
-- em instagram_accounts:
constraint instagram_accounts_id_org_unique unique (id, organization_id)

-- em webhook_events:
constraint webhook_events_account_org_fk
  foreign key (instagram_account_id, organization_id)
  references public.instagram_accounts (id, organization_id)
```

Isso funciona porque o PostgreSQL, ao validar uma FK composta, usa
**MATCH SIMPLE** por padrão: se **qualquer uma** das colunas da FK for
`NULL`, a linha é considerada automaticamente válida e a constraint não
é verificada. Quando **ambas** as colunas estão preenchidas, o banco
exige que exista uma linha em `instagram_accounts` com exatamente
aquele `id` **e** aquele `organization_id` juntos — ou seja, a conta
precisa realmente pertencer à organização informada.

Isso cobre exatamente os três cenários que precisávamos:
1. Estágio inicial de ingestão, com `organization_id` e/ou
   `instagram_account_id` ainda `NULL` → permitido, constraint não avalia.
2. Evento correto, conta pertence de fato à organização informada →
   permitido, constraint valida com sucesso.
3. Evento malformado/cruzado, conta pertence a outra organização →
   **rejeitado pelo banco**, com erro de violação de FK.

**Importante:** esta FK composta **não substitui** a FK simples
`instagram_account_id → instagram_accounts.id` definida na mesma tabela
— as duas protegem invariantes diferentes. A simples garante que
`instagram_account_id`, quando preenchido, referencia uma conta que
realmente existe. A composta garante que, quando ambos os campos estão
preenchidos, a conta pertence à organização informada. Manter as duas
não é redundância.

## Duas FKs em processing_jobs (correção crítica do PASSO 02A.2)

A auditoria do PASSO 02A.1 identificou uma falha: a FK composta sozinha
não bastava para `processing_jobs`.

**O problema:** como a FK composta usa MATCH SIMPLE, quando
`organization_id` é `NULL` ela **não é avaliada de forma alguma** — nem
mesmo para checar se `webhook_event_id` existe. Isso permitiria, na
prática, inserir um `processing_job` com:

```
webhook_event_id = <UUID que não existe em webhook_events>
organization_id  = NULL
```

e a única FK composta existente até então não rejeitaria essa linha,
porque `organization_id` sendo `NULL` faz a constraint inteira ser
ignorada — incluindo a parte que deveria garantir a existência do
evento.

**Correção:** duas constraints separadas, cada uma protegendo um
invariante diferente:

```sql
-- (1) FK simples — garante que webhook_event_id SEMPRE existe,
--     independentemente de organization_id.
constraint processing_jobs_webhook_event_fk
  foreign key (webhook_event_id)
  references public.webhook_events (id)
  on delete restrict,

-- (2) FK composta — garante que, QUANDO organization_id está
--     preenchido, ele corresponde ao organization_id real daquele
--     mesmo webhook_event.
constraint processing_jobs_event_org_fk
  foreign key (webhook_event_id, organization_id)
  references public.webhook_events (id, organization_id)
```

**As duas constraints não são redundantes; protegem invariantes
diferentes:**
- a **(1)** garante existência do evento, sempre, com qualquer valor de
  `organization_id` (inclusive `NULL`);
- a **(2)** garante consistência de tenant, apenas quando
  `organization_id` está preenchido.

Sem a (1), o cenário acima (evento inexistente + organização `NULL`)
passaria despercebido. Sem a (2), nada impediria um job com
`organization_id` de um tenant diferente do evento (a falha original do
PASSO 02A.1).

**ON DELETE:** apenas a FK (1) define `ON DELETE RESTRICT` — é ela que
efetivamente bloqueia a exclusão de um `webhook_event` ainda referenciado
por algum job. A FK (2) não define uma ação de `ON DELETE` (assume o
padrão `NO ACTION` do PostgreSQL) — definir `RESTRICT` nela também seria
redundante, e qualquer outra ação (ex.: `SET NULL`) poderia gerar
comportamento conflitante, já que a FK (1) sempre dispara primeiro e
bloqueia a exclusão de qualquer forma quando há um job associado.

## Sobre a fórmula da `idempotency_key` (decisão em aberto, de propósito)

**Ainda não definimos a fórmula exata** e isso é intencional neste
estágio. A única regra fixada agora é:

> A `idempotency_key` é derivada de **atributos estáveis do evento da
> Meta**. Nunca deve ser composta usando `received_at`, `created_at`
> local, ou qualquer timestamp gerado pelo nosso próprio servidor —
> esses valores mudam a cada tentativa de persistência e destruiriam a
> própria finalidade da chave.

Exemplo **conceitual** (não é a fórmula final):

```
provider
+ instagram_account_external_id
+ event_type
+ external_object_id
+ outro identificador estável presente no evento
```

Esses componentes seriam então canonicalizados e reduzidos a um hash
pela aplicação (não pelo banco). A fórmula exata — incluindo quais
campos o payload real da Meta efetivamente garante estarem presentes e
estáveis — só será definida no **PASSO 06/07**, quando tivermos
payloads reais de webhook em mãos. Até lá, a coluna `idempotency_key`
existe na tabela, é `NOT NULL` e `UNIQUE`, mas nenhuma lógica de geração
foi implementada.

## processing_jobs — funcionamento conceitual

Não há worker implementado neste passo. A tabela existe apenas como
estrutura de fila. O índice `idx_processing_jobs_queue (status,
available_at, priority desc, created_at asc)` foi criado especificamente
para dar suporte à consulta de consumo que o worker fará no futuro.

### Consumo da fila precisa ser uma operação atômica

O consumo real precisará ser uma **única operação atômica**,
implementada como uma function/RPC no PostgreSQL, chamada pelo n8n — e
não como duas chamadas separadas (`SELECT` e depois `UPDATE`), que
deixariam uma janela para dois workers concorrentes pegarem o mesmo job.

Fluxo futuro (a ser implementado no **PASSO 07 — Idempotência e fila**,
**não nesta migration**):

```
n8n
  → chama a RPC claim_processing_job()
      → dentro de UMA transação PostgreSQL:
          SELECT ... FOR UPDATE SKIP LOCKED   -- escolhe o próximo job elegível
          UPDATE  ... SET status = 'processing',
                          locked_at = now(),
                          locked_by = <identificador do worker>
      → COMMIT
  ← recebe o job já reservado (ou nenhum, se a fila estiver vazia)
```

**Esta função (`claim_processing_job()`) não é criada nesta
migration** — está documentada aqui apenas como a intenção de design
para o PASSO 07.

### Recovery de jobs abandonados (documentação, sem implementação ainda)

A estrutura atual (`locked_at`, `locked_by`, `attempts`, `max_attempts`)
já é suficiente para suportar recuperação de jobs cujo worker morreu no
meio do processamento — nenhuma coluna nova foi necessária.

Comportamento futuro pretendido (junto com o watchdog, também no
**PASSO 07**, não nesta migration):

```
worker trava/morre com o job em status = 'processing'
  → job fica "preso" com locked_at antigo e locked_by apontando
    para um worker que não existe mais
  → um processo watchdog (rodando periodicamente) identifica jobs em
    'processing' cujo locked_at é mais antigo que um limite aceitável
  → para cada job encontrado:
      incrementa attempts
      se attempts < max_attempts:
          volta o job para status = 'pending'
          define um novo available_at (ex.: com backoff)
          limpa locked_at / locked_by
      senão (attempts >= max_attempts):
          move o job para status = 'dead_letter'
```

Nenhum watchdog é implementado nesta migration.

### Semântica de `failed` vs. `dead_letter`

Aplicável tanto a `webhook_events.status` quanto a
`processing_jobs.status`:

- **`failed`** — a tentativa mais recente terminou com erro, mas o item
  ainda **pode** ser retentado. Estado transitório que aguarda uma
  decisão (nova tentativa automática, ou intervenção manual).
- **`dead_letter`** — o número máximo de tentativas foi atingido, **ou**
  a falha foi classificada como não recuperável. Estado terminal: não
  será mais retentado automaticamente.

Nenhuma lógica de transição entre esses estados é implementada nesta
migration (isso pertence ao worker/watchdog, PASSO 07/08 em diante).

## RLS (Row Level Security) e privilégios

RLS e GRANT são controles **distintos**, e esta migration trata os dois
explicitamente, sem depender dos privilégios default do projeto
Supabase.

**RLS:** habilitada nas cinco tabelas. **Nenhuma policy foi criada** —
de propósito, porque ainda não existe autenticação de usuário no
dashboard, e criar policies agora inevitavelmente resultaria em algo
permissivo demais (ex.: `USING (true)`), dando uma falsa sensação de
segurança. Policies reais serão desenhadas quando a autenticação do
dashboard for implementada (MVP 3).

**GRANT/REVOKE (PASSO 02A.2):**
1. `REVOKE ALL ... FROM anon, authenticated` nas cinco tabelas — nenhum
   desses papéis deve ter qualquer privilégio de tabela.
2. RLS habilitada — mesmo que algum privilégio de tabela existisse, RLS
   sem policy já negaria tudo a `anon`/`authenticated`.
3. `GRANT SELECT, INSERT, UPDATE, DELETE` explícito e mínimo ao
   `service_role` nas **quatro tabelas operacionais**
   (`organizations`, `instagram_accounts`, `webhook_events`,
   `processing_jobs`). **Não** concedemos `TRUNCATE`, `REFERENCES` nem
   `TRIGGER`: `TRUNCATE` apagaria dados em massa sem passar pelas regras
   da aplicação; `REFERENCES`/`TRIGGER` permitiriam ao papel de backend
   criar novas constraints/triggers nessas tabelas em tempo de execução,
   o que não é uma operação esperada.
3.1. **`audit_logs` recebe um `GRANT` separado e mais restrito:**
   `GRANT SELECT, INSERT ON TABLE public.audit_logs TO service_role;` —
   sem `UPDATE` nem `DELETE`. Isso corrige uma inconsistência: antes
   deste ajuste (PASSO 02B), `audit_logs` era descrita como
   "conceitualmente append-only", mas o `GRANT` original concedia
   `UPDATE`/`DELETE` também a ela, contradizendo a própria decisão
   documentada. Agora o append-only é reforçado **no nível de
   privilégio**, não apenas de convenção — nem o próprio `service_role`
   consegue alterar ou apagar uma linha de auditoria pelo caminho normal
   de acesso ao banco.
4. O `service_role`, por padrão no Supabase, **ignora RLS**
   independentemente destes GRANTs — mas os GRANTs continuam sendo uma
   camada de defesa própria, caso essa premissa do Supabase mude ou seja
   mal configurada. Não dependemos apenas de "o Supabase cuida disso".

**Por que isso importa:** antes desta correção, a proteção contra
`anon`/`authenticated` dependia inteiramente de RLS. Agora há duas
camadas independentes (RLS + GRANT/REVOKE) que precisariam falhar
simultaneamente para expor dados indevidamente.

### Segurança da função `set_updated_at()`

- Criada com `CREATE FUNCTION` (sem `OR REPLACE`), `SECURITY INVOKER`
  (padrão — nunca `SECURITY DEFINER`, pois a função só manipula a
  própria linha sendo atualizada) e `SET search_path = ''`.
- `EXECUTE` é **revogado** de `PUBLIC`, `anon` e `authenticated`
  explicitamente. A função existe exclusivamente para ser chamada pelos
  triggers desta mesma migration — nunca para ser invocada diretamente
  por um papel de aplicação. Isso **não afeta** o funcionamento dos
  triggers: um trigger é disparado automaticamente pelo motor de
  execução de DML, e não está sujeito à checagem de privilégio
  `EXECUTE` de um papel de sessão do jeito que uma chamada direta de
  função estaria.

### audit_logs — proteção append-only

Desde o ajuste do PASSO 02B, o append-only de `audit_logs` deixou de ser
**apenas conceitual**: o `GRANT` do `service_role` para esta tabela é
`SELECT, INSERT` apenas — sem `UPDATE` nem `DELETE`. Isso significa que
mesmo o backend, usando `service_role`, recebe um erro de privilégio
insuficiente do próprio PostgreSQL se tentar atualizar ou apagar uma
linha de auditoria pelo caminho normal.

Ainda assim, nenhum trigger bloqueando `UPDATE`/`DELETE` foi criado —
o `GRANT` restrito já cobre isso enquanto `service_role` for o único
papel de backend existente. Quando outros papéis de backend existirem
(e precisarem, por exemplo, de acesso mais amplo por outro motivo), essa
proteção deverá ser revisada e possivelmente reforçada com um trigger
explícito independente de `GRANT`.

## Decisões sobre DELETE

Nenhuma FK usa `CASCADE`. Resumo:

| Relação | ON DELETE | Motivo |
|---|---|---|
| `organizations → instagram_accounts` | `RESTRICT` | Impede remover uma organização com contas ainda conectadas |
| `organizations/instagram_accounts → webhook_events` (FKs simples) | `SET NULL` | Preserva o log de eventos históricos mesmo se o "pai" for removido |
| `instagram_accounts (id, organization_id) → webhook_events` (FK composta) | padrão (`NO ACTION`) | Existe só para validar consistência, não para orquestrar exclusão — a limpeza real acontece via FK simples acima |
| `webhook_events (id) → processing_jobs` (FK simples `processing_jobs_webhook_event_fk`) | `RESTRICT` | Bloqueia exclusão do evento enquanto houver job associado — esta é a FK que efetivamente impõe a regra |
| `webhook_events (id, organization_id) → processing_jobs` (FK composta `processing_jobs_event_org_fk`) | padrão (`NO ACTION`) | Só valida consistência de tenant; a FK simples acima já cobre o bloqueio de exclusão |
| `organizations → processing_jobs` (FK simples, denormalizada) | `SET NULL` | Preserva histórico |
| `organizations → audit_logs` | `SET NULL` | Preserva o log de auditoria mesmo se a organização for removida |

## Índices criados

| Tabela | Índice/constraint | Motivo |
|---|---|---|
| `instagram_accounts` | `organization_id` (índice simples) | FK não indexada automaticamente pelo PostgreSQL |
| `instagram_accounts` | `external_id` (via `UNIQUE`) | Resolução de conta a partir do identificador da Meta, com unicidade global |
| `instagram_accounts` | `(id, organization_id)` (via `UNIQUE` técnica) | Alvo da FK composta multitenant a partir de `webhook_events` |
| `webhook_events` | `organization_id`, `instagram_account_id` (índices simples) | FKs simples não indexadas automaticamente |
| `webhook_events` | `status` | Localizar eventos pendentes de processamento |
| `webhook_events` | `idempotency_key` (via `UNIQUE`) | Idempotência de entrada |
| `webhook_events` | `(id, organization_id)` (via `UNIQUE` técnica) | Alvo das FKs a partir de `processing_jobs` |
| `processing_jobs` | `organization_id` (índice simples) | FK não indexada automaticamente |
| `processing_jobs` | `(status, available_at, priority desc, created_at asc)` | Consulta de consumo da fila |
| `processing_jobs` | `(webhook_event_id, job_type)` (via `UNIQUE`) | Idempotência de enfileiramento + lookup por evento |
| `audit_logs` | `organization_id` | FK não indexada automaticamente |
| `audit_logs` | `(entity_type, entity_id)` | Consulta futura de histórico de uma entidade específica |

Não foram criados índices para colunas ainda sem padrão de consulta
definido (ex.: `username` em `instagram_accounts`).

## Constraints numéricas

- `webhook_events.processing_attempts >= 0`
- `processing_jobs.attempts >= 0`
- `processing_jobs.max_attempts > 0` (zero tentativas máximas não faz
  sentido — um job assim nunca poderia ser processado)

`priority` (em `processing_jobs`) **não** recebeu constraint de faixa
numérica: ainda não existe semântica de negócio definida para os
valores possíveis. Decisão em aberto até definirmos a política de
priorização de jobs.

## Testes obrigatórios na aplicação da primeira migration (PASSO 02B)

Nenhum destes testes foi executado ainda — ficam planejados para quando
tivermos um Supabase de desenvolvimento real conectado.

- **TESTE 01** — Criar organization válida.
- **TESTE 02** — Criar instagram_account vinculada a essa organization.
- **TESTE 03** — Recusar `external_id` duplicado globalmente (tentar
  cadastrar a mesma conta em outra organização deve falhar).
- **TESTE 04** — Criar webhook_event sem organization/account
  (ambos `NULL`) — deve ser aceito.
- **TESTE 05** — Criar webhook_event com account + organization
  corretas (a conta realmente pertence àquela organização) — deve ser
  aceito.
- **TESTE 06** — Recusar webhook_event com organization de um tenant A
  e account pertencente a um tenant B — deve falhar por violação da FK
  composta `webhook_events_account_org_fk`.
- **TESTE 07** — Criar processing_job com `webhook_event_id` existente
  e `organization_id` `NULL` — deve ser aceito.
- **TESTE 08** — **(crítico — valida a correção do PASSO 02A.2)**
  Recusar processing_job com `webhook_event_id` **inexistente** e
  `organization_id` `NULL` — deve falhar por violação da FK simples
  `processing_jobs_webhook_event_fk`. Este é exatamente o cenário que a
  FK composta sozinha deixaria passar.
- **TESTE 09** — Criar processing_job com `organization_id`
  correspondente ao do `webhook_event` de origem — deve ser aceito.
- **TESTE 10** — Recusar processing_job com `organization_id` de um
  tenant diferente do `webhook_event` de origem — deve falhar por
  violação da FK composta `processing_jobs_event_org_fk`.
- **TESTE 11** — Recusar `processing_attempts` negativo em
  `webhook_events`.
- **TESTE 12** — Recusar `attempts` negativo em `processing_jobs`.
- **TESTE 13** — Recusar `max_attempts = 0` em `processing_jobs`.
- **TESTE 14** — Confirmar que o trigger de `updated_at` funciona
  (atualizar uma linha em `organizations`, `instagram_accounts` ou
  `processing_jobs` e verificar que `updated_at` muda para o momento do
  `UPDATE`).
- **TESTE 15** — Confirmar que o papel `anon` não tem `SELECT`,
  `INSERT`, `UPDATE` nem `DELETE` em nenhuma das cinco tabelas.
- **TESTE 16** — Confirmar que o papel `authenticated` não tem `SELECT`,
  `INSERT`, `UPDATE` nem `DELETE` em nenhuma das cinco tabelas.
- **TESTE 17** — Confirmar que o `service_role` tem exatamente o acesso
  necessário, com a distinção entre as tabelas operacionais e o log de
  auditoria:
  - `organizations`: `SELECT` / `INSERT` / `UPDATE` / `DELETE` permitidos;
  - `instagram_accounts`: `SELECT` / `INSERT` / `UPDATE` / `DELETE` permitidos;
  - `webhook_events`: `SELECT` / `INSERT` / `UPDATE` / `DELETE` permitidos;
  - `processing_jobs`: `SELECT` / `INSERT` / `UPDATE` / `DELETE` permitidos;
  - `audit_logs`: `SELECT` **permitido**, `INSERT` **permitido**,
    `UPDATE` **negado**, `DELETE` **negado** (append-only imposto por
    privilégio).

  Confirmar também que `TRUNCATE` não foi concedido em nenhuma das cinco
  tabelas.
- **TESTE 18** — Testar o comportamento real de `DELETE` envolvendo
  `instagram_accounts`/`webhook_events`:
  - **A)** apagar uma `instagram_account` sem nenhum evento associado →
    deve ter SUCESSO;
  - **B)** apagar uma `instagram_account` referenciada por um
    `webhook_event` → a conta deve ser removida e
    `webhook_events.instagram_account_id` deve virar `NULL`;
  - **C)** confirmar que `webhook_events.organization_id` permanece
    intacto nessa mesma linha, e que a FK composta
    `webhook_events_account_org_fk` continua satisfeita após o `SET NULL`;
  - **D)** tentar excluir um `webhook_event` que possui `processing_job`
    associado → deve FALHAR por `RESTRICT`
    (`processing_jobs_webhook_event_fk`);
  - **E)** tentar excluir uma `organization` que ainda possui
    `instagram_account` → deve FALHAR por `RESTRICT`.
- **TESTE 19** — Segurança da função `public.set_updated_at()`:
  - confirmar que `anon` **não** possui `EXECUTE` direto sobre a função;
  - confirmar que `authenticated` **não** possui `EXECUTE` direto sobre
    a função;
  - depois, confirmar que um `UPDATE` autorizado feito pelo backend
    (`service_role`) **continua disparando normalmente** o trigger de
    `updated_at`.

  Objetivo: provar que o `REVOKE EXECUTE` não quebrou o funcionamento
  dos triggers — um trigger é disparado pelo motor de DML, não por uma
  chamada de função sujeita à checagem de privilégio `EXECUTE` de um
  papel de sessão. Esta é uma premissa que raciocinei estaticamente e
  que precisa de confirmação empírica.

## Aplicação e validação em banco real (PASSO 02B — concluído)

O schema foi **aplicado e validado em banco real**. Esta seção registra
o que efetivamente aconteceu, incluindo as correções que só apareceram
com a execução real.

### Projeto utilizado

**Base de Dados Phiq.** Nenhum project ref, senha, chave ou token é
registrado neste documento nem em qualquer arquivo versionado.

### Convivência com tabelas pré-existentes

O banco utilizado já continha tabelas de outro domínio, alheias a este
projeto:

- `segmentos_clientes`
- `vendas_itens_raw`

**Nenhuma delas foi alterada.** Todas as migrations do Social Selling
criam apenas objetos novos, sem tocar em estruturas pré-existentes.

### Migrations aplicadas

| Timestamp remoto | Migration | Conteúdo |
|---|---|---|
| `20260825020953` | `initial_social_selling_core_schema` | Schema inicial (5 tabelas, constraints, índices, function, triggers, RLS, grants) — corresponde localmente a `20260824233233_initial_core_schema.sql` |
| `20260825021058` | `harden_social_selling_service_role_privileges` | Hardening de privilégios do `service_role` |
| `20260825021149` | `add_social_selling_composite_fk_indexes` | Índices de suporte às FKs compostas |

> Nota: o arquivo local da migration inicial mantém o nome
> `20260824233233_initial_core_schema.sql` (já commitado e auditado).
> A diferença de timestamp em relação ao registro remoto é apenas de
> nomenclatura — o conteúdo aplicado é o mesmo.

### Testes de integridade

Os testes de integridade descritos na seção anterior foram executados
contra o banco real e **passaram**.

#### Falso negativo no teste de `updated_at` (registro importante)

A primeira execução do teste do trigger de `updated_at` deu **falso
negativo**. A causa não era o trigger, e sim uma característica do
PostgreSQL: **`now()` é estável dentro de uma mesma transação**. Como o
`INSERT` e o `UPDATE` do teste rodaram na mesma transação, `now()`
retornou exatamente o mesmo valor nas duas operações, e o `updated_at`
"não mudou" — mas o trigger tinha disparado corretamente o tempo todo.

O teste foi então refeito corretamente: com um `updated_at` inicial
antigo e o `UPDATE` executado sob `service_role`. Nessa segunda
execução, o trigger **funcionou como esperado**, atualizando
`updated_at` para o novo instante.

**Lição para testes futuros:** qualquer verificação de timestamp
baseada em `now()` precisa ocorrer em transações separadas, ou usar um
valor inicial deliberadamente antigo. Caso contrário o teste mede a
estabilidade de `now()`, não o comportamento do trigger.

### Hardening de privilégios do `service_role`

Aplicado pela migration `20260825021058`. A abordagem foi revogar tudo
primeiro (inclusive do `service_role`, que antes não era alvo do
`REVOKE ALL`) e então conceder explicitamente o mínimo necessário —
assim os privilégios efetivos não dependem do que o projeto Supabase
concede por padrão.

| Tabela | Privilégios do `service_role` |
|---|---|
| `public.organizations` | `SELECT` `INSERT` `UPDATE` `DELETE` |
| `public.instagram_accounts` | `SELECT` `INSERT` `UPDATE` `DELETE` |
| `public.webhook_events` | `SELECT` `INSERT` `UPDATE` `DELETE` |
| `public.processing_jobs` | `SELECT` `INSERT` `UPDATE` `DELETE` |
| `public.audit_logs` | `SELECT` `INSERT` **apenas** |

Em nenhuma das cinco tabelas foram concedidos `TRUNCATE`, `REFERENCES`
ou `TRIGGER`.

### `EXECUTE` revogado de `public.set_updated_at()`

O `EXECUTE` direto sobre a função foi revogado também do
`service_role` — somando-se a `PUBLIC`, `anon` e `authenticated`, já
revogados na migration inicial. Nenhum papel possui `EXECUTE` direto
sobre ela.

**O trigger continua funcionando normalmente**, o que foi confirmado
empiricamente no reteste descrito acima. Isso valida a premissa que
até então era apenas raciocínio estático: um trigger é disparado pelo
motor de execução de DML e não passa pela checagem de privilégio
`EXECUTE` a que uma chamada direta de função estaria sujeita.

### Índices adicionais para as FKs compostas

Aplicados pela migration `20260825021149`:

- `idx_webhook_events_account_org` sobre
  `public.webhook_events (instagram_account_id, organization_id)`
- `idx_processing_jobs_event_org` sobre
  `public.processing_jobs (webhook_event_id, organization_id)`

O PostgreSQL não cria índices automaticamente para as colunas de origem
de uma FK. Sem esses índices, as FKs compostas
`webhook_events_account_org_fk` e `processing_jobs_event_org_fk`
ficavam sem cobertura do lado referenciante, penalizando a verificação
das constraints e, principalmente, operações de `DELETE` na tabela
referenciada — que precisam varrer a tabela filha atrás de linhas
dependentes. Os índices simples já existentes cobrem apenas uma coluna
cada e não substituem um índice sobre o par completo.

### Avisos dos advisors do Supabase (pré-existentes, não relacionados)

Os advisors do Supabase apontaram avisos que **não têm relação com o
Social Selling** e que dizem respeito a objetos pré-existentes do
banco:

- `public.rls_auto_enable()` — função `SECURITY DEFINER` executável por
  `anon`/`authenticated`;
- índices duplicados em `vendas_itens_raw`.

**Nenhum desses objetos foi alterado.** Eles pertencem a outro domínio
do mesmo banco e estão fora do escopo deste projeto. Ficam apenas
registrados aqui para rastreabilidade — a decisão sobre eles cabe a
quem mantém aquele domínio.

## O que propositalmente NÃO foi criado neste passo

`instagram_users`, `instagram_posts`, `instagram_comments`,
`instagram_messages`, `contacts`, `leads`, `lead_scores`,
`ai_analysis`, `ai_responses`, `prompts`, `automation_rules`,
`automation_executions`, `outbound_actions`. Essas tabelas serão
criadas em migrations futuras, quando os respectivos fluxos (IA,
comentários, DMs, lead score, etc.) forem implementados — conforme o
roadmap. Também não foram criadas Edge Functions, nem qualquer conexão
com Meta, OpenAI, n8n ou Google Sheets.
