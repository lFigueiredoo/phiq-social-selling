# Setup local e de ambientes

## Pré-requisitos

- Docker Desktop em execução;
- Supabase CLI compatível com o projeto;
- Node.js 24+ e npm;
- Python 3.12+ apenas para o coletor experimental;
- acesso ao projeto Supabase remoto somente para operações deliberadas de
  leitura/deploy.

## Supabase local

Na raiz do repositório:

```powershell
supabase start --exclude vector
supabase db reset
supabase test db
```

`db reset` apaga os dados do banco **local** e reaplica todas as migrations.
Não use flags remotas nesse comando. O Studio local fica, por padrão, em
`http://127.0.0.1:54323`.

As Edge Functions leem automaticamente `supabase/functions/.env`. Um arquivo
com outro nome só é carregado quando passado explicitamente:

```powershell
supabase functions serve --env-file supabase/.env.functions.local
```

Variáveis mínimas por fluxo:

| Fluxo | Variáveis adicionais |
|---|---|
| Webhook Meta | `META_APP_SECRET`, `META_VERIFY_TOKEN` |
| Worker/classificação | `N8N_WORKER_SECRET` |
| Gemini para casos não determinísticos | credencial criptografada `Google Gemini(PaLM) Api account` no n8n |
| Política/dispatch Meta | `META_ACCESS_TOKEN`, `META_API_VERSION` |
| Continuidade de Direct | `INSTAGRAM_CONVERSATION_DISPATCH_ENABLED` (manter `false` até homologação) |
| Painel no navegador | `PANEL_ALLOWED_ORIGINS` |

Use `INSTAGRAM_DISPATCH_DRY_RUN=true` nos testes locais. Nunca reutilize o
access token da Meta como verify token ou segredo do worker.

## Painel web

Crie `panel-web/.env.local`:

```dotenv
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<chave-publicavel-local>
```

Depois:

```powershell
Set-Location panel-web
npm ci
npm run dev
```

Arquivos `.env` e `.env.local` são combinados pelo Vite, com o arquivo local
normalmente prevalecendo. Mantenha apenas um destino ativo por máquina para não
apontar o frontend local para o banco remoto por engano.

## Testes

```powershell
Set-Location panel-web
npm run check
npm audit --omit=dev --audit-level=moderate
Set-Location ..

supabase test db
node supabase/tests/vertical_concurrency.cjs
node supabase/tests/social_orchestrator_concurrency.cjs
```

Com `supabase functions serve` ativo:

```powershell
node supabase/tests/social_orchestrator_http_local.cjs
```

O coletor experimental possui uma suíte isolada:

```powershell
.\.venv\Scripts\python.exe -m unittest discover `
  -s .\collectors\instagram-likers -p 'test_*.py' -v
```

## Estado remoto observado em 24/11/2026

- Projeto vinculado: `Base de Dados Phiq`;
- 48 migrations alinhadas entre local e remoto;
- `classify-social-lead`, `process-social-engagement` e `panel-social-crm`
  implantadas, junto aos gateways atualizados do worker;
- painel CRM publicado e validado no domínio Vercel de produção;
- Google Gemini já conectado ao n8n com a credencial criptografada
  `Google Gemini(PaLM) Api account`; classificação usa
  `models/gemini-3.5-flash-lite` e rascunhos usam
  `models/gemini-3.6-flash`, ambos com três tentativas de provider;
- nenhuma chave de provider AI é necessária no Supabase;
- workflow n8n configurado com `PHIQ Supabase Worker`, publicado com 19 nós e
  um único agendamento; o smoke de claim sem item na fila concluiu com sucesso
  em 9,64 s;
- dispatcher versionado em
  `n8n/workflows/ig-social-selling-dispatch-approved.json`, sem segredo em
  headers e com os dois nós HTTP ligados a `PHIQ Supabase Worker`;
- classificação e rascunhos usam o Gemini conectado; um fixture positivo
  concluiu o job e persistiu uma única ação `proposed`, sem `sent_at` nem
  `provider_action_id`, mantendo a aprovação humana obrigatória.
- inbox conversacional e operação publicadas no painel em `/conversas` e
  `/operacao`, com SLA, distribuição, opt-out, catálogo aprovado, feedback de
  modelo, alertas e solicitações de anonimização;
- cinco novas Edge Functions ativas para inbox, operação, fila conversacional,
  dispatch e manutenção; seus testes negativos rejeitam chamada sem JWT ou
  segredo de worker;
- workflows `IG Social Selling — Dispatch Conversation` e
  `IG Social Selling — Monitoring and Retention` versionados no repositório.
  A importação/publicação na instância n8n ainda precisa de confirmação na
  sessão administrativa;
- o gate `INSTAGRAM_CONVERSATION_DISPATCH_ENABLED` permanece `false` até o
  webhook `messages` ser confirmado com um evento real. Nenhum Direct
  conversacional foi enviado.

A configuração segura para novos ambientes continua sendo
`INSTAGRAM_DISPATCH_DRY_RUN=true`,
`INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=true` e
`INSTAGRAM_PRIVATE_REPLY_PILOT_ENABLED=false`. Em produção, o piloto autorizado
em 24/11/2026 usa `INSTAGRAM_DISPATCH_DRY_RUN=false`, libera o tipo
`private_reply` somente sob os gates comerciais/políticos e limita o canal a
5 envios por conta em janela móvel de 24 horas. Toda ação exige aprovação humana.

## Corte de segurança de 29/10/2026

- `INSTAGRAM_DISPATCH_DRY_RUN=true` foi gravado explicitamente nos secrets do
  projeto remoto;
- `n8n-dispatch-instagram-action` foi reimplantada com a trava fail-closed
  executada antes do claim da ação e antes de qualquer chamada à Meta;
- o painel passou a expor o modo operacional sem revelar secrets;
- aprovação pelo painel exige `acknowledge_automatic_dispatch=true` e uma
  confirmação visual do revisor;
- edições não salvas bloqueiam a aprovação, evitando liberar um texto antigo;
- o dispatcher agendado pode continuar consultando a fila, mas recebe `423`
  enquanto o dry-run estiver ativo e não reclama nem envia a ação.

Nunca altere o secret para `false` apenas para testar conectividade. Toda
mudança de escopo exige fila reconciliada, rollback preparado e conferência de
`sent_at/provider_action_id`.

## Ativação controlada do piloto — 24/11/2026

- a fila foi conferida imediatamente antes da ativação: zero ações `approved`;
- `n8n-dispatch-instagram-action` bloqueia qualquer tipo diferente de
  `public_reply` antes do claim e antes de chamar a Meta;
- `n8n-get-next-instagram-action` filtra a fila para `public_reply` enquanto o
  piloto estiver ativo;
- `panel-me` expõe `public_reply_only` e `allowed_action_types` sem revelar
  valores de secrets;
- o painel publicado informa que apenas respostas públicas aprovadas podem ser
  enviadas e que Direct continua bloqueado;
- `N8N_WORKER_SECRET` foi rotacionado, separado de `META_VERIFY_TOKEN` e validado
  no worker e no dispatcher após a atualização do credential store;
- `META_VERIFY_TOKEN` também foi rotacionado separadamente; o endpoint aceitou
  o challenge novo com `200` e rejeitou um token inválido com `403`, sem mudar a
  assinatura HMAC dos eventos (`META_APP_SECRET`);
- o primeiro envio controlado concluiu como `sent` às 11:08:14 de 24/11/2026,
  com `provider_action_id=18080442827741679`; os polls seguintes não repetiram
  o envio;
- respostas da própria conta que retornam pelo webhook são ignoradas antes da
  fila; um trigger no banco cancela e audita qualquer ação autodirecionada como
  defesa adicional;
- o rollback operacional é restaurar
  `INSTAGRAM_DISPATCH_DRY_RUN=true`; a trava de tipo deve permanecer ativa.

## Ampliação controlada para Direct — 24/11/2026

- fila conferida antes da mudança: zero `approved`, zero `dispatching` e zero
  Direct elegível pendente;
- `INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=false`,
  `INSTAGRAM_PRIVATE_REPLY_PILOT_ENABLED=true` e
  `INSTAGRAM_PRIVATE_REPLY_DAILY_LIMIT=5` em produção;
- apenas `realtime/comment` com interesse comercial explícito, score >= 70,
  potencial médio/alto e sem necessidade de mais sinal pode gerar proposta;
- `n8n-check-instagram-policy`, painel, Edge Function de dispatch e RPC do banco
  revalidam a elegibilidade; o limite de 24 horas é atômico no banco;
- ao atingir o limite, a ação volta a `proposed`, sai da fila de envio e exige
  uma nova aprovação humana; assim ela não bloqueia respostas públicas;
- histórico nunca gera Direct; texto com link, acima de 500 caracteres ou de
  1.000 bytes é rejeitado;
- ativar o piloto não aprova nem envia ações. O primeiro envio depende de
  revisão humana individual;
- respostas recebidas devem ser acompanhadas no Meta Inbox até a ingestão do
  webhook `messages` ser homologada. A ingestão, inbox e dispatcher já estão
  implementados, mas o gate de continuidade continua desligado até o teste
  ponta a ponta e a promoção dos workflows n8n.

## Promoção da inbox conversacional — pendente de homologação

1. Importar/atualizar `ig-social-selling-orchestrator.json` preservando a
   credencial `PHIQ Supabase Worker` e a credencial Gemini existentes.
2. Importar e publicar `ig-social-selling-maintenance.json`.
3. Importar `ig-social-selling-conversation-dispatch.json`; ele pode consultar a
   fila, mas a Edge Function responderá `423` enquanto o gate estiver fechado.
4. Assinar `messages` no App Meta e produzir uma entrada autorizada.
5. Validar idempotência, rascunho `proposed`, painel, SLA e janela sem aprovar
   envio.
6. Habilitar `INSTAGRAM_CONVERSATION_DISPATCH_ENABLED=true` somente depois dos
   cinco itens anteriores e com fila aprovada conhecida.
