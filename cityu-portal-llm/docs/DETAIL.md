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
| `cookieEnv` | `CITYU_PORTAL_COOKIE` | environment variable holding the session cookie |
| `cookie` | *(empty)* | literal cookie value; takes priority over `cookieEnv` |
| `sessionId` | *(random UUID)* | fixed conversation id across restarts |
| `contextWindow` | `32000` | declared context so harness compaction runs early |
| `requestTimeoutMs` | `120000` | full-request deadline |
| `maxQuestionChars` | `24000` | cap on the flattened transcript |
| `includeSystemPrompt` | `false` | forward the harness system prompt into `qst` |

### Supplying the session cookie

1. Sign in to `https://www.cityu.edu.hk/portal/category/5` in a browser.
2. Open DevTools → Network, ask the chatbot one question, and copy that
   `getchatresponse` request's `Cookie` request header.
3. Give the value to the harness in one of two ways:

   **Environment (recommended).** Export it in the environment that starts
   `dsh web`, then restart the server:

   ```bash
   export CITYU_PORTAL_COOKIE='<cookie>'
   ```

   **Literal value in the profile patch.** After the bundle is installed, add
   this entry to `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (id-targeted
   overrides replace the bundle row's whole `config`, so `resolveOptions`
   defaults the omitted fields):

   ```yaml
   - id: cityu-portal-llm
     name: "@local/cityu-portal-llm"
     config:
       cookie: '<cookie>'
       cookieEnv: CITYU_PORTAL_COOKIE
   ```

   The loader applies the patch without a restart, but the secret then lives
   in that file.

The cookie is a session credential. Treat it like a password, expect it to
expire, and remove it from config files you share.

## Limitations

- **Text only.** Images and files are projected to placeholder text by the
  harness before they reach the adapter; the portal cannot read them.
- **No tool calling.** The portal never returns tool calls. Harness tool
  declarations are accepted but have no effect, so a turn always ends with a
  text answer (`finish: stop`).
- **No usage accounting.** The portal reports no token counts, so the adapter
  emits no `usage` chunk and the harness meter falls back to its own estimate.
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

- `index.js` — Cordis plugin entry (`name`, `inject`, `apply`).
- `lib/adapter.js` — the duck-typed adapter: question flattening, session claim,
  stream translation.
- `lib/protocol.js` — HTTP transport, attribution header, cookie normalization,
  HTTP failure classification.
- `lib/models.js` — model catalog and wire mapping.
- `lib/config.js` — option normalization.
- `lib/errors.js` — `CityuPortalError` with harness-compatible `code`/`failure`.
