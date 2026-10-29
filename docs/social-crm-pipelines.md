# Social CRM: modelo e funis (F22B)

## Modelo

`social_contacts` guarda uma pessoa por organização e conta Instagram. `external_user_id` é a identidade prioritária; se estiver ausente, usa `username` em minúsculas e sem espaços nas pontas. Um contato sem nenhuma dessas identidades não é inventado. Ao receber um ID estável, um contato criado só com username é atualizado. Se o mesmo username já estiver ligado a outro ID estável, o ID novo gera contato sem atribuir aquele username; a colisão requer revisão.

`social_engagements` guarda cada interação com tipo, origem e horário. Comentários de webhook e importação usam `webhook_event_id` e `external_engagement_id`. A chave de comentário existente (`meta:instagram:comments:<account>:<comment>`) converge antes da RPC do CRM; a restrição única `(organização, conta, tipo, ID externo)` evita uma segunda interação. `source` preserva `realtime` ou `historical_backfill`. Metadados são mínimos e não guardam texto da mensagem.

`social_leads` mantém no máximo um lead `active` ou `awaiting_signal` por contato; oportunidades encerradas podem permanecer como histórico. `social_lead_stage_history` é a trilha de criação, mudança central, direcionamento e mudança vertical. Todas as tabelas têm `organization_id`, FKs compostas de tenant, RLS ativada e acesso apenas por `service_role`. O painel atual não ganha acesso direto a essas tabelas.

## Ingestão

O webhook realtime e a importação histórica continuam entradas independentes. Depois de registrar `webhook_events` e `processing_jobs`, ambas chamam `ingest_social_comment_event`. Essa RPC extrai o autor do mesmo evento, chama `upsert_social_contact`, `record_social_engagement` e `get_or_create_social_lead`. Ela não chama `outbound_actions` ou dispatcher. Falha transitória no webhook retorna 500 para permitir reentrega; a RPC é idempotente. A importação reaproveita a mesma RPC mesmo quando encontra evento existente.

Importação histórica pode criar contato, engagement e lead. A origem histórica não muda para realtime em reentregas. Classificação e score ficam para uma chamada futura explícita de `route_social_lead`; nenhuma análise antiga é reinterpretada automaticamente nesta migration.

Depois da classificação do CRM, o worker pode solicitar um rascunho Gemini por um estágio separado. `save_instagram_response_draft` cria somente uma resposta pública `proposed`, inclusive para histórico; a origem fica gravada e `claim_outbound_action_for_dispatch` continua exigindo `approved`. O motor de CRM em si não envia nem aprova ações outbound.

## Funil central

`new_lead` → `first_contact` → `qualification` → `routing`. `transition_social_lead_stage` só aceita próximo passo, salvo override humano explícito com motivo. `first_contact_at`, `qualified_at` e `routed_at` são preenchidos nas transições. O primeiro engagement cria lead em `new_lead` e registra o evento inicial no histórico.

### Motor central (F22C)

| Etapa | Significado | Avanço |
|---|---|---|
| `new_lead` | Primeiro engagement criou o lead; ainda não há contexto suficiente | A segunda interação substantiva (`comment`, `dm`, `mention` ou `reply`) identifica contexto e avança para `first_contact`; uma curtida não avança |
| `first_contact` | Oportunidade de relacionamento identificada; nenhuma mensagem é presumida | Avaliação estruturada válida avança para `qualification` |
| `qualification` | Intent, potencial, score, sinais e motivo registrados | Confiança suficiente avança para `routing`; faixa intermediária pede mais sinal |
| `routing` | Rota registrada com motivo e confiança | Inicia `lead_received` no funil vertical ou `awaiting_signal` em `no_profile` |

As transições automáticas ficam em `social_central_transitions`; `process_social_engagement` é chamado por trigger após inserir um engagement. A entrada histórica e o coletor podem alimentar o CRM sem autorizar contato. Uma nova interação relevante `realtime` ou `manual` pode tirar `no_profile` de `awaiting_signal` e devolver o lead a `qualification`. O motor não chama um modelo nem decide por palavra-chave.

`contact_eligibility` é independente de `route_type`: `unknown`, `eligible`, `ineligible` ou `not_required`. Histórico e browser collector conservam `unknown` com motivo explícito. `set_social_contact_eligibility` exige administrador ativo, motivo e grava ator, hora e alteração no histórico. `first_contact` não equivale a permissão para DM.

`apply_social_assessment` valida `{intent, commercial_potential, lead_score, route_type, confidence, reason, recommended_next_action, signals}`. Intent e potencial usam valores controlados; score vai de 0 a 100, confiança de 0 a 1, e sinais são uma lista curta de strings. A política por organização em `social_funnel_policies` usa, por padrão, `0.850` para rota automática e `0.600` para pedir mais sinal. Abaixo de `0.600`, a política padrão encaminha a `no_profile`; é possível configurar a permanência em `qualification`. Em qualquer caso, a avaliação e o avanço são operações explícitas, sem envio outbound.

`manual_override_social_lead` permite ao administrador ativo editar etapa central, rota, score, qualificação e etapa vertical. Exige ID de ator, motivo e registra o conjunto alterado em `social_lead_stage_history`. O parâmetro legado de override sem ator é recusado. A mudança manual pode pular uma etapa, mas fica identificada no histórico.

Em `routing`, `route_social_lead` valida o contrato `{route_type, confidence, lead_score, reason, recommended_next_action}`. `confidence` fica entre 0 e 1, score entre 0 e 100 e textos não podem ser vazios. Ainda não há classificador IA conectado. A mudança de rota registra histórico, e cada vertical começa em `lead_received`.

| Rota | Etapas verticais em ordem |
|---|---|
| franchise | `lead_received`, `presentation`, `evaluation`, `proposal`, `negotiation`, `closing`, `implementation` |
| q3 | `lead_received`, `diagnosis`, `presentation`, `proposal`, `negotiation`, `onboarding`, `active_client` |
| hotmart | `lead_received`, `course_recommendation`, `offer`, `follow_up`, `purchase`, `active_student` |
| nuy | `lead_received`, `need_identification`, `product_recommendation`, `offer`, `purchase`, `post_sale` |

As transições verticais só avançam uma posição por chamada. Saltos exigem override humano com motivo e ficam no histórico. `no_profile` usa `status = awaiting_signal` e não possui etapa vertical. Nova interação mantém o contato; uma chamada explícita pode retornar o lead a `qualification` para recalcular score e direção.

## Motor vertical (F22E)

`social_vertical_stages` é o catálogo canônico de etapa, posição, label em português, recomendação e terminal. `social_vertical_transitions` guarda as arestas automáticas consecutivas. `no_profile` não aparece nessas tabelas. Cada rota aceita somente o próximo estágio; `transition_vertical_lead_stage` recebe o estágio esperado e uma chave de operação. A RPC bloqueia a linha do lead com `FOR UPDATE`, verifica a aresta no banco e grava uma única linha de histórico por chave. Uma chamada repetida devolve o mesmo lead sem novo avanço; uma chamada com estágio esperado antigo falha. A RPC legada `transition_social_lead_stage` usa as mesmas arestas.

| Rota | `recommended_next_action` por etapa, na ordem do funil |
|---|---|
| franchise | `review_profile`, `present_franchise`, `evaluate_candidate`, `prepare_proposal`, `follow_negotiation`, `confirm_closing`, `monitor_implementation` |
| q3 | `review_company`, `perform_diagnosis`, `present_q3`, `prepare_proposal`, `follow_negotiation`, `start_onboarding`, `customer_success` |
| hotmart | `understand_learning_need`, `recommend_course`, `present_offer`, `follow_up`, `confirm_purchase`, `student_success` |
| nuy | `understand_need`, `identify_need`, `recommend_products`, `present_offer`, `confirm_purchase`, `post_sale_follow_up` |

| Rota | Etapa terminal | Status terminal |
|---|---|---|
| franchise | `implementation` | `won` |
| q3 | `active_client` | `won` |
| hotmart | `active_student` | `won` |
| nuy | `post_sale` | `won` |

Ao entrar numa etapa, o lead recebe `vertical_stage_entered_at` e a ação sugerida daquela etapa. Ações como `review_profile`, `prepare_proposal` e `post_sale_follow_up` são apenas valores para planejamento; nenhuma RPC executa envio. A etapa terminal preenche `won_at` e `closed_at`, preservando o lead. `lost` e `cancelled` encerram a oportunidade sem alterar a etapa; `lost_at` registra a perda. A reabertura manual para `active` exige administrador ativo, motivo e chave de operação. Quando a rota era `no_profile`, a reabertura retorna à qualificação para permitir nova avaliação.

`manual_transition_vertical_lead_stage` permite ao administrador ativo avançar, retroceder ou saltar etapas com ator e motivo registrados. `set_social_lead_status` audita encerramento e reabertura. `assign_social_lead_owner` aceita um membro ativo da mesma organização ou `NULL` para deixar sem responsável; toda atribuição exige administrador, motivo e histórico. `owner_user_id` não cria usuário fictício.

O histórico existente inclui agora rota, status anterior e novo, ator, motivo, origem, chave de operação, metadados limitados e horário. Na reclassificação, o histórico da rota anterior permanece. A nova rota inicia em `lead_received` no mesmo lead; `no_profile` limpa somente a etapa atual. A classificação F22D continua sendo uma operação explícita e não executa outbound. Tabelas e RPCs mantêm acesso restrito ao `service_role` e filtram por `organization_id`.

O fluxo integrado F22F e seus limites transacionais estão em [social-selling-orchestrator.md](social-selling-orchestrator.md). Novos produtores de interação devem usar essa porta de domínio, com tratamento explícito de retry e sem executar a ação recomendada.

## Limites operacionais

O classificador F22D e sua passagem para este motor estão descritos em [social-selling-classifier.md](social-selling-classifier.md). A classificação é persistida por engagement, sem alterar elegibilidade de contato nem criar outbound.

As migrations F22B e F22C permanecem locais. Os testes `supabase/tests/social_crm_core.sql` e `supabase/tests/central_funnel_engine.sql` rodam com `ROLLBACK`. O dispatcher e as credenciais n8n permanecem fora deste checkpoint. Nenhuma função nova envia DM, comentário, reply, follow ou like. O painel visual completo fica para F22G; tipos de domínio podem ser usados por uma API autenticada futura.
