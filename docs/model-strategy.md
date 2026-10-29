# Estratégia de modelos para Social Selling

Decisão revisada em 28/10/2026. O objetivo é maximizar precisão comercial e
segurança sem usar um modelo caro em toda interação. Regras determinísticas,
política de funil e autorização continuam sendo código e banco; modelos apenas
classificam, redigem rascunhos ou apoiam revisão.

## Matriz recomendada

| Ação | Modelo/método | Configuração inicial | Regra operacional |
|---|---|---|---|
| Identidade, idempotência, elegibilidade, limites e transições | Código determinístico + PostgreSQL | Sem modelo | Nunca delegar controles a IA |
| Classificar intenção, potencial e rota em alto volume | `gpt-6-luna` | Responses API, Structured Outputs, `reasoning.effort=none`, `store=false` | Só para casos que as regras não resolveram; confiança sem evidência continua limitada a `0.84` |
| Moderar texto recebido ou rascunho gerado | `omni-moderation-latest` | Endpoint de moderação | Sinaliza revisão; não encerra lead nem aplica punição sozinho |
| Redigir rascunho de resposta em português | `gpt-6.1-terra` | `low` inicialmente, saída estruturada | Rascunho sempre passa por política, revisão humana e aprovação; nunca envia diretamente |
| Segunda análise de caso ambíguo e comercialmente relevante | `gpt-6.1-sol` | `low` ou `medium` | Uso excepcional, acionado por regra mensurável ou por revisor; não substitui evidência |
| Auditoria periódica de prompt, funis e amostras difíceis | `gpt-6-astra` | Execução offline, lote amostral | Não usar por comentário em produção; usar para análise profunda e melhoria do sistema |

A documentação oficial descreve Luna como o modelo mais econômico para tarefas
focadas e de alto volume, Terra como rápido para escrita natural, Sol como
equilíbrio entre custo e inteligência e Astra como opção de maior capacidade.
Structured Outputs é a escolha correta para o contrato JSON do classificador.
Fontes: [seleção de modelos](https://developers.openai.com/api/docs/guides/model-selection),
[família GPT-6](https://developers.openai.com/api/docs/guides/latest-model),
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[preços](https://developers.openai.com/api/docs/pricing) e
[moderação](https://developers.openai.com/api/docs/guides/moderation).

## Controles obrigatórios

1. Manter um conjunto de avaliação versionado e anonimizado por vertical, com
   exemplos positivos, negativos, ambíguos, adversariais e variações de escrita.
2. Medir precisão de rota, falso positivo de lead comercial, cobertura, custo,
   latência p50/p95, taxa de fallback, recusa e erro de schema.
3. Só permitir auto-rota quando o limiar da organização e a evidência
   determinística forem satisfeitos. Score alto não torna contato elegível.
4. Fixar snapshot do modelo após homologação e reexecutar evals antes de trocar
   alias, prompt, schema ou limiar.
5. Não enviar payload bruto, token, e-mail, telefone ou dado desnecessário ao
   provider. Limitar e anonimizar contexto conforme a finalidade e a LGPD.
6. Aplicar orçamento mensal, rate limit, timeout, backoff e circuit breaker. Uma
   falha de provider deve gerar retry controlado, nunca uma rota inventada.

## Critérios para habilitar rascunhos

Rascunhos com Terra só entram no roadmap depois que houver guia de voz por
marca/vertical, política de temas proibidos, moderação, expiração da janela da
Meta, testes de idioma e aprovação explícita no painel. O dispatcher continua
bloqueado por `INSTAGRAM_DISPATCH_DRY_RUN=true` até um smoke test controlado.
