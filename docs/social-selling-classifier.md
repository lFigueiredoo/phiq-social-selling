# Classificador comercial do Social Selling (F22D)

## Serviço e execução

`classify-social-lead` é uma Edge Function de backend. Ela exige `POST`, `x-worker-secret` igual a `N8N_WORKER_SECRET` e IDs de organização, lead e engagement. Busca o contexto no banco com filtro de organização e contato; o chamador não envia texto nem resultado de classificação. `socialClassifier.ts` contém o prompt, as regras e a validação. `openaiSocialClassifier.ts` contém somente o adapter do provider. A função salva o resultado com `save_social_classification`, que chama o motor `apply_social_assessment` do F22C.

O repositório usa `OPENAI_API_KEY` para a análise social. O adapter exige
`SOCIAL_CLASSIFIER_MODEL` e aceita `SOCIAL_CLASSIFIER_REASONING_EFFORT` no
ambiente backend. A configuração inicial recomendada é `gpt-6-luna` com esforço
`none`, por ser uma classificação focada e de alto volume; a seleção completa
está em [model-strategy.md](model-strategy.md). Sem chave/modelo, apenas a camada
determinística roda; no orquestrador, contexto não resolvido fica retryable em
vez de inventar uma rota. O adapter usa a
[Responses API com Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
`store: false`, timeout e schema estrito. Nenhum teste chama o provider real.

O prompt único é `SOCIAL_SELLING_CLASSIFIER_V1`. Texto social é tratado como dado não confiável. O prompt exige evidência, separa certeza de rota de qualidade do lead e não gera mensagens. A resposta deve conter exatamente `intent`, `commercial_potential`, `lead_score`, `route_type`, `confidence`, `reason`, `recommended_next_action`, `signals` e `needs_more_signal`. A próxima ação fica limitada a `human_review`, `await_new_signal` ou `request_more_context`; não há opção de envio. JSON inválido, campo faltante, rota inválida ou número fora da faixa cai em `no_profile` com confiança intermediária e `needs_more_signal = true`.

## Rotas e evidência

| Rota | Evidência relevante | Insuficiente por si só |
|---|---|---|
| `franchise` | Abrir unidade, investir em franquia, operação regional | Elogio ou interesse genérico |
| `q3` | Diagnóstico, qualidade, higienização ou processos em contexto empresarial | Simples compra de produto |
| `hotmart` | Curso, treinamento, inscrição, formação ou certificação | “Interessante” sem contexto |
| `nuy` | Compra/uso de aromatizadores, sabonetes e produtos Mundo NUY | Produto industrial PHIQ |
| `no_profile` | Emoji, elogio, comentário genérico ou ambiguidade | Não significa lead perdido |

Uma regra determinística requer termos combinados do texto da pessoa. O contexto do post pode reforçar a confiança, mas não decide sozinho. Casos explícitos evitam chamada de IA. Para casos restantes, a IA só pode obter confiança de auto-rota quando existe suporte no texto atual e no contexto da mídia; se faltar esse suporte, a confiança é limitada a `0.84`.

## Score, confidence e política

O score final é recalculado de forma determinística: intenção de rota explícita (+35), item/serviço específico (+20), pergunta de preço/compra (+20), interesse repetido na mesma rota (+15), mais de uma interação (+5) e post coerente (+5), com limite de 100. Interesse genérico recebe no máximo um pequeno sinal; emoji isolado vale 0. O score informado pela IA é validado, mas não é usado como valor final.

`confidence` mede certeza sobre a **rota**, não qualidade comercial. O motor F22C aplica os limites configuráveis por organização: padrão `>= 0.85` roteia, `0.60–0.84` permanece em `qualification` pedindo mais sinal e `< 0.60` vai a `no_profile` (ou permanece em qualificação se a política local assim definir). Uma intenção comercial forte ainda pode ter confiança baixa quando Q3 e franquia forem indistinguíveis.

## Histórico, reclassificação e segurança

O serviço lê a interação atual, até oito interações recentes, contexto de mídia armazenado no engagement e um resumo anterior, quando existir. O texto atual explícito prevalece sobre sinal fraco antigo. A classificação é única por engagement em `social_classifications`, com fonte (`deterministic`, `ai` ou `fallback`), versão do prompt e horário. Reclassificar uma rota existente exige engagement substantivo novo; a RPC registra rota e confiança anteriores no histórico antes de aplicar a nova avaliação. Repetir o mesmo engagement retorna o registro anterior.

`historical_backfill` pode gerar score e rota, mas não torna `contact_eligibility` elegível. Curtida de `browser_collector` isolada não ganha rota ou elegibilidade. Nenhuma função nova toca `outbound_actions`, chama dispatcher, envia DM ou responde comentário. O pipeline legado de análise de comentários permanece separado e ainda pode propor uma ação histórica, como documentado em `social-crm-pipelines.md`.

## Limites atuais

O contexto do post só é usado quando já está em
`social_engagements.metadata.post_context`; o classificador não consulta a Meta
para enriquecer mídia. Os comentários existentes não carregam esse texto
automaticamente. O worker está versionado em
`n8n/workflows/ig-social-selling-orchestrator.json`, mas ainda precisa ser
importado, configurado e ativado no n8n remoto. `N8N_WORKER_SECRET` e
`SUPABASE_FUNCTIONS_URL` são lidos do ambiente do contêiner, nunca do JSON.
