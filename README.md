# Social Selling — Instagram

Plataforma multiempresa de social selling para Instagram com Supabase,
Edge Functions, painel React e integração oficial com a Meta. O fluxo principal
recebe webhooks assinados, persiste eventos idempotentes, classifica o contexto
com regras determinísticas/IA, conduz o lead pelos funis e mantém qualquer ação
de saída sob política e aprovação.

## Estado validado em 24/11/2026

O ambiente local está executável e foi validado com:

- 48 migrations alinhadas e validadas no Supabase remoto;
- 26 Edge Functions versionadas, incluindo inbox conversacional, operação e
  manutenção;
- 10 contratos SQL/pgTAP, 2 testes de concorrência e 1 teste HTTP integrado;
- 52 testes Node de contrato e avaliação de modelo, além de 48 testes Python
  do coletor experimental;
- build TypeScript/Vite, lint e `npm audit` de produção sem falhas;
- frontend dividido por rota, sem o bundle monolítico anterior.

O Supabase remoto foi alinhado às 48 migrations e às funções
versionadas, com backup anterior ao deploy e testes negativos de autenticação.
O painel CRM foi publicado em
[`phiq-social-selling-panel.vercel.app`](https://phiq-social-selling-panel.vercel.app/)
e validado com a conta administrativa. A classificação não determinística usa o
Google Gemini já conectado ao n8n pela credencial criptografada
`Google Gemini(PaLM) Api account`; o Supabase não precisa de chave de provider.
O worker `IG Social Selling — Orchestrator Worker` foi limpo e publicado com
19 nós, um único agendamento e geração de rascunhos Gemini para aprovação
humana. A execução controlada de produção concluiu com sucesso em 9,64 s e
encerrou no gate de fila vazia, sem criar ou enviar ação externa. Uma
auditoria do banco confirmou 12 envios antigos (o último em 15/09/2026) e
nenhum envio em 29/10/2026. Em 23/11/2026, o token Meta de
`@phiq.oficial` foi renovado e o painel voltou a ler mídias e contagens reais.
O código e o banco agora suportam coexistência segura entre o Instagram Login
atual e um futuro Unified Login, com tokens separados, aliases explícitos de ID
e dead letter para webhook sem mapeamento. O modo ativo continua sendo
`instagram_login`. O dispatcher opera em piloto assistido: resposta pública e
Direct elegível exigem aprovação humana; Direct fica restrito a comentário novo
em tempo real, interesse comercial explícito, score mínimo 70, janela da Meta e
limite de 5 mensagens por 24 horas.

Em 24/11/2026 foi publicada uma segunda camada para continuidade de conversas:
inbox de Direct com SLA, responsável, prioridade, opt-out, janela de 24 horas,
catálogo comercial aprovado, feedback do Gemini, alertas operacionais e rotinas
de privacidade. O backend está ativo e o painel possui as rotas `/conversas` e
`/operacao`. O envio de Direct conversacional continua bloqueado pelo gate
independente `INSTAGRAM_CONVERSATION_DISPATCH_ENABLED=false` até a assinatura
`messages` da Meta e um evento real de entrada serem homologados. Os workflows
n8n dessa camada estão versionados, mas sua promoção na instância precisa ser
confirmada antes da ativação. Nenhuma mensagem foi enviada por essa entrega.
Veja [`docs/meta-setup.md`](docs/meta-setup.md) e o último inventário completo em
[`docs/audit-2026-11-24-conversational.md`](docs/audit-2026-11-24-conversational.md).

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
- Novos ambientes devem nascer com `INSTAGRAM_DISPATCH_DRY_RUN=true`,
  `INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=true` e
  `INSTAGRAM_PRIVATE_REPLY_PILOT_ENABLED=false`.
- Antes do deploy, rotacione segredos reutilizados, confirme a versão da API no
  App Dashboard da Meta e faça backup do banco remoto.

Consulte [`docs/setup.md`](docs/setup.md) para o setup detalhado e
[`docs/audit-2026-10-29.md`](docs/audit-2026-10-29.md) para achados, correções
e bloqueios de produção.
