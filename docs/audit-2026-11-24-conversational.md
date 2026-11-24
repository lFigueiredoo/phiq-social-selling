# Auditoria de produção — inbox conversacional e operação

Data de corte: 24/11/2026.

## Resultado

A base de comentários e Private Reply foi preservada. A nova camada de
continuidade de Direct está implementada e publicada no Supabase e no painel,
mas permanece deliberadamente sem capacidade de envio. O gate independente
`INSTAGRAM_CONVERSATION_DISPATCH_ENABLED` continua desligado até existir prova
de uma entrada real pelo webhook `messages` e os workflows versionados estarem
promovidos na instância n8n.

Nenhuma resposta pública, Private Reply ou mensagem conversacional foi enviada
durante esta entrega.

## Entregue

- 8 migrations incrementais aplicadas, totalizando 48 migrations alinhadas;
- inbox multiempresa com conversas, mensagens, não lidas, prioridade,
  responsável, SLA, janela de resposta, status e opt-out;
- ingestão idempotente de `entry[].messaging[]`, ignorando echo, delivery,
  evento sem `mid` e mensagem autodirecionada;
- claim atômico para jobs de comentário e mensagem;
- rascunhos Gemini com histórico limitado, catálogo aprovado e schema estrito;
- aprovação humana obrigatória antes de qualquer continuidade;
- limites atômicos de 5 mensagens/24h por conversa e limite configurável por
  conta/organização;
- dispatcher com gate próprio, tratamento de resultado incerto e reconciliação
  por `provider_message_id`;
- painel `/conversas` para operação diária;
- painel administrativo `/operacao` para métricas, alertas, SLA, catálogo,
  retenção e privacidade;
- catálogo inicial preenchido somente com fatos das páginas oficiais de
  Franquia PHIQ, Q³, Produtos PHIQ, PHIQ LAB e InovaPHIQ; registros-base sem
  fonte pública (`Cursos` e `NUY Creators`) ficaram inativos;
- opt-out, supressão de identidade e anonimização explícita;
- retenção configurável, desabilitada por padrão;
- monitor de dead letter, falha de outbound, SLA, token Meta, silêncio de
  webhook e erros de modelo;
- suíte de avaliação fixa para impedir regressão silenciosa de modelo;
- CI de aplicação e banco;
- 52 testes Node, lint e build de produção aprovados;
- 10 Edge Functions modificadas/novas implantadas e testes negativos de
  autenticação aprovados;
- painel publicado em
  `https://phiq-social-selling-panel.vercel.app`.

## Controles que permanecem fechados

- `INSTAGRAM_CONVERSATION_DISPATCH_ENABLED=false`;
- toda mensagem outbound nasce `proposed`;
- o Gemini não escolhe canal, tenant, destinatário, limite, janela ou status;
- histórico de comentários não inicia Direct;
- URLs e afirmações comerciais ficam restritas ao catálogo ativo;
- retenção não executa enquanto `retention_enabled=false`;
- um timeout de envio fica em estado de falha incerta e não é repetido
  automaticamente.

## Pendente de evidência externa

1. Confirmar no App Dashboard a assinatura do campo `messages` para a conta
   profissional conectada.
2. Promover os workflows:
   - `ig-social-selling-orchestrator.json`;
   - `ig-social-selling-maintenance.json`;
   - `ig-social-selling-conversation-dispatch.json`.
3. Enviar uma mensagem de uma conta de teste autorizada e validar exatamente
   um evento, um job, uma conversa e um rascunho `proposed`.
4. Repetir a entrega do mesmo evento e confirmar idempotência de mensagem,
   unread e SLA.
5. Conferir a conversa e o rascunho no painel sem aprovar envio.
6. Somente após essas evidências decidir a ativação do gate conversacional.

O controle de navegador compartilhado falhou por timeout de CDP durante a
janela desta auditoria. A máquina local também não possui a chave SSH da EC2.
Por isso, os itens acima não foram marcados como concluídos por suposição.

## Evidência técnica

- `npm run check`: lint, 52 testes e build aprovados;
- `supabase db lint --linked --level warning`: nenhuma advertência ou erro;
- funções de worker retornam `401` sem `x-worker-secret`;
- funções de painel retornam `401` sem JWT;
- migrations remotas aplicadas e funções novas em estado `ACTIVE`;
- deploy Vercel de produção pronto e associado ao domínio principal.

## Próxima janela operacional

Executar os seis itens de evidência externa em uma sessão administrativa
estável. Não é necessário alterar banco, redesenhar o painel ou trocar o
Gemini. O primeiro envio real, se aprovado, deve ser um único caso autorizado,
com fila conhecida e rollback imediato para o gate `false`.
