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
- 35 migrations alinhadas entre local e remoto;
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

A configuração segura para novos ambientes continua sendo
`INSTAGRAM_DISPATCH_DRY_RUN=true`. Em produção, o piloto autorizado em
24/11/2026 usa `INSTAGRAM_DISPATCH_DRY_RUN=false` junto de
`INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=true`: apenas respostas públicas
aprovadas entram na fila do dispatcher, e Direct permanece bloqueado.

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
- o primeiro envio controlado concluiu como `sent` às 11:08:14 de 24/11/2026,
  com `provider_action_id=18080442827741679`; os polls seguintes não repetiram
  o envio;
- o rollback operacional é restaurar
  `INSTAGRAM_DISPATCH_DRY_RUN=true`; a trava de tipo deve permanecer ativa.
