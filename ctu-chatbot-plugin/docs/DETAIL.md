# CityUHK portal chatbot adapter

Adds the City University of Hong Kong IT-portal chatbot (`www.cityu.edu.hk/portal`)
to DeepSeek Harness as the text-only LLM provider `cityu-portal`.

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

The portal tracks **one active conversation per signed-in user**. Every request
first calls `startnewconversation` with the adapter's own conversation id, which
claims the session. If the portal already holds a session from another browser
tab, the request fails with a message telling you to close that tab; the plugin
does not fight the portal for the session.

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

Sign in to `https://www.cityu.edu.hk/portal/category/5`, open DevTools →
Network, and copy the **`Cookie` request header** of any portal request.

**Settings page (normal path).** Open **Settings → Plugins → CityU chatbot**,
paste the value, and press **Save**. The plugin stores it as a credential
record rather than in configuration, verifies it against the portal, and
reports whether it is configured. A saved cookie reaches the next request
without a restart, and the value never appears in `cordis.patch.yml`.

Paste the whole header value: besides the portal's own authentication cookie it
carries the edge filter's `incap_ses_*` and `reese84` cookies, and a request
missing those is rejected before the portal sees it.

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

- **Settings → Plugins → CityU chatbot** lists every model with its remaining
  quota and reset date, refreshed on demand.
- The **composer dock** gains a `Quota: <left> / <quota>` pill for the selected
  model, refreshed every 30 seconds. It is hidden unless the session's model
  selection belongs to this provider, so it never claims a quota for a model it
  does not serve.

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
| HTTP 429 | `RATE_LIMIT` |
| HTTP 5xx | `SERVER` |
| session conflict / other 4xx | `INVALID_REQUEST` |
| empty answer | `EMPTY_RESPONSE` |
| deadline exceeded | `TIMEOUT` |
| caller aborted | `ABORTED` |
| network / decode failure | `TRANSPORT` |

## Files

- `index.js` — Cordis plugin entry (`name`, `inject`, `apply`) and the
  `CtuQuotaService` that publishes the quota Remote methods.
- `client.js` — Web client half: the Settings → Plugins page and the composer
  dock quota pill.
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
