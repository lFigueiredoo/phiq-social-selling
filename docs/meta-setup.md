# Configuração Meta / Instagram

Este documento registra a decisão de integração com a Meta, os
pré-requisitos e o estado da configuração do app.

> **Status: PENDENTE DE EXECUÇÃO NO DASHBOARD DA META.**
> A parte de decisão técnica e planejamento está fechada. A criação do
> app em si precisa ser feita por uma pessoa com acesso ao Meta for
> Developers e ao Business Portfolio da PHIQ — não é algo que eu possa
> executar. Os campos marcados como `[A PREENCHER]` devem ser
> completados conforme a configuração real for concluída.

---

## 1. Decisão: Instagram API with Instagram Login

**Abordagem aprovada:** *Instagram API with Instagram Login* (também
apresentada pela Meta como *Business Login for Instagram* ou, no fluxo
de criação do app, como *API setup with Instagram login*).

**Não usaremos como caminho principal:** *Instagram API with Facebook
Login for Business*.

### Por quê

| Critério | Instagram Login (escolhido) | Facebook Login for Business |
|---|---|---|
| Facebook Page vinculada | **Não exigida** | Exigida |
| Contas suportadas | Business e Creator | Business e Creator vinculadas a uma Page |
| Host da API | `graph.instagram.com` | `graph.facebook.com` |
| Scopes | Scopes modernos específicos do Instagram | Permissões no formato `instagram_*` via Page |

A documentação da Meta confirma que <cite index="34-1">este setup de API não exige que uma Página do Facebook esteja vinculada à conta profissional do Instagram</cite>, e que ele permite <cite index="34-1">moderação de comentários (gerenciar e responder comentários nas mídias) e mensageria (enviar e receber mensagens com clientes ou pessoas interessadas na conta)</cite> — exatamente o escopo funcional do nosso MVP.

Também vale registrar a limitação declarada pela Meta: <cite index="34-1">este setup de API não consegue acessar anúncios nem tagging</cite>. Nenhuma dessas capacidades faz parte do nosso escopo, então a limitação não nos afeta.

**Consequência prática:** menos uma dependência (Facebook Page) e um
caminho de OAuth mais direto para contas profissionais.

---

## 2. Scopes

### Scopes que usaremos

| Scope | Uso no projeto | Fase |
|---|---|---|
| `instagram_business_basic` | Leitura de perfil e mídia | FASE 1 |
| `instagram_business_manage_comments` | Ler, responder, ocultar comentários | FASE 1 |
| `instagram_business_manage_messages` | Private replies e DMs | FASE 2 |

### Scope que NÃO solicitaremos

`instagram_business_content_publish` — o sistema não publica posts.
Solicitar uma permissão sem necessidade só aumenta a superfície do App
Review sem benefício.

### Atenção aos scopes legados

Os valores antigos `business_basic`, `business_content_publish`,
`business_manage_comments` e `business_manage_messages` são
**deprecated** e não devem ser usados. A Meta introduziu os novos
valores <cite index="34-1">para garantir consistência entre os valores de scope e os nomes das permissões, substituindo os valores existentes business_basic, business_content_publish, business_manage_comments e business_manage_messages</cite>, e <cite index="34-1">os valores antigos foram descontinuados em 27 de janeiro de 2025, o que impede o app de chamar os endpoints do Instagram caso o código não seja atualizado</cite>.

Ou seja: usar os nomes antigos hoje simplesmente quebra as chamadas.

---

## 3. Versão da API

**NÃO fixar por memória.** A versão a ser usada deve ser lida
diretamente do App Dashboard no momento da criação do app, já que a Meta
publica novas versões com regularidade e o dashboard indica qual é a
padrão/recomendada para um app novo.

- **Host da API:** `graph.instagram.com`
- **Versão identificada no dashboard:** `[A PREENCHER]`

Fontes públicas de terceiros mencionam versões estáveis recentes, mas
**isso não substitui a leitura do dashboard** — o valor autoritativo é o
que a Meta apresentar para este app específico. Quando confirmado, o
valor vai para a variável `META_API_VERSION` (nunca hardcoded no
código).

---

## 4. Meta App — dados de registro

Preencher conforme a criação for concluída. **Nenhum secret aqui.**

| Campo | Valor |
|---|---|
| Meta App Name | `PHIQ Social Selling DEV` (sugerido) |
| Meta App ID | `[A PREENCHER]` |
| Instagram App ID (se apresentado separadamente) | `[A PREENCHER]` |
| App mode | `Development` (esperado neste estágio) |
| API setup escolhido | API setup with Instagram login |
| Business Portfolio associado | `[A PREENCHER]` |

### Sobre App ID vs. Instagram App ID

Dependendo da interface atual, a Meta pode apresentar um único App ID ou
um App ID separado para o Instagram. **Se apenas um ID for aplicável ao
nosso fluxo, registre isso aqui e não mantenha variáveis duplicadas** no
`.env` — remover `META_INSTAGRAM_APP_ID` do `.env.example` nesse caso é
o comportamento correto.

Situação confirmada: `[A PREENCHER — um único ID / dois IDs distintos]`

---

## 5. Business Portfolio

Se a Meta solicitar associação a um Business Portfolio, usar o
**portfólio empresarial oficial que administra a conta Instagram da
PHIQ**.

- Não criar empresa fictícia.
- Não alterar ativos existentes sem necessidade.
- **Se houver mais de um portfólio e não for possível determinar com
  segurança qual é o correto: parar e escalar para decisão humana**,
  listando os nomes disponíveis.

Portfólio utilizado: `[A PREENCHER]`

---

## 6. Conta Instagram de desenvolvimento

Requisito: conta **Business** ou **Creator**. Conta pessoal não funciona
com esta API.

| Campo | Valor |
|---|---|
| Username | `[A PREENCHER]` |
| Tipo de conta | `[A PREENCHER — Business / Creator]` |
| Uso | `[A PREENCHER — conta de teste/dev ou conta oficial]` |

**Nunca registrar aqui:** senha, código 2FA, token.

### Preferência de conta

Idealmente uma conta profissional que possa receber comentários de teste
sem risco operacional. Se a única opção for a conta oficial da PHIQ:
**preparar apenas a vinculação**, sem publicar, responder comentários ou
enviar mensagens.

**Neste PASSO 03A nenhuma interação real deve ser enviada.**

---

## 7. Papéis e testers

Enquanto o app estiver em Development Mode, apenas contas com papel
atribuído no próprio app conseguem interagir com ele.

| Papel | Conta/Pessoa | Necessário? |
|---|---|---|
| Admin | `[A PREENCHER]` | `[A PREENCHER]` |
| Developer | `[A PREENCHER]` | `[A PREENCHER]` |
| Tester / Instagram Tester | `[A PREENCHER]` | `[A PREENCHER]` |

Regras: não adicionar usuários desconhecidos; não conceder acesso
administrativo desnecessário; documentar exatamente qual papel foi
efetivamente necessário (a interface da Meta varia).

---

## 8. Access Level

O dashboard distingue níveis de acesso (tipicamente apresentados como
*Standard Access* e *Advanced Access*, mas os nomes podem mudar).

**Neste estágio não solicitar App Review.** Trabalharemos com admins,
developers, testers e contas autorizadas no próprio app. O App Review só
será tratado depois que o fluxo técnico estiver funcionando de ponta a
ponta.

Nível observado no dashboard: `[A PREENCHER]`

---

## 9. Webhooks

**Neste passo, apenas confirmar que a seção de Webhooks existe no App
Dashboard.** Nada é configurado agora.

- Seção de Webhooks disponível no dashboard: `[A PREENCHER — SIM/NÃO]`
- Webhook configurado: **NÃO** (por decisão, não por pendência)

Não criar URL fictícia, não usar `webhook.site` como solução
permanente, e **não apontar a Meta diretamente para o n8n**. A
arquitetura aprovada continua sendo:

```
Meta → Supabase Edge Function → banco/fila → n8n
```

A URL real do webhook será criada no **PASSO 05**.

---

## 10. Secrets

O dashboard apresentará algum conjunto de: App ID, Instagram App ID,
App Secret, Instagram App Secret (os nomes variam conforme a interface).

**Regras:**
- IDs públicos podem ser registrados neste documento.
- **App Secret / Instagram App Secret são segredos.** Nunca em README,
  `docs/`, Git, migrations, mensagens ou screenshots versionados.
- O secret vai para o gerenciador de secrets / `.env` local (já
  ignorado pelo Git), nunca para o repositório.

App Secret configurado/guardado com segurança: `[A PREENCHER — SIM/NÃO]`

---

## 11. Pendências

### Para o PASSO 04 (OAuth / token)
- Configurar o redirect URI de OAuth.
- Executar o fluxo de autorização com a conta de teste.
- Trocar authorization code por access token.
- Gerar long-lived token e definir estratégia de renovação
  (`token_expires_at` já existe em `instagram_accounts`; o token em si
  fica em secrets, nunca no banco).

**Nada disso foi feito no PASSO 03A** — nenhum token foi gerado,
trocado ou armazenado.

### Para o PASSO 05 (webhook)
- Criar a Supabase Edge Function receptora.
- Definir a URL pública e o `META_VERIFY_TOKEN`.
- Registrar a subscription de webhook (`comments` primeiro).

### Para o futuro (App Review)
- `instagram_business_manage_comments` e
  `instagram_business_manage_messages` exigem Advanced Access via App
  Review, com gravação de tela demonstrando o caso de uso real,
  política de privacidade publicada e Business Verification.
- Recomendação: iniciar esse processo **em paralelo** ao
  desenvolvimento, já que costuma ser o item de maior prazo do
  cronograma — mas só depois que o fluxo técnico estiver funcionando em
  Development Mode.

---

## 12. O que NÃO foi feito neste passo

Registro explícito, para evitar ambiguidade futura:

- Nenhuma Edge Function criada.
- Nenhum OAuth callback configurado.
- Nenhum token gerado ou armazenado.
- Nenhum comentário respondido, nenhuma DM enviada.
- Nenhum webhook real configurado.
- Nenhuma conexão com n8n ou OpenAI.
- Nenhuma tabela criada, nenhuma alteração no Supabase.
- Nenhum App Review iniciado.
