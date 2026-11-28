# The portal chatbot adapter

Adds the portal chatbot (`www.cityu.edu.hk/portal`)
to DeepSeek Harness as the text-only LLM provider `ctu-portal`.

**Configure it here.** This window belongs to the plugin's own page
(**Plugins → Installed plugins → The portal chatbot**). Below this document
the page holds the **Portal session** field, where the portal cookie is pasted,
the **GenAI disclaimer** switch, and the table of every model's remaining quota.

## What it actually is

The portal chatbot is **not** an OpenAI-compatible model endpoint. The GenAI
chat page speaks the portal's own `chatbot`-module protocol:

| | |
| --- | --- |
| Answer call | `POST {base}/getchatresponse` with `{ id, model, style, sessionOnly, qst }` |
| Session call | `POST {base}/getchathistory` with `{ id, model, style, sessionOnly, qst: "newSession" }` |
| Disclaimer | `POST {base}/agreeandproceed` (or `createnewuser` for a first-time account) |
| Request body | one plain-text question (`qst`), **not** a `messages` array |
| Response | `<conversation-id>,,,` followed by markdown, streamed as `text/plain` (gzip), no usage counters |
| Auth | the portal's browser session cookie, not an API key |
| State | the portal keeps the active conversation's transcript; the adapter still sends the harness history so tool-loop context is not lost |

The plugin used to point at the sibling `kbchatbot` module, which is the legacy
IT knowledge-base widget. That module ignores the GenAI model names and answers
out-of-scope questions with the IT Service Desk fallback (the Chinese
"很抱歉，我無法提供你問題的答案…" text). The GenAI page — and this adapter — use
`/portal/api/module/chatbot`.

The adapter flattens the harness history into the one `qst` string:

```
User: How do I reset my portal password?

Assistant: …

User: What if that fails?
```

The portal tracks **one active conversation per signed-in user**. The adapter
opens its conversation with `getchathistory` and `qst: "newSession"` once, on
the first turn, then asks every later turn against that same id — the same
lifecycle as the portal page. If the portal already holds a session from another
browser tab, the answer stream carries its "another active Chatbot session"
text; the plugin reports that as `INVALID_REQUEST` with a message telling you to
close the other tab, and does not fight the portal for the session.

The portal reports `status: "showdisclaimer"` on `getchathistory` for **every
new conversation**, even for an account that already accepted the disclaimer on
the website — it is the page's "show the modal" flag, not a stored consent
flag. The page then posts `agreeandproceed` for that conversation, which is what
actually enables it; the next history read may still report `showdisclaimer`.

The plugin mirrors that: with `acceptDisclaimer: true` it posts
`agreeandproceed` and continues; with the default `false` it reports
`INVALID_REQUEST` and asks you to accept the disclaimer at
`https://www.cityu.edu.hk/portal/category/5` (or to enable the switch). Turn on
**Accept the portal's GenAI disclaimer automatically** on the plugin's page,
under **Portal session**, to let the plugin post the acknowledgement. The switch
writes the `acceptDisclaimer` option below. Saving it restarts the provider so
the adapter reads the new value; a headless profile sets the option in
configuration instead. `newUser` is handled the same way with `createnewuser`,
after which the history is read once more.

## Models

The portal's model selector values are exposed as harness model ids:

| Harness model id | Portal `model` | Backend |
| --- | --- | --- |
| `ctu-gpt5-mini` | `GPTmini` | GPT-5 mini |
| `ctu-gpt5` | `GPT` | GPT-5.2 |
| `ctu-dsv4` | `DSV4` | DeepSeek V4 Flash |
| `ctu-qwen38` | `QWen38` | Qwen3.8-Flash-Next |

Any other model id is forwarded to the portal verbatim, so a newly added
backend can be tried without updating this bundle. All models declare
`text` as their only input modality.

## Configuration

The plugin reads its config from the bundle patch and/or the profile's
`cordis.patch.yml`:

| Option | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://www.cityu.edu.hk/portal/api/module/chatbot` | GenAI chatbot API root (chat and quota) |
| `quotaBaseURL` | *(same as `baseURL`)* | quota API root, when a portal puts it elsewhere |
| `cookieEnv` | `CTU_PORTAL_COOKIE` | credential reference and environment fallback for the session cookie |
| `cookie` | *(empty)* | literal cookie value; takes priority over the stored credential |
| `sessionId` | *(random UUID)* | fixed conversation id across restarts |
| `style` | `"1"` | portal thinking effort: `"0"` quick, `"1"` balanced, `"2"` deep (names `quick`/`balanced`/`deep` also work) |
| `sessionOnly` | `false` | portal's "show current session only" flag for the conversation |
| `acceptDisclaimer` | `false` | post the GenAI disclaimer acknowledgement automatically instead of asking the operator to accept it; the plugin page's switch writes this option |
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
4. Select the `api/module/chatbot/getchatresponse` request (or another finished
   request to `www.cityu.edu.hk`). If an entry says *Provisional headers are
   shown*, reload and pick another one.
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

**Bundle page (normal path).** Open **Plugins → Installed plugins → The
portal chatbot**, paste the value into the page's **Portal session** field, and
press **Save**. The plugin stores it as a credential record rather than in
configuration, verifies it against the portal, and reports whether it is
configured. A saved cookie reaches the next request without a restart, and the
value never appears in `cordis.patch.yml`.

**Environment (headless installs).** Export it in the environment that starts
`dsh web`. The same name doubles as the credential reference, so a stored value
takes priority and an unset environment fallback becomes effective again:

```bash
export CTU_PORTAL_COOKIE='<cookie>'
```

**Literal value in the profile patch.** Add this entry to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The loader applies the patch
without a restart, but the secret then lives in that file:

```yaml
- id: ctu-chatbot-plugin
  name: "ctu-chatbot-plugin"
  config:
    cookie: '<cookie>'
    cookieEnv: CTU_PORTAL_COOKIE
```

The cookie is a session credential. Treat it like a password and expect it to
expire; the plugin reports that case as an expired session instead of a generic
failure.

## Quota and usage readings

Quota is reported per model, not per account: each model on the portal
dashboard carries its own allowance. The plugin reads it from
`api/module/chatbot/getusage` by naming the model in the request body, which is
the same request the portal's own dashboard widget makes.

- **Plugins → Installed plugins → The portal chatbot** lists every model
  with its remaining quota and reset date, refreshed on demand.
- The **composer dock** gains a `Quota: <left> / <quota>` pill for the selected
  model, refreshed every 30 seconds. It is hidden unless the session's model
  selection belongs to this provider, so it never claims a quota for a model it
  does not serve.

The settings page verifies a pasted cookie by reading `getusage`. Chat and
quota share the `chatbot` module, so the same cookie and the same edge filter
cover both: a successful `getusage` is also proof that the chatbot is
reachable, and no conversation has to be opened to test a cookie.

The portal reports no prompt or completion token counts. To make the harness
readings work anyway, the adapter emits a `usage` chunk before its terminal
chunk with a **~4 characters per token estimate** of the flattened question and
the streamed answer. That estimate — not a billed count — is what the Usage
pill and the decode-speed figure show.

## Limitations

- **Text only.** Images and files are projected to placeholder text by the
  harness before they reach the adapter; the portal cannot read them.
- **No tool calling.** The portal does not execute tools. When the harness
  system prompt asks the model to use them, the portal may echo DSH's DSML
  tool-call syntax as text; the adapter maps that to one text block, so no tool
  is executed and the turn ends with `finish: stop`.
- **No reported usage.** The portal counts nothing, so the adapter emits an
  estimated `usage` chunk (see above) and the harness readings are estimates.
- **No reasoning channel.** The portal streams only visible markdown.
- **One conversation per account.** Using the portal chatbot in a browser tab
  and through this provider at the same time makes the two claim the same
  session; the second caller is told another session is active and has to wait
  or close it.
- **Answers are the selected model's content.** They may be stale or wrong;
  the portal itself carries a disclaimer to that effect. The portal may also
  refuse a question with its canned IT Service Desk fallback, which the adapter
  reports as `CONTENT_REFUSED` rather than passing off as an answer.

## Failure mapping

| Situation | Harness code |
| --- | --- |
| missing cookie | `MISSING_CREDENTIAL` |
| HTTP 401/403 | `INVALID_CREDENTIAL` |
| portal `status: "AccessDenied"` (HTTP 200 JSON) | `INVALID_CREDENTIAL` |
| HTTP 429 | `RATE_LIMIT` |
| HTTP 5xx | `SERVER` |
| session conflict / other 4xx | `INVALID_REQUEST` |
| another active conversation (`"It seems you have another active Chatbot session…"`) | `INVALID_REQUEST` |
| GenAI disclaimer not accepted (`showdisclaimer` / `newUser`) | `INVALID_REQUEST` |
| portal's canned IT Service Desk fallback | `CONTENT_REFUSED` |
| empty answer | `EMPTY_RESPONSE` |
| answer missing the `<id>,,,` frame | `MALFORMED_RESPONSE` |
| deadline exceeded | `TIMEOUT` |
| caller aborted | `ABORTED` |
| network / decode failure | `TRANSPORT` |

## Files

- `index.js` — Cordis plugin entry (`name`, `inject`, `apply`) and the
  `CtuQuotaService` that publishes the quota Remote methods.
- `client.js` — Web client half: the bundle page's configuration section and
  the composer dock quota pill.
- `lib/adapter.js` — the duck-typed adapter: question flattening, session
  handshake, stream translation, usage estimate, quota reads.
- `lib/protocol.js` — HTTP transport, the `chatbot`-module session/answer
  calls, `<id>,,,` frame parsing, refusal screening, attribution header,
  cookie normalization, HTTP failure classification.
- `lib/quota.js` — per-model quota normalization and the all-model read.
- `lib/estimate.js` — the ~4 characters per token estimator behind the usage
  chunk.
- `lib/models.js` — model catalog and wire mapping.
- `lib/config.js` — option normalization.
- `lib/errors.js` — `CtuPortalError` with harness-compatible `code`/`failure`.
