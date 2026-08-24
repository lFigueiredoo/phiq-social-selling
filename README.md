# Social Selling — Instagram

Sistema de Social Selling e Automação de Instagram, construído
exclusivamente sobre APIs oficiais da Meta (Instagram Graph API,
Instagram Messaging API e Webhooks oficiais), com análise de IA e fluxo
de decisão humano-no-loop.

> Status atual: **PASSO 01 — Fundação**. Nenhuma integração externa foi
> configurada ainda. Veja `docs/roadmap.md` para o plano completo.

## Estrutura do projeto

```
/
├── docs/
│   ├── architecture.md   # arquitetura aprovada do sistema
│   ├── decisions.md      # ADRs — decisões arquiteturais registradas
│   ├── setup.md          # estado atual e pré-requisitos de setup
│   └── roadmap.md        # plano de implementação passo a passo
│
├── supabase/
│   ├── functions/        # Edge Functions (vazio até o PASSO 05)
│   └── migrations/       # migrations SQL (vazio até o PASSO 02)
│
├── n8n/
│   └── workflows/        # workflows exportados do n8n (vazio ainda)
│
├── scripts/              # scripts utilitários (vazio ainda)
│
├── .env.example          # variáveis de ambiente necessárias (sem valores reais)
└── .gitignore
```

## Princípios do projeto

- Somente APIs oficiais da Meta — sem scraping, sem automação de
  navegador.
- Todo webhook é recebido por uma Supabase Edge Function, nunca
  diretamente pelo n8n.
- A IA nunca envia mensagens diretamente: toda saída passa por um
  Decision Engine e por uma fila de `outbound_actions`.
- Toda ação (entrada ou saída) tem controle de idempotência.
- Arquitetura preparada para multiempresa desde o início.

Detalhes completos em `docs/architecture.md` e `docs/decisions.md`.

## Próximos passos

Ver `docs/roadmap.md`. O próximo passo planejado é o **PASSO 02 —
Supabase mínimo**, que só deve começar mediante aprovação explícita.
