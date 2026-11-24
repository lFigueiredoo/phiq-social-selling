# Meta / Instagram — estado e runbook

## Estado confirmado em 23/11/2026

- App publicado: `PHIQ Social Selling DEV` (`2133910727524622`).
- Instagram App ID exibido no fluxo atual: `2288236405324530`.
- Conta profissional conectada: `@phiq.oficial`.
- Integração ativa: **Instagram API with Instagram Login**.
- Host ativo: `graph.instagram.com`.
- Permissões ativas: `instagram_business_basic`,
  `instagram_business_manage_comments` e
  `instagram_business_manage_messages`.
- O token foi renovado, validado contra `/me?fields=id,username` e salvo no
  secret store do Supabase. O valor do token não pertence ao Git, banco,
  documentação ou painel.
- O painel leu publicações e contagens reais após a renovação.
- O webhook está ativado no app atual.
- Em 24/11/2026, `META_VERIFY_TOKEN` foi rotacionado e deixou de compartilhar
  valor com qualquer outro consumidor. O callback aceitou o challenge novo com
  HTTP `200` e rejeitou um token inválido com HTTP `403`. A autenticação dos
  eventos `POST` por `META_APP_SECRET` não foi alterada.
- O piloto usa `INSTAGRAM_DISPATCH_DRY_RUN=false` junto de
  `INSTAGRAM_DISPATCH_PUBLIC_REPLY_ONLY=true`: somente resposta pública aprovada
  pode ser enviada. O primeiro envio controlado foi reconciliado com a Meta em
  24/11/2026; Direct continua bloqueado.

A interface da Meta classifica o fluxo atual como antigo, mas o fluxo segue
funcionando e a Meta não publicou uma data de desligamento. Por isso, a
migração para Unified Login deve ser paralela e reversível, não uma troca
direta.

Fontes oficiais:

- [Guia de migração para Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide/)
- [Changelog da plataforma Instagram](https://developers.facebook.com/docs/instagram/platform/instagram-api/changelog/)
- [System users e geração de tokens](https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/)
- [Depuração de access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/debugging/)

## Arquitetura de coexistência

```text
Instagram Login (ativo)       Unified Login (candidato)
graph.instagram.com           graph.facebook.com
META_ACCESS_TOKEN             META_UNIFIED_ACCESS_TOKEN
META_APP_SECRET               META_UNIFIED_APP_SECRET
META_VERIFY_TOKEN             META_UNIFIED_VERIFY_TOKEN
          \                    /
           meta-instagram-webhook
                    |
       instagram_account_identifiers
                    |
           conta canônica / CRM
```

`META_AUTH_MODE` aceita somente:

- `instagram_login` — padrão e modo de produção atual;
- `unified_login` — exige token próprio e um alias primário
  `api_user_id`; se faltar qualquer um deles, as funções falham fechado.

O webhook aceita, durante o canário, assinaturas e verify tokens dos dois
apps. O `entry.id` é resolvido por um alias `webhook_entry_id`. Eventos
assinados sem mapeamento não desaparecem: ficam em `webhook_events` com
status `dead_letter` e erro `instagram_account_mapping_missing`, sem job e sem
envio.

## Por que os IDs não podem ser presumidos

A Meta pode apresentar IDs diferentes para:

- usuário retornado pelo token;
- usuário usado nas chamadas Graph;
- `entry.id` recebido no webhook;
- ID exibido na interface do App Dashboard.

O banco mantém esses namespaces em `instagram_account_identifiers`, ligados à
mesma linha de `instagram_accounts`. Nunca copie um ID para outro campo por
semelhança visual. Cada valor deve ser observado no endpoint ou webhook que o
define.

## Permissões mínimas do Unified Login

Solicitar somente:

- `instagram_basic`;
- `instagram_manage_comments`;
- `instagram_manage_messages`.

Remover `ads_management`, `ads_read` e `instagram_content_publish` quando a
interface os incluir por padrão. O produto não gerencia anúncios nem publica
posts.

## Migração segura para Unified Login

1. Criar uma configuração Unified Login no mesmo Business Portfolio oficial.
2. Gerar um System User Access Token separado. Não substituir
   `META_ACCESS_TOKEN`.
3. Consultar `/me/assigned_instagram_accounts` e registrar o `user_id` correto
   como alias `unified_login/api_user_id`.
4. Configurar o callback no objeto Instagram do app Meta.
5. Assinar a conta via `/{ig-user-id}/subscribed_apps` e registrar o ID que
   realmente chegar em `entry.id` como
   `unified_login/webhook_entry_id`.
6. Validar leitura de perfil, mídia e comentários com
   `graph.facebook.com`, ainda com o modo ativo legado.
7. Produzir um comentário de teste autorizado e confirmar exatamente um
   evento, um job e uma entrada no CRM.
8. Mudar `META_AUTH_MODE=unified_login` apenas para o canário de leitura.
9. Manter `INSTAGRAM_DISPATCH_DRY_RUN=true` durante toda a migração.
10. Desativar token/subscription legados somente depois de estabilidade e
    rollback testado.

O envio real é uma decisão independente. A migração de autenticação não
autoriza responder comentários nem iniciar Direct.

## Rollback

1. Restaurar `META_AUTH_MODE=instagram_login`.
2. Manter os aliases Unified para auditoria, marcando-os como `inactive` apenas
   se estiverem incorretos.
3. Confirmar leitura de mídia pelo painel.
4. Confirmar recepção de um webhook legado.
5. Não alterar `INSTAGRAM_DISPATCH_DRY_RUN` durante o rollback.

## Rotação e monitoramento

- Tokens e app secrets ficam somente no secret store do Supabase/Meta.
- `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN` e `N8N_WORKER_SECRET` devem manter
  valores e ciclos de rotação independentes.
- Preferir token de system user com expiração e rotação planejada; registrar
  apenas o metadado de expiração.
- Alertar para `401/403` da Meta, crescimento de `dead_letter`, ausência de
  webhooks e divergência de username.
- Um aumento de `instagram_account_mapping_missing` bloqueia o canário até que
  o namespace correto seja identificado.
- Nunca registrar tokens completos em logs, screenshots ou tickets.

## Regra operacional de saída

- Rascunhos podem ser gerados pelo Gemini conectado ao n8n.
- Aprovação humana continua obrigatória.
- Comentários históricos permitem somente resposta pública.
- Private Reply/DM exige política elegível e janela válida.
- `INSTAGRAM_DISPATCH_DRY_RUN=false` só pode ser aplicado para um teste real
  controlado, com aprovação explícita e plano imediato de retorno ao modo
  seguro.
