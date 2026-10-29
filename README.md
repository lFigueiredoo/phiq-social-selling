# Social Selling — Instagram

Plataforma multiempresa de social selling para Instagram com Supabase,
Edge Functions, painel React e integração oficial com a Meta. O fluxo principal
recebe webhooks assinados, persiste eventos idempotentes, classifica o contexto
com regras determinísticas/IA, conduz o lead pelos funis e mantém qualquer ação
de saída sob política e aprovação.

## Estado validado em 29/10/2026

O ambiente local está executável e foi validado com:

- 34 migrations aplicadas do zero em PostgreSQL 17;
- 21 Edge Functions versionadas;
- 9 contratos SQL/pgTAP, 2 testes de concorrência e 1 teste HTTP integrado;
- 35 testes Node de contrato e 48 testes Python do coletor;
- build TypeScript/Vite, lint e `npm audit` de produção sem falhas;
- frontend dividido por rota, sem o bundle monolítico anterior.

O Supabase remoto foi alinhado às 34 migrations e às funções
versionadas, com backup anterior ao deploy e testes negativos de autenticação.
O painel CRM foi publicado em
[`phiq-social-selling-panel.vercel.app`](https://phiq-social-selling-panel.vercel.app/)
e validado com a conta administrativa. A classificação não determinística usa o
Google Gemini já conectado ao n8n pela credencial criptografada
`Google Gemini(PaLM) Api account`; o Supabase não precisa de chave de provider.
O worker publicado classifica e atualiza o CRM. A versão com geração de
rascunhos Gemini está validada no repositório, mas sua promoção no n8n ainda
precisa substituir o rascunho duplicado criado pelo import incremental. Uma
auditoria do banco confirmou 12 envios antigos (o último em 15/09/2026) e
nenhum envio em 29/10/2026. O dispatcher foi novamente implantado e está
bloqueado em produção por `INSTAGRAM_DISPATCH_DRY_RUN=true`.
Veja o estado atual em
[`docs/audit-2026-10-29.md`](docs/audit-2026-10-29.md).

## Arquitetura

```text
Instagram/Meta
  -> meta-instagram-webhook (assinatura + idempotência)
  -> PostgreSQL/Supabase (fonte de verdade)
  -> processing_jobs / worker
  -> process-social-engagement
  -> classificador determinístico ou Gemini conectado ao n8n
  -> funil central e funis verticais
  -> outbound_actions (política, revisão e auditoria)
  -> API oficial do Instagram

Usuário autenticado
  -> panel-web
  -> Edge Functions panel-*
  -> RPCs com isolamento por organização
```

Detalhes: [`docs/architecture.md`](docs/architecture.md),
[`docs/social-crm-pipelines.md`](docs/social-crm-pipelines.md) e
[`docs/social-selling-orchestrator.md`](docs/social-selling-orchestrator.md).

## Rodar localmente

Pré-requisitos: Node.js 24+, Python 3.12+, Docker Desktop e Supabase CLI.

1. Inicie o Docker Desktop.
2. Na raiz do projeto, execute `supabase start --exclude vector`. O projeto
   não usa o serviço opcional de busca vetorial.
3. Prepare um arquivo local de secrets seguindo `.env.example`. Para servir
   as funções com arquivo personalizado, use:

   ```powershell
   supabase functions serve --env-file supabase/.env.functions.local
   ```

4. Configure `panel-web/.env.local` para o Supabase desejado. Para o stack
   local, use a URL e a chave publicável exibidas por `supabase status`.
5. Inicie o painel:

   ```powershell
   Set-Location panel-web
   npm ci
   npm run dev
   ```

O painel abre em `http://localhost:5173`. Não coloque service-role key,
token da Meta ou segredo de worker em variáveis `VITE_*`.

## Verificação

Com o Supabase local ativo:

```powershell
Set-Location panel-web
npm run check
npm audit --omit=dev --audit-level=moderate
Set-Location ..

supabase test db
node supabase/tests/vertical_concurrency.cjs
node supabase/tests/social_orchestrator_concurrency.cjs
node supabase/tests/social_orchestrator_http_local.cjs

.\.venv\Scripts\python.exe -m unittest discover `
  -s .\collectors\instagram-likers -p 'test_*.py' -v
```

O teste HTTP exige `supabase functions serve` em outro terminal e um
`N8N_WORKER_SECRET` local configurado.

## Limite do coletor de curtidas

`collectors/instagram-likers/` automatiza a interface web do Instagram. Ele é
experimental e fica fora do caminho de produção porque contradiz os ADR-001 e
ADR-007, que exigem somente APIs oficiais e proíbem scraping/automação de
navegador. Seus testes foram mantidos para preservar o trabalho existente, mas
o coletor não deve ser implantado nem conectado ao CRM oficial sem uma nova
decisão arquitetural e revisão de risco.

## Segurança e implantação

- `.env*`, sessões, perfis de navegador e service accounts são ignorados pelo
  Git; os arquivos `*.example` nunca devem conter valores reais.
- Funções `panel-*` usam JWT de usuário e validação de membership; funções de
  worker usam segredo backend-only; webhook da Meta valida assinatura.
- O modo `INSTAGRAM_DISPATCH_DRY_RUN=true` deve permanecer ativo até o teste
  controlado de produção.
- Antes do deploy, rotacione segredos reutilizados, confirme a versão da API no
  App Dashboard da Meta e faça backup do banco remoto.

Consulte [`docs/setup.md`](docs/setup.md) para o setup detalhado e
[`docs/audit-2026-10-29.md`](docs/audit-2026-10-29.md) para achados, correções
e bloqueios de produção.
