# Registro de Decisões Arquiteturais (ADRs)

Cada ADR documenta uma decisão tomada, o contexto e a consequência.
Decisões não devem ser revertidas silenciosamente — se uma mudar,
registre um novo ADR referenciando o anterior.

---

## ADR-001 — Usar somente API oficial da Meta

**Status:** Aprovado

**Contexto:** O sistema precisa capturar comentários, analisar
interações e responder no Instagram de forma sustentável e sem risco de
bloqueio de conta.

**Decisão:** Toda a arquitetura principal usará exclusivamente
Instagram Graph API, Instagram Messaging API e Webhooks oficiais da
Meta. Nenhuma funcionalidade dependerá de scraping, automação de
navegador ou métodos não oficiais.

**Consequência:** Algumas funcionalidades desejadas inicialmente (ex.:
lista individual de quem curtiu uma publicação) não são viáveis, pois a
API oficial não as expõe. Nesses casos, a funcionalidade é adaptada
(ex.: curtidas tratadas como métrica agregada) em vez de contornada por
scraping.

---

## ADR-002 — Edge Function do Supabase recebe os webhooks

**Status:** Aprovado

**Contexto:** A Meta exige resposta HTTP rápida e validação de
assinatura em toda chamada de webhook.

**Decisão:** O receptor primário de todos os webhooks da Meta é uma
Supabase Edge Function, não o n8n.

**Consequência:** A Edge Function precisa ser leve e determinística:
validar, persistir e enfileirar — nada de chamadas à OpenAI ou à API do
Instagram nesse ponto.

---

## ADR-003 — n8n não é receptor primário do webhook da Meta

**Status:** Aprovado

**Contexto:** Decorre do ADR-002.

**Decisão:** A Meta nunca chamará o n8n diretamente em produção. O n8n
atua como worker, consumindo jobs já persistidos pela Edge Function.

**Consequência:** Uma indisponibilidade temporária do n8n não causa
perda de eventos — eles ficam retidos na fila até serem processados.

---

## ADR-004 — Banco é a fonte de verdade; Google Sheets é saída operacional

**Status:** Aprovado

**Contexto:** Times comerciais costumam preferir trabalhar em planilha,
mas isso não pode comprometer a integridade dos dados.

**Decisão:** O Supabase/PostgreSQL é a única fonte de verdade. O Google
Sheets recebe uma sincronização unidirecional (banco → planilha) e
nunca o contrário.

**Consequência:** Qualquer edição manual feita diretamente na planilha
pode ser sobrescrita na próxima sincronização. Isso deve ser comunicado
claramente aos usuários da planilha quando o MVP 2 for implementado.

---

## ADR-005 — IA não envia mensagens diretamente

**Status:** Aprovado

**Contexto:** É necessário um ponto único de controle sobre o que
efetivamente sai do sistema em direção ao usuário do Instagram.

**Decisão:** O fluxo obrigatório é: IA → Decision Engine →
`outbound_actions` → integração Meta. A camada de IA apenas produz uma
análise e uma sugestão de resposta; nunca chama a API do Instagram.

**Consequência:** Toda resposta automática passa por uma verificação de
regra de negócio (AUTO/REVISÃO/BLOQUEADO) antes de sair, mesmo quando a
IA tem alta confiança na resposta gerada.

---

## ADR-006 — Toda ação externa precisa de idempotência

**Status:** Aprovado

**Contexto:** Webhooks da Meta podem ser entregues mais de uma vez; sem
controle, isso geraria respostas duplicadas, DMs duplicadas e leads
duplicados.

**Decisão:** Todo evento recebido e toda ação de saída terão uma chave
de idempotência (`external_id` único) verificada antes de qualquer
processamento ou envio.

**Consequência:** Estruturas como `webhook_events`, `instagram_comments`
e `outbound_actions` precisarão de constraints UNIQUE sobre os
identificadores externos desde a criação das tabelas (a partir do
PASSO 02).

---

## ADR-007 — Scraping não será utilizado

**Status:** Aprovado

**Contexto:** Decorre do ADR-001, reforçado explicitamente para deixar
claro que isso vale mesmo quando a API oficial tiver limitações (ex.:
curtidas individuais).

**Decisão:** Nenhuma funcionalidade do sistema usará scraping,
Puppeteer, Selenium ou qualquer simulação de navegador/usuário para
obter dados do Instagram.

**Consequência:** Funcionalidades que dependam exclusivamente de dados
não expostos pela API oficial serão sinalizadas como inviáveis, com
alternativa oficial sugerida, em vez de implementadas por meio
alternativo.

---

## ADR-008 — Arquitetura preparada para multiempresa

**Status:** Aprovado

**Contexto:** O sistema inicialmente atenderá uma única marca, mas deve
suportar múltiplas organizações e contas de Instagram no futuro sem
retrabalho estrutural.

**Decisão:** Desde as primeiras tabelas com dados de negócio, o desenho
incluirá `organization_id` e `instagram_account_id` como chaves de
isolamento, mesmo que o MVP 1 opere com apenas uma organização.

**Consequência:** Consultas e políticas de acesso (RLS) já nascerão
filtrando por organização, evitando uma migração de dados dolorosa mais
adiante.
