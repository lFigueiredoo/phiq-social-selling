# Arquitetura — Sistema de Social Selling para Instagram

Este documento descreve a arquitetura aprovada do sistema. Ele será atualizado
conforme o projeto evoluir, mas o fluxo principal e a divisão de
responsabilidades entre camadas não devem mudar sem um novo ADR
(ver `decisions.md`).

## Fluxo principal

```
Instagram
   │  (usuário comenta / envia mensagem)
   ▼
Meta Webhook
   │  POST assinado (X-Hub-Signature-256)
   ▼
Supabase Edge Function (Webhook Receiver)
   │  valida assinatura, identifica o tipo de evento,
   │  persiste em webhook_events, enfileira em processing_jobs,
   │  responde HTTP 200 rapidamente
   ▼
processing_jobs (fila em Postgres)
   ▼
n8n (worker)
   │  consome o job; casos explícitos ficam no backend,
   │  casos ambíguos e rascunhos chamam o Gemini já conectado
   ▼
Google Gemini (credencial criptografada no n8n)
   │  análise semântica: intenção, sentimento, potencial comercial
   ▼
Decision Engine (regras em n8n + automation_rules)
   │  decide AUTO / REVISÃO / BLOQUEADO
   ▼
outbound_actions (fila de saída)
   │  toda ação de saída passa por aqui antes de ir para a Meta —
   │  nunca a IA envia diretamente
   ▼
Instagram API (Graph API oficial)
   │  resposta pública ao comentário e/ou private reply
   │  e continuidade de Direct somente após resposta do contato
   ▼
Leads / Interactions (Supabase — fonte de verdade)
   ▼
Google Sheets / Dashboard (saídas operacionais e de visualização)
```

## Responsabilidade de cada camada

### Meta Webhook
Envia eventos de comentário e mensagem em tempo real. Não guarda estado.
Exige resposta rápida (HTTP 200) e validação de assinatura.

### Supabase Edge Function (Webhook Receiver)
Único ponto que recebe chamadas diretas da Meta. Responsabilidades:
- validar a assinatura do webhook;
- identificar o tipo de evento;
- persistir o payload bruto em `webhook_events` (idempotência por
  `external_event_id`);
- criar um `processing_job` correspondente;
- retornar HTTP 200 o mais rápido possível.

Não faz chamadas a provider de IA, não decide nada e não envia respostas ao
Instagram. É deliberadamente "burra" e rápida.

### processing_jobs (fila)
Armazena o trabalho pendente de forma durável em Postgres. Permite que o
processamento pesado (IA, decisão, envio) aconteça de forma assíncrona e
resiliente, sem bloquear o webhook.

### n8n (worker de orquestração)
Consome jobs da fila. O backend devolve prompt e contexto limitados somente
quando as regras não resolvem a classificação. O n8n chama o Gemini com a
credencial criptografada e devolve o JSON ao backend. O worker também pode
gerar uma sugestão de resposta com histórico limitado e catálogo aprovado.
Nunca decide elegibilidade nem chama a API do Instagram para enviar nada nesse
fluxo.

### Google Gemini
Executa classificação semântica ambígua e redação de rascunhos. Não recebe
tokens do Supabase ou da Meta, não aplica score final, não altera funil e não
possui permissão de disparar ações. Ofertas, preços, URLs e afirmações
comerciais ficam limitados ao catálogo aprovado no banco.

### Decision Engine
Aplica as regras de automação (tabela `automation_rules`, quando
existir) sobre o resultado da IA e decide o nível de resposta: AUTO,
REVISÃO ou BLOQUEADO. É o único componente autorizado a gerar uma
`outbound_action`.

### outbound_actions (fila de saída)
Toda ação que vai sair do sistema em direção à Meta (resposta pública,
private reply, DM) passa primeiro por aqui. Isso garante um ponto único
de controle de idempotência, rate limit e auditoria antes de qualquer
chamada externa.

Mensagens de continuidade usam a fila irmã
`instagram_conversation_messages`, com o mesmo princípio: nascem como
`proposed`, passam por aprovação humana, janela de 24 horas, opt-out, limite
atômico por conta e limite de 5/24h por conversa. O dispatcher possui um gate
próprio e falha fechado.

### Instagram API (Graph API oficial)
Único canal de saída para o Instagram. Usa exclusivamente endpoints
oficiais (comentários, private replies, mensagens dentro das janelas
permitidas). Nenhuma automação de navegador, nenhum scraping.

### Leads / Interactions (Supabase)
Fonte de verdade do sistema. Todo o histórico de comentários, mensagens,
análises de IA e ações de saída fica registrado aqui de forma auditável.

### Google Sheets / Dashboard
Saídas operacionais e de visualização. Nunca são a fonte de verdade —
apenas refletem o que já está no banco.

## Princípios que esta arquitetura respeita

- A Meta nunca chama o n8n diretamente em produção — apenas a Edge
  Function.
- O webhook apenas valida, identifica, persiste, enfileira e retorna
  rápido; processamento pesado ocorre depois, fora do ciclo de request
  do webhook.
- A IA nunca envia mensagem diretamente: o caminho obrigatório é
  IA → Decision Engine → outbound_actions → integração Meta.
- Toda ação de saída terá mecanismo de idempotência.
- Apenas APIs oficiais da Meta são usadas — sem scraping, sem Puppeteer/
  Selenium, sem automação de navegador.
- Curtidas individuais não fazem parte do escopo do MVP.
- Nenhuma automação depende de descobrir se um perfil é público.

## Status observado em 24/11/2026

Banco, Edge Functions, classificador, funis, painel, resposta pública e piloto
de Private Reply estão em produção. A nova inbox conversacional, operação,
catálogo, feedback de modelo, privacidade e monitoramento também foram
publicados. O envio de continuidade permanece bloqueado até a assinatura
`messages`, o evento real de entrada e a promoção dos workflows n8n serem
confirmados. O inventário detalhado está em
[`audit-2026-11-24-conversational.md`](audit-2026-11-24-conversational.md).
