# CityUHK portal chatbot adapter

Adds the City University of Hong Kong IT-portal chatbot (`www.cityu.edu.hk/portal`)
to DeepSeek Harness as the text-only LLM provider `cityu-portal`.

**Configure it here.** This window belongs to the plugin's own page
(**Plugins → Installed plugins → CityUHK portal chatbot**). Below this document
the page holds the **Portal session** field, where the portal cookie is pasted,
and the table of every model's remaining quota.

## What it actually is

The portal chatbot is **not** an OpenAI-compatible model endpoint. It is a
knowledge-base RAG assistant that speaks its own protocol:

| | |
| --- | --- |
| Answer call | `POST {base}/getchatresponse` with `{ id, model, qst }` |
| Session call | `POST {base}/startnewconversation` with `{ id, model }` |
| Request body | one plain-text question (`qst`), **not** a `messages` array |
| Response | raw markdown, streamed as `text/plain` (gzip), no usage counters |
| Auth | the portal's browser session cookie, not an API key |
| State | none on the server; a follow-up cannot see the previous turn |

Because the server keeps no conversation state, this adapter flattens the
harness history into the one `qst` string:

```
User: How do I reset my CityU portal password?

Assistant: …

User: What if that fails?
```

The portal tracks **one active conversation per signed-in user**. The adapter
claims its conversation with `startnewconversation` once, on the first turn,
then asks every later turn against that same id — the same lifecycle as the
portal's own widget, which only calls that endpoint from its "clear
conversation" button. If the portal already holds a session from another
browser tab, it refuses the claim; the plugin reports that as `INVALID_REQUEST`
with a message telling you to close the other tab, and does not fight the
portal for the session.

## Models

The portal's model selector values are exposed as harness model ids:

| Harness model id | Portal `model` | Backend |
| --- | --- | --- |
| `cityu-it-portal` | `IT-Portal` | portal default route |
| `cityu-gpt5-mini` | `GPTmini` | GPT-5 mini |
| `cityu-gpt5` | `GPT` | GPT-5.2 |
| `cityu-dsv4` | `DSV4` | DeepSeek V4 Flash |
| `cityu-qwen38` | `QWen38` | Qwen3.8-Flash-Next |

Any other model id is forwarded to the portal verbatim, so a newly added
backend can be tried without updating this bundle. All models declare
`text` as their only input modality.

## Configuration

The plugin reads its config from the bundle patch and/or the profile's
`cordis.patch.yml`:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://www.cityu.edu.hk/portal/api/module/kbchatbot` | portal chatbot API root |
| `quotaBaseURL` | `https://www.cityu.edu.hk/portal/api/module/chatbot` | quota API root (a different module from `baseURL`) |
| `cookieEnv` | `CITYU_PORTAL_COOKIE` | credential reference and environment fallback for the session cookie |
| `cookie` | *(empty)* | literal cookie value; takes priority over the stored credential |
| `sessionId` | *(random UUID)* | fixed conversation id across restarts |
| `contextWindow` | `32000` | declared context so harness compaction runs early |
| `requestTimeoutMs` | `120000` | full-request deadline |
| `maxQuestionChars` | `24000` | cap on the flattened transcript |
| `quotaCacheMs` | `30000` | how long one quota reading stays fresh |
| `includeSystemPrompt` | `false` | forward the harness system prompt into `qst` |

### Supplying the session cookie

The portal authenticates with the browser session it sets when you sign in, so
the plugin needs the **`Cookie` request header** that the browser sends with
portal requests.

#### Copy the cookie from a browser

1. Sign in at `https://www.cityu.edu.hk/portal/category/5`.
2. Open the browser's developer tools.
3. Choose the **Network** tab and reload the page so the portal requests appear.
4. Select a finished request to `www.cityu.edu.hk` — the page itself or one of
   its `api/module/...` calls. If an entry says *Provisional headers are shown*,
   reload and pick another one.
5. In the request's request headers, find **Cookie** and copy its whole value.
   Do not copy a `Set-Cookie` response header.

Where that panel lives:

- **Chrome, Edge, and other Chromium browsers:** `F12`, or `Ctrl+Shift+I`
  (`⌥⌘I` on macOS) → **Network** → **Headers** → **Request Headers** →
  **Cookie**.
- **Firefox:** `F12`, or `Ctrl+Shift+I` (`⌥⌘I` on macOS) → **Network** →
  **Headers** → **Request Headers** → **Cookie**.
- **Safari:** enable **Settings → Advanced → Show features for web
  developers**, then **Develop → Show Web Inspector** → **Network** →
  **Headers** → **Request** → **Cookie**.

Paste the whole header value rather than a single cookie: besides the portal's
own authentication cookie it carries the edge filter's `incap_ses_*` and
`reese84` cookies, and a request missing those is rejected before the portal
sees it. The value can be several kilobytes long; paste all of it.

#### Paste it on the plugin's page

**Bundle page (normal path).** Open **Plugins → Installed plugins → CityUHK
portal chatbot**, paste the value into the page's **Portal session** field, and
press **Save**. The plugin stores it as a credential record rather than in
configuration, verifies it against the portal, and reports whether it is
configured. A saved cookie reaches the next request without a restart, and the
value never appears in `cordis.patch.yml`.

**Environment (headless installs).** Export it in the environment that starts
`dsh web`. The same name doubles as the credential reference, so a stored value
takes priority and an unset environment fallback becomes effective again:

```bash
export CITYU_PORTAL_COOKIE='<cookie>'
```

**Literal value in the profile patch.** Add this entry to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The loader applies the patch
without a restart, but the secret then lives in that file:

```yaml
- id: ctu-chatbot-plugin
  name: "ctu-chatbot-plugin"
  config:
    cookie: '<cookie>'
    cookieEnv: CITYU_PORTAL_COOKIE
```

The cookie is a session credential. Treat it like a password and expect it to
expire; the plugin reports that case as an expired session instead of a generic
failure.

## Quota and usage readings

Quota is reported per model, not per account: each model on the portal
dashboard carries its own allowance. The plugin reads it from
`api/module/chatbot/getusage` by naming the model in the request body, which is
the same request the portal's own dashboard widget makes.

- **Plugins → Installed plugins → CityUHK portal chatbot** lists every model
  with its remaining quota and reset date, refreshed on demand.
- The **composer dock** gains a `Quota: <left> / <quota>` pill for the selected
  model, refreshed every 30 seconds. It is hidden unless the session's model
  selection belongs to this provider, so it never claims a quota for a model it
  does not serve.

The settings page verifies a pasted cookie by reading `getusage`. That module
sits behind a stricter edge filter than the `kbchatbot` module the chat uses, so
a cookie that works for chat can still be rejected there. When that happens the
page keeps the cookie and reports the quota problem as a warning, after a
read-only `getchathistory` probe on the chat module confirms the chatbot is
reachable.

The portal reports no prompt or completion token counts. To make the harness
readings work anyway, the adapter emits a `usage` chunk before its terminal
chunk with a **~4 characters per token estimate** of the flattened question and
the streamed answer. That estimate — not a billed count — is what the Usage
pill and the decode-speed figure show.

## Limitations

- **Text only.** Images and files are projected to placeholder text by the
  harness before they reach the adapter; the portal cannot read them.
- **No tool calling.** The portal never returns tool calls. Harness tool
  declarations are accepted but have no effect, so a turn always ends with a
  text answer (`finish: stop`).
- **No reported usage.** The portal counts nothing, so the adapter emits an
  estimated `usage` chunk (see above) and the harness readings are estimates.
- **No reasoning channel.** The portal streams only visible markdown.
- **One conversation per account.** Using the portal chatbot in a browser tab
  and through this provider at the same time makes the two claim the same
  session; whichever asked last wins.
- **Answers are knowledge-base content.** They describe CityUHK IT services and
  may be stale; the portal itself carries a disclaimer to that effect.

## Failure mapping

| Situation | Harness code |
| --- | --- |
| missing cookie | `MISSING_CREDENTIAL` |
| HTTP 401/403 | `INVALID_CREDENTIAL` |
| portal `status: "AccessDenied"` (HTTP 200 JSON) | `INVALID_CREDENTIAL` |
| HTTP 429 | `RATE_LIMIT` |
| HTTP 5xx | `SERVER` |
| session conflict / other 4xx | `INVALID_REQUEST` |
| portal refused a conversation (HTTP 200 JSON) | `INVALID_REQUEST` |
| empty answer | `EMPTY_RESPONSE` |
| deadline exceeded | `TIMEOUT` |
| caller aborted | `ABORTED` |
| network / decode failure | `TRANSPORT` |

## Files

- `index.js` — Cordis plugin entry (`name`, `inject`, `apply`) and the
  `CtuQuotaService` that publishes the quota Remote methods.
- `client.js` — Web client half: the bundle page's configuration section and
  the composer dock quota pill.
- `lib/adapter.js` — the duck-typed adapter: question flattening, session claim,
  stream translation, usage estimate, quota reads.
- `lib/protocol.js` — HTTP transport, attribution header, cookie normalization,
  HTTP failure classification.
- `lib/quota.js` — per-model quota normalization and the all-model read.
- `lib/estimate.js` — the ~4 characters per token estimator behind the usage
  chunk.
- `lib/models.js` — model catalog and wire mapping.
- `lib/config.js` — option normalization.
- `lib/errors.js` — `CityuPortalError` with harness-compatible `code`/`failure`.
