# Estratégia de modelos para Social Selling

Decisão revisada em 28/10/2026: o projeto não cria uma integração OpenAI. Ele
reutiliza o Google Gemini já conectado ao n8n pela credencial criptografada
`Google Gemini(PaLM) Api account`. O modelo observado no workflow existente é
`models/gemini-3-flash-preview`.

## Matriz operacional

| Ação | Método | Regra operacional |
|---|---|---|
| Identidade, idempotência, elegibilidade, score, limites e transições | Código determinístico + PostgreSQL | Nunca delegar controles comerciais ou autorização ao modelo |
| Classificação explícita | Regras em `socialClassifier.ts` | Não chama o Gemini quando a evidência atual já resolve a rota |
| Classificação ambígua | Gemini conectado ao n8n | Recebe somente prompt/contexto limitados; saída JSON volta ao backend para validação |
| Confiança e score finais | Backend determinístico | Confiança sem evidência fica limitada a `0.84`; score informado pelo modelo é descartado e recalculado |
| Rascunho de resposta pública | Gemini conectado ao n8n | Prompt separado, saída estrita e persistência `proposed`; toda resposta exige aprovação humana |
| Casos sensíveis, reclamações e baixa confiança | Revisão humana | Nenhum modelo autoriza envio ou altera elegibilidade sozinho |
| Auditoria do classificador | Avaliação versionada e anonimizada | Executada antes de trocar modelo, prompt, schema ou limiar |

## Contrato Gemini

O backend gera `classifier_request` com `system_prompt`, `context_json` e
`prompt_version`. O n8n apenas chama o Gemini e devolve a classificação ao mesmo
endpoint. O backend exige exatamente:

- `intent`;
- `commercial_potential`;
- `lead_score`;
- `route_type`;
- `confidence`;
- `reason`;
- `recommended_next_action`;
- `signals`;
- `needs_more_signal`.

Campos extras, valores fora das enumerações, score fora de `0..100`, confiança
fora de `0..1` ou JSON inválido geram retry controlado. O modelo nunca recebe
segredo, token, service-role key ou permissão de outbound.

## Contrato do rascunho de resposta

Depois que a classificação é concluída, o backend pode devolver um segundo
prompt, `SOCIAL_REPLY_DRAFT_V1`. O contexto é limitado ao comentário, origem e
classificação já validada. O Gemini devolve exatamente `message_text`,
`sentiment` e `analysis_summary`; o backend valida o schema, normaliza o texto e
rejeita links, campos extras e mensagens acima de 500 caracteres.

A versão inicial cria somente `public_reply`, inclusive para comentários
históricos. Canal, alvo, tenant, idempotência e status não vêm do modelo. A RPC
atômica grava a ação com `status=proposed` e `policy_check_status=not_required`.
O job só é concluído depois da persistência, e nenhum componente novo chama a
API da Meta. Aprovação e dispatcher continuam etapas independentes.

## Controles obrigatórios

1. Manter conjunto de avaliação anonimizado por vertical, com exemplos
   positivos, negativos, ambíguos, adversariais e variações de escrita.
2. Medir precisão de rota, falso positivo comercial, cobertura, latência,
   custo, taxa de fallback, erro de schema e revisão humana.
3. Fixar o identificador do modelo homologado. O alias atual contém `preview`;
   uma troca para versão estável exige avaliação comparativa e mudança explícita.
4. Aplicar timeout, backoff, circuit breaker e orçamento no n8n. Falha do
   provider reencaminha o job; nunca inventa rota nem conclui silenciosamente.
5. Limitar e anonimizar o contexto conforme finalidade e LGPD.
6. Manter `INSTAGRAM_DISPATCH_DRY_RUN=true` até smoke real e aprovação formal.

## Separação de responsabilidades

O n8n possui a credencial do Gemini e orquestra as chamadas de classificação e
rascunho. O Supabase monta os dois contratos, valida as saídas, recalcula o
score, define o canal e persiste o estado. O dispatcher de Instagram continua
separado e bloqueado durante a homologação.
