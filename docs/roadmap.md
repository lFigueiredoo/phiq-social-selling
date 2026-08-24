# Roadmap — Sistema de Social Selling para Instagram

Cada passo só começa após o anterior estar concluído e aprovado
explicitamente. Nenhum passo avança automaticamente para o seguinte.

- [x] **PASSO 01 — Fundação**
  Estrutura de diretórios, documentação inicial (arquitetura, ADRs,
  roadmap), `.env.example`, `.gitignore`. Nenhum banco, nenhuma API
  externa, nenhuma dependência além do estritamente necessário.

- [ ] **PASSO 02 — Supabase mínimo**
  Criação do projeto Supabase e schema inicial das tabelas de
  infraestrutura (`webhook_events`, `processing_jobs`,
  `outbound_actions`, `organizations`, `instagram_accounts`), com
  migrations aditivas propostas antes de execução.

- [ ] **PASSO 03 — Meta App**
  Criação do App na Meta for Developers, produto Instagram adicionado,
  Business Manager configurado.

- [ ] **PASSO 04 — Autenticação Meta**
  Conexão da conta Instagram Business/Creator, obtenção e
  armazenamento seguro do access token (via secrets, nunca em
  código/frontend).

- [ ] **PASSO 05 — Webhook**
  Implementação da Edge Function receptora: validação de assinatura,
  identificação de evento, persistência em `webhook_events`,
  enfileiramento em `processing_jobs`, resposta HTTP 200 rápida.

- [ ] **PASSO 06 — Primeiro comentário real**
  Registro de subscription de webhook `comments` na Meta e validação
  ponta a ponta com um comentário real chegando até `webhook_events`.

- [ ] **PASSO 07 — Idempotência e fila**
  Reforço das constraints de idempotência e implementação do consumo
  da fila `processing_jobs` pelo worker (n8n).

- [ ] **PASSO 08 — IA**
  Integração com a OpenAI, sistema centralizado e versionado de
  prompts, primeira análise real de um comentário (intenção,
  sentimento, potencial comercial).

- [ ] **PASSO 09 — Decision Engine**
  Implementação das regras AUTO / REVISÃO / BLOQUEADO e da tabela
  `automation_rules`, gerando registros em `outbound_actions`.

- [ ] **PASSO 10 — Resposta pública**
  Primeira resposta automática real a um comentário, via
  `outbound_actions` → Instagram Graph API, com validação do HTTP
  status retornado pela Meta.

- [ ] **PASSO 11 — Lead Score**
  Implementação da metodologia de pontuação transparente e das
  tabelas `leads` / `lead_scores`.

- [ ] **PASSO 12 — Google Sheets**
  Sincronização unidirecional de leads qualificados para uma planilha
  operacional.

- [ ] **PASSO 13 — Private Reply**
  Envio de mensagem privada a partir de um comentário, respeitando a
  janela de 7 dias e o limite de uma private reply por comentário.

- [ ] **PASSO 14 — DM**
  Continuidade de conversa por DM após resposta do usuário à private
  reply, respeitando a janela de 24 horas.

- [ ] **PASSO 15 — Dashboard**
  Interface Lovable/React para visualização de métricas, feed de
  interações, leads quentes e ficha de lead.

- [ ] **PASSO 16 — Produção / App Review**
  Submissão das permissões avançadas da Meta para revisão, ativação em
  produção e checklist de segurança/LGPD antes do uso real.
