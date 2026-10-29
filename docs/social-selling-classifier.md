# Classificador comercial do Social Selling (F22D)

## Serviço e execução

`socialClassifier.ts` é a fonte única do prompt, enumerações, regras
determinísticas, validação de JSON, limitação de confiança e recálculo do score.
O projeto não usa chave OpenAI. Casos não resolvidos pelas regras são enviados
ao Google Gemini já conectado ao n8n pela credencial criptografada
`Google Gemini(PaLM) Api account`.

O endpoint `process-social-engagement` executa a fase A no PostgreSQL. Se a
regra determinística resolver o contexto, ele conclui sem modelo. Caso
contrário, devolve `result_code=classification_required` com
`classifier_request`. O n8n chama `models/gemini-3-flash-preview`, devolve o JSON
ao mesmo endpoint e o backend valida e conclui a fase C.

`classify-social-lead` mantém o mesmo contrato para uso backend isolado:
classifica deterministicamente ou devolve HTTP 202 com
`classification_required`; uma classificação externa pode ser reenviada no
campo `classification`.

## Contrato e fail-safe

O prompt versionado `SOCIAL_SELLING_CLASSIFIER_V1` trata todo texto social como
dado não confiável. A saída deve conter exatamente `intent`,
`commercial_potential`, `lead_score`, `route_type`, `confidence`, `reason`,
`recommended_next_action`, `signals` e `needs_more_signal`.

JSON inválido, chave extra, campo ausente, rota inválida ou valor fora da faixa
gera falha retryable. A próxima ação fica limitada a `human_review`,
`await_new_signal` ou `request_more_context`; não existe opção de envio.

## Rotas e evidência

| Rota | Evidência relevante | Insuficiente por si só |
|---|---|---|
| `franchise` | Abrir unidade, investir em franquia, operação regional | Elogio ou interesse genérico |
| `q3` | Diagnóstico, qualidade, higienização ou processos em contexto empresarial | Simples compra de produto |
| `hotmart` | Curso, treinamento, inscrição, formação ou certificação | “Interessante” sem contexto |
| `nuy` | Compra/uso de aromatizadores, sabonetes e produtos Mundo NUY | Produto industrial PHIQ |
| `no_profile` | Emoji, elogio, comentário genérico ou ambiguidade | Não significa lead perdido |

O contexto do post reforça a confiança, mas não decide sozinho. Se o Gemini
sugerir uma rota sem suporte suficiente no texto atual e na mídia, o backend
limita a confiança a `0.84`.

## Score, histórico e segurança

O score final é sempre recalculado pelo backend. O valor informado pelo Gemini
é apenas validado e descartado. O texto atual explícito prevalece sobre sinal
fraco antigo; a classificação é única por engagement e registra fonte e versão
do prompt.

`historical_backfill` pode gerar score e rota, mas não torna
`contact_eligibility` elegível. Curtida isolada de `browser_collector` não ganha
rota. Nenhuma função desse classificador toca `outbound_actions`, chama
dispatcher, envia DM ou responde comentário.

## Limites atuais

O contexto de mídia só é usado quando já existe em
`social_engagements.metadata.post_context`. O modelo conectado contém `preview`
no identificador; antes da ativação contínua, deve passar pelo conjunto de
avaliação e por um fixture positivo sem outbound.
