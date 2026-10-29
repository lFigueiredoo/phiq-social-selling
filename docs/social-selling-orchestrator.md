# Orquestrador central do Social Selling (F22F)

`process-social-engagement` é a porta interna para processar uma interação social. O endpoint exige `x-worker-secret` igual a `N8N_WORKER_SECRET`; a chave `service_role` permanece apenas na Edge Function. O banco expõe as RPCs somente ao `service_role`. O frontend, coletor e n8n não implementam transições comerciais. Nenhuma fase cria `outbound_actions`, chama dispatcher ou executa `recommended_next_action`.

## Entrada e saída

O corpo é o objeto `engagement` abaixo, diretamente ou em `{ "job_id": "...", "worker_id": "...", "engagement": { ... } }`. `job_id` e `worker_id` são metadados para o futuro worker; não autorizam acesso. A identidade da interação exige `external_engagement_id` ou `webhook_event_id`, e a pessoa exige `external_user_id` ou `username`.

```json
{
  "organization_id": "uuid",
  "instagram_account_id": "uuid",
  "external_user_id": "instagram-user-id",
  "username": "optional",
  "engagement_type": "comment",
  "external_engagement_id": "instagram-comment-id",
  "text": "Quero abrir uma franquia",
  "source": "realtime",
  "occurred_at": "2026-09-27T12:00:00Z",
  "metadata": {}
}
```

`source` aceita apenas `realtime`, `historical_backfill`, `browser_collector` ou `manual`. A entrada também aceita `webhook_event_id`, `display_name`, `media_external_id` e `media_permalink`. O texto fica limitado a 2.000 caracteres e é usado como contexto do classificador; não aparece nos logs. O banco valida tenant e conta ativa antes de criar dados.

A resposta traz `operation_id`, `contact_id`, `engagement_id`, `lead_id`, indicadores `created_*`, `central_stage`, `qualification`, `classification`, `classification_status`, `classifier_source`, `prompt_version`, `route_type`, `vertical_stage`, `lead_status`, `contact_eligibility`, `recommended_next_action`, `needs_more_signal`, `actions_performed`, `result_code`, `retryable`, `error_code`, estágio e rota anteriores e `duration_ms`. `actions_performed` descreve apenas persistência e alterações de estado.

## Fases e limites transacionais

1. **Fase A, uma transação PostgreSQL:** `prepare_social_engagement_pipeline` bloqueia a conta para serializar identidade e entrega duplicada; faz upsert do contato, registra o engagement, usa o lead existente ou cria um, aplica o motor central pelo trigger e devolve um snapshot das últimas interações. Um lead `won`, `lost` ou `cancelled` permanece o mesmo lead.
2. **Classificação, fora da transação:** a Edge Function usa `classifySocialLeadContext` F22D. O classificador determinístico decide primeiro. Só um contexto não resolvido consulta o provedor configurado. A decisão usa o snapshot da fase A, sem manter conexão ou lock durante a chamada externa.
3. **Fase C, uma transação PostgreSQL:** `complete_social_engagement_pipeline` bloqueia engagement e lead, chama `save_social_classification` F22D, aplica qualificação, limiares e rota pelo motor central, inicia a vertical em `lead_received` e devolve o estado consolidado. `classification_status=completed` e `pipeline_processed_at` ficam na interação.

O primeiro sinal pode receber classificação persistida e ainda permanecer em `new_lead`. Uma segunda interação substantiva leva a `first_contact`; a avaliação estruturada percorre `qualification` e `routing`. Não há salto automático de etapas. A ação recomendada vem da etapa vertical F22E; ela nunca é executada pelo orquestrador.

## Idempotência, retry e concorrência

`record_social_engagement` deduplica a identidade externa. A fase A é serializada pela linha da conta; a fase C bloqueia a interação e o lead. Uma interação `completed` ou `not_required` retorna `already_processed` e não reaplica score, rota, histórico ou classificação. A chave de operação é o `engagement_id`; `social_classifications.engagement_id` tem unicidade. Workers concorrentes podem classificar o mesmo snapshot, mas apenas um persiste o efeito. O teste local com duas conexões confirmou uma aplicação comercial.

Se o provedor estiver indisponível, expirar, responder 429/500 ou produzir saída inválida, a fase A permanece gravada. `mark_social_engagement_pipeline_failure` registra `failed_retryable` e um código de erro controlado. O próximo processamento da mesma interação retenta a classificação sem recriar contato, engagement ou lead. Falha de validação de entrada é `terminal_error`; falha transitória de banco ou provedor é `retryable_error`. Nenhuma falha de IA inventa rota.

| `result_code` | Significado |
|---|---|
| `classified` | Classificação persistida; o funil central ainda não permitiu rota |
| `routed` | Rota comercial aplicada e vertical iniciada |
| `no_profile` | Sem perfil comercial, aguardando novo sinal |
| `needs_more_signal` | Sinal insuficiente ou curtida isolada |
| `lead_closed` | Interação registrada em lead encerrado, sem reabertura automática |
| `already_processed` | Entrega repetida, sem segundo efeito |
| `retryable_error` | Dados base preservados; worker pode retentar |
| `terminal_error` | Entrada inválida ou não autorizada |

## Origem e status

`historical_backfill` usa o mesmo domínio comercial sem conceder `contact_eligibility=eligible`. Uma curtida isolada de `browser_collector` registra contato e interação, fica em `new_lead`, não ganha rota nem elegibilidade e termina como `not_required` para classificação. `no_profile` mantém o lead em `awaiting_signal`; uma nova interação explícita pode voltar a `qualification` e iniciar rota vertical. Uma nova evidência forte pode reclassificar NUY para franquia no mesmo contato e lead, preservando o histórico NUY.

Um lead `lost` ou `cancelled` recebe a interação, mas não reabre automaticamente. Um lead `won` também recebe a interação sem criar nova oportunidade automaticamente. A reabertura segue a RPC manual auditada F22E. A elegibilidade para contato permanece separada do score e da rota.

## Contrato do worker n8n

O workflow versionado em `n8n/workflows/ig-social-selling-orchestrator.json`
consulta a fila a cada quinze segundos no piloto. O gateway de claim devolve `job`, `event`
e o objeto `engagement` canônico; o n8n não interpreta payload da Meta nem
implementa regra comercial. Ele chama `process-social-engagement` e só marca o
job como concluído depois de `classified`, `routed`, `no_profile`,
`needs_more_signal`, `lead_closed` ou `already_processed`. Falhas transitórias
usam backoff exponencial limitado a 15 minutos. Entrada terminal usa a RPC
atômica `dead_letter_processing_job`, preservando a causa e liberando o lock.

O JSON não contém URL, chave ou credencial. O contêiner n8n deve receber
`SUPABASE_FUNCTIONS_URL` e `N8N_WORKER_SECRET` por ambiente. Dados de execução
automática não são persistidos no n8n, reduzindo exposição de texto social. O
workflow é importado inativo e só pode ser publicado após as migrations,
funções, secrets e testes negativos/positivos estarem concluídos.

Observabilidade usa IDs, origem, códigos e duração; não registra texto completo, segredos ou payload do webhook. A suíte local `social_engagement_orchestrator.sql` roda com `ROLLBACK`; `social_orchestrator_concurrency.cjs` remove seu fixture depois de duas conexões simultâneas. `social_orchestrator_http_local.cjs` executa o handler com o cliente Supabase real contra a API e o PostgreSQL locais, usando somente classificação determinística, e remove seu fixture. O serviço Edge local permanece independente desse teste.
