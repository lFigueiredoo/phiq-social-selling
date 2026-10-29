# Checkpoint F22A: realtime do social selling

## Caminho dos dados

1. **Meta → webhook:** `meta-instagram-webhook` recebe `POST` assinado com `x-hub-signature-256`. A assinatura HMAC usa `META_APP_SECRET`. Somente mudanças `comments` e `live_comments` com ID são aceitas. Confirme na Meta a assinatura da aplicação, o campo inscrito e a URL da função. Um HTTP 200 apenas confirma recebimento; confira as próximas etapas.
2. **Webhook → `webhook_events`:** a função procura `instagram_accounts.external_id = entry.id` e cria evento `received` com chave `meta:instagram:<field>:<account external id>:<comment id>`. A restrição única da chave absorve reentregas. Se a conta não estiver mapeada, o evento fica sem job; confira o mapeamento e os logs da função. Para comentários comuns, consulte por `external_object_id` e `idempotency_key`, sem exibir o payload completo.
3. **Evento → `processing_jobs`:** para conta mapeada, insere `process_instagram_comment` em `pending` e muda o evento para `queued`. A restrição única `(webhook_event_id, job_type)` impede job repetido. Inspecione `status`, `available_at`, `attempts` e `locked_by` do job. Se a inserção falhar, a função retorna 500 para permitir nova entrega da Meta.
4. **Job → claim:** `POST /functions/v1/n8n-claim-instagram-job` com JSON `{"worker_id":"n8n-social-selling-01"}` e header `x-worker-secret`. `N8N_WORKER_SECRET` ausente na função retorna 503; header ausente ou diferente retorna 401 `unauthorized`; credencial correta e fila vazia retorna 200 com `job: null`. A RPC `claim_processing_job` seleciona `pending`, `available_at <= now()`, tentativas restantes e tipo correto, por prioridade e criação. Usa `FOR UPDATE SKIP LOCKED`, muda para `processing`, grava `locked_by` e incrementa tentativas atomicamente.
5. **Claim → CRM → rascunho:** `process-social-engagement` classifica e atualiza o CRM. Em seguida, `n8n-prepare-instagram-draft` monta o prompt de redação e `n8n-save-instagram-draft` persiste o resultado pela RPC `save_instagram_response_draft`. A ação nasce como resposta pública `proposed`; `n8n-update-instagram-job` só conclui o job depois dessa persistência. Consulte `comment_analyses`, `decision_records`, `outbound_actions` e o status do job. Não invoque `n8n-dispatch-instagram-action` nesta validação.

## Entrada histórica e idempotência

O botão **Importar** chama `panel-import-instagram-comments`, que lê comentários pela API Meta e chama `panel_import_historical_instagram_comment`. O payload recebe `source: historical_backfill`; a RPC cria evento e job numa transação. Ela usa a mesma chave de comentários comuns, `meta:instagram:comments:<account external id>:<comment id>`, e retorna `already_exists` se o webhook tiver vencido a corrida. O webhook não chama essa função nem depende do botão. O campo `live_comments` tem chave distinta por desenho atual; sua convergência com `comments` para o mesmo ID não foi demonstrada.

## n8n self-hosted

- Confirme que o workflow de processamento está **ativo**, com schedule habilitado e execução recente no fuso horário esperado.
- Confira a URL do projeto Supabase e o endpoint exato `/functions/v1/n8n-claim-instagram-job`; o frontend não chama o n8n.
- No node HTTP Request de claim, use uma credencial centralizada para o header **`x-worker-secret`**. Verifique a presença e a igualdade com o `N8N_WORKER_SECRET` configurado na Edge Function por procedimento seguro, sem copiar valores para logs, exports ou Git. Não altere a função para aceitar segredo incorreto.
- Confira `worker_id` estável e não vazio, por exemplo `n8n-social-selling-01`, e use o mesmo ID nas chamadas de processamento, preparação, persistência do rascunho e update.
- Pause qualquer workflow que invoque o dispatcher antes de um teste controlado. Não use comentários reais nem envie DM ou resposta para testar a autenticação.
- O corpo `{"ok":false,"error":"unauthorized"}` com HTTP 401 no claim identifica a checagem do segredo na função, desde que a resposta venha deste endpoint. Isso prova que o valor recebido não corresponde ao valor configurado; não distingue header ausente, credencial errada ou projeto/endpoint Supabase incorreto. O estado remoto não foi consultado neste checkpoint.

## Validação local segura

Execute `node --test tests/realtime-contract.test.cjs` na raiz. O teste carrega os handlers reais com banco simulado, cobre autenticação do claim, webhook assinado, reentrega sem duplicação e dois workers concorrentes em sequência. O contrato do import histórico é checado no código e na RPC; a transação PostgreSQL em si ainda exige teste de integração local com Supabase/Docker. Nenhum teste chama Meta ou o dispatcher.
