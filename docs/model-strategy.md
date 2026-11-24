# Estratégia de modelos para Social Selling

Decisão revisada em 24/11/2026: o projeto não cria uma integração OpenAI. Ele
reutiliza o Google Gemini já conectado ao n8n pela credencial criptografada
`Google Gemini(PaLM) Api account`. O workflow fixa
`models/gemini-3.5-flash-lite` para classificação ambígua e
`models/gemini-3.6-flash` para redação de rascunhos.

## Matriz operacional

| Ação | Método | Regra operacional |
|---|---|---|
| Identidade, idempotência, elegibilidade, score, limites e transições | Código determinístico + PostgreSQL | Nunca delegar controles comerciais ou autorização ao modelo |
| Classificação explícita | Regras em `socialClassifier.ts` | Não chama o Gemini quando a evidência atual já resolve a rota |
| Classificação ambígua | Gemini conectado ao n8n | Recebe somente prompt/contexto limitados; saída JSON volta ao backend para validação |
| Confiança e score finais | Backend determinístico | Confiança sem evidência fica limitada a `0.84`; score informado pelo modelo é descartado e recalculado |
| Rascunho de resposta pública, Private Reply ou continuidade elegível | Gemini conectado ao n8n | Prompt separado por canal, histórico limitado, catálogo aprovado, saída estrita e persistência `proposed`; toda resposta exige aprovação humana |
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
prompt, `SOCIAL_REPLY_DRAFT_V3`. Para comentário, o contexto é limitado à
origem e classificação já validada. Para continuidade, inclui somente o
histórico recente necessário e as ofertas compatíveis do catálogo aprovado,
com afirmações permitidas e proibidas explícitas. O Gemini devolve exatamente `message_text`,
`sentiment` e `analysis_summary`; o backend valida o schema, normaliza o texto e
rejeita links, campos extras, mensagens acima de 500 caracteres ou acima de
1.000 bytes UTF-8.

O backend, não o modelo, escolhe o canal. `private_reply` é candidato apenas
para `realtime/comment`, intenção comercial explícita, potencial médio/alto,
score >= 70 e `needs_more_signal=false`. Qualquer histórico permanece
`public_reply`. Canal, alvo, tenant, idempotência e status não vêm do modelo. A
RPC atômica grava `status=proposed`; Private Reply passa pela política da Meta
antes de poder ser aprovado. Aprovação e dispatcher continuam etapas
independentes.

## Controles obrigatórios

1. Manter conjunto de avaliação anonimizado por vertical, com exemplos
   positivos, negativos, ambíguos, adversariais e variações de escrita.
2. Medir precisão de rota, falso positivo comercial, cobertura, latência,
   custo, taxa de fallback, erro de schema e revisão humana.
3. Fixar os identificadores homologados e alterá-los somente com avaliação,
   fixture positivo, registro da versão e rollback preparado.
4. Manter três tentativas, com intervalo de um segundo, nos dois nós Gemini. O
   backoff do job continua separado e limitado a 15 minutos. Falha do provider
   reencaminha o job; nunca inventa rota nem conclui silenciosamente.
5. Limitar e anonimizar o contexto conforme finalidade e LGPD.
6. Novos ambientes permanecem com `INSTAGRAM_DISPATCH_DRY_RUN=true`. O piloto
   de produção autorizado em 24/11/2026 usa `false` junto de
   `INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=false`,
   `INSTAGRAM_PRIVATE_REPLY_PILOT_ENABLED=true` e limite 5/24h. Fora dessa
   combinação explícita, Direct continua fail-closed.
7. Medir aceitação, edição, rejeição e marcação `unsafe` dos rascunhos. O
   painel registra feedback por mensagem e revisor sem permitir que o modelo
   aprenda ou publique automaticamente.
8. Oferta, preço ou URL não presente no catálogo ativo não pode aparecer no
   rascunho. A URL também é revalidada no backend antes da persistência.

## Separação de responsabilidades

O n8n possui a credencial do Gemini e orquestra as chamadas de classificação e
rascunho. O Supabase monta os dois contratos, valida as saídas, recalcula o
score, define o canal e persiste o estado. O dispatcher de Instagram continua
separado e somente reclama ação aprovada depois de revalidar todos os gates.
