# Instagram Liker Collector (POC)

POC isolado e somente leitura para verificar se uma conta coletora separada
consegue listar usuários que curtiram uma publicação pública. A conta PHIQ não
é autenticada e este collector não usa Supabase nem Meta Graph.

## Limites e segurança

- Autentica somente `IG_COLLECTOR_USERNAME` e `IG_COLLECTOR_PASSWORD`.
- Não envia Direct, não segue, não curte, não comenta e não faz alterações.
- Salva apenas `session.json` local depois de um login bem-sucedido. O arquivo
  está no `.gitignore` e nunca deve ser compartilhado.
- Nunca imprime senha, cookies, `sessionid`, headers de autorização ou tokens.
- O limite padrão e máximo é 20.
- Challenge ou checkpoint encerram o processo com segurança; não há contorno.

## Windows PowerShell

No diretório `collectors/instagram-likers`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

$env:IG_COLLECTOR_USERNAME="conta_coletora"
$env:IG_COLLECTOR_PASSWORD="SUA_SENHA"
$env:IG_TARGET_MEDIA_URL="https://www.instagram.com/p/XXXXXXXX/"
$env:IG_LIKERS_LIMIT="20"

python collector.py
```

Não armazene credenciais em arquivos.

## Sessão local

No primeiro login, o Instagram pode exigir confirmação manual. Depois de um
login bem-sucedido, `session.json` será salvo localmente e reutilizado na
próxima execução pelo mesmo `Client` do instagrapi.

Se houver `challenge_required` ou `checkpoint_required`, o collector encerra
sem retry, sem trocar device/profile e sem tentar contornar a proteção. Conclua
a verificação no Instagram oficial e execute o collector novamente depois.

## Saídas

Em caso de sucesso, o script cria `output/likers.json` e `output/likers.csv`.
Os registros são deduplicados por `user_id` e contêm somente os campos do POC.

## Métodos e erros

O método preferido é `media_likers`. Se a versão instalada não o expuser, o
script usa `media_likers_v1` somente se esse método também for exposto pela
biblioteca; nenhum endpoint interno é construído manualmente.

O resumo final expõe somente códigos sanitizados: `login_required`,
`challenge_required`, `checkpoint_required`, `rate_limit`, `media_not_found`,
`likers_unavailable` e `unknown_error`.

## Browser alternative (Playwright)

`browser_collector.py` is a second POC, independent from `instagrapi`. It uses
only the visible Instagram UI in a persistent Chromium profile at
`browser-profile/` (ignored by Git). It does not accept a username, password,
`sessionid`, cookies, or tokens through variables or files. Never copy cookies
or storage state into this project.

Install the dependencies once:

```powershell
python -m pip install -r requirements.txt
```

### Browser on Windows (two options)

**A) Preferred — use the Google Chrome already installed on the system.** No
Chromium download is required. The collector resolves the executable in this
order:

1. `IG_BROWSER_EXECUTABLE` (optional, points to a `chrome.exe`)
2. the standard install paths
   `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%` and `%LOCALAPPDATA%` +
   `\Google\Chrome\Application\chrome.exe`
3. the Playwright `chrome` channel

```powershell
# Only if Chrome is installed somewhere non-standard:
$env:IG_BROWSER_EXECUTABLE="C:\Caminho\Para\chrome.exe"
```

**B) Optional — download Playwright's Chromium.** Used only as the last
fallback, when no system Chrome is found:

```powershell
python -m playwright install chromium
```

System Chrome is only used as a *binary*. The collector always passes
`browser-profile/` as `user_data_dir`, so it never opens the personal Chrome
profile and never copies or imports its cookies, storage, or session.

### Manual login

First, open the browser and authenticate the collector account manually:

```powershell
python browser_collector.py --bootstrap
```

Bootstrap starts by printing only which browser it will use and whether the
executable was found — never a full path, cookie, token, storage value,
`sessionid`, or password. It then prints
`Faça login manualmente na conta coletora no navegador.` and waits for terminal
confirmation. It never fills in credentials. It only verifies that the login
page is no longer visible, then closes the browser while preserving the local
profile.

For one post, set only its URL and the limit:

```powershell
$env:IG_TARGET_MEDIA_URL="https://www.instagram.com/p/XXXXXXXX/"
$env:IG_LIKERS_LIMIT="20"

python browser_collector.py
```

The default and absolute limit is 20. The browser collector opens only the
provided post and its likes dialog, collects visible data, gradually scrolls the
dialog a limited number of times, and writes `output/likers.json` and
`output/likers.csv`. It neither opens profiles nor uses multiple tabs, and never
performs an Instagram action (Direct, follow, like, comment, reply, publish, or
delete).

If the UI indicates login, challenge/checkpoint, suspicious login, rate limit,
or action blocked, the process stops immediately with a sanitized code. Complete
challenge/checkpoint verification in the official Instagram app/site before
trying again; this script neither bypasses it nor automatically repeats login.

### Likers diagnostics (read-only)

When collection fails with `likers_dialog_not_found`, this mode records evidence
about the real post UI instead of guessing a new selector:

```powershell
$env:IG_TARGET_MEDIA_URL="https://www.instagram.com/p/XXXXXXXX/"

python browser_collector.py --diagnose-likers
```

It opens the post, waits for the DOM to settle, checks challenge/login, and then
only *reads* the page. It clicks nothing — no like, comment, follow, Direct, or
candidate element — and it does not touch the likers selectors.

It writes diagnostics under `output/diagnostics/` (ignored by Git):

- `post.png` and `post-full.png`: screenshots of that single page only.
- `candidates.json`: up to 100 elements matching
  `a[href], button, [role="button"], [role="link"]`, ranked with likely likers
  controls first (`/liked_by/` href, then engagement wording, then elements
  inside `article`/`main`, then visible ones). Each entry keeps only `tag`,
  `role`, `aria_label`, `title`, `text`, `href`, `data_testid`, `visible`,
  `bounding_box`, `in_article`, `in_main`, `dom_index`, `engagement_hint`.
- `page_summary.json`: `current_url`, `title`, `article_count`, `dialog_count`,
  `button_count`, `link_count`, `login_form_detected`, `blocked_state`,
  `media_shortcode`, plus `candidate_total`/`candidate_saved` so a truncated
  list is never silent. It also reports the number of saved like-text nodes by
  diagnostic scope (`post`, `comment`, or `unknown`) and action-bar candidates.
- `like_text_nodes.json`: up to 200 visible `span`, `div`, `section`, `a`, or
  `button` nodes whose rendered text mentions likes. Each record has bounded
  parent/grandparent descriptors, a first clickable ancestor within five levels,
  geometry, and a diagnostic-only post/comment/unknown heuristic. It never
  clicks that ancestor.
- `action_bar_candidates.json`: visible Like/Unlike/Comment/Share/Save (and
  Portuguese equivalents) labels with geometry and parent text, used only to
  relate the post action bar to the global count.
- `engagement_text.txt`: at most 100 relevant visible body-text lines, capped at
  150 characters each; it is not a full body-text capture.

Text and `aria_label` are capped at 150 characters, hrefs keep only the visible
path (query strings and fragments are dropped, and `javascript:`/`data:` URLs
are discarded), and the fields are copied through an allow-list. Page HTML,
cookies, headers, storage, tokens, and `sessionid` are never written.

`Resultado: PASS` here means the diagnosis was recorded — **not** that likers
were collected.

### Browser error codes

- `browser_unavailable`: no usable browser (executable not found, browser not
  installed, launch failure, a missing Playwright browser, or a lost driver
  connection). No session conclusion was reached. Install Chrome, set
  `IG_BROWSER_EXECUTABLE`, or run `python -m playwright install chromium`.
- `browser_login_required`: the browser opened and Instagram loaded, but there
  is no authenticated session. Run `--bootstrap` and log in manually.

`Sessão do navegador: não disponível` is reserved for those two cases plus
challenge/checkpoint. A later UI failure such as `likers_dialog_not_found` keeps
`Sessão do navegador: pronta`, because the session was already verified.
