# ctu-chatbot-plugin

DeepSeek Harness LLM provider for the GenAI chatbot (the model selector
on `www.cityu.edu.hk/portal/category/5`).

## Install

Add the package `ctu-chatbot-plugin` through the running GUI's
**Plugins → Add plugin**; installing a plugin also selects its bundle. The same
install headless:

```bash
dsh plugin --profile web add ctu-chatbot-plugin
```

To run a local checkout instead of the published package, pass its package
directory (`ctu-chatbot-plugin/`) as the add target, or use `plugin_manager`
`action: install_bundle` with that directory as `target`.

The portal authenticates with a browser session cookie. After installing, open
**Plugins → Installed plugins → The portal chatbot**, paste the `Cookie`
request header from a signed-in portal request, and press **Save**. The same
page has a switch for **Accept the portal's GenAI disclaimer automatically**,
and lists every model's remaining portal quota; the composer dock shows the
selected model's quota as a pill.

For a headless install the same credential can come from the environment:

```bash
export CTU_PORTAL_COOKIE='<Cookie header from a signed-in portal tab>'
```

The plugin provides an agent runtime over the portal's text-only API:

- it advertises the harness's tools and DSML call syntax in the prompt, parses
  the model's DSML replies into real harness `tool-call` blocks, and feeds tool
  results back on the next turn;
- it forwards the harness system prompt and keeps the prompt under the portal's
  length limit by capping tool results and trimming the transcript;
- it keeps one portal conversation per DSH session and serializes them, and
  handles session titles and compaction locally so they do not pollute or
  overflow the agent's only conversation;
- it maps the portal's length, quota, rate-limit, refusal, and session errors
  to harness failure codes and exposes a bounded transient retry policy.

See [`docs/DETAIL.md`](docs/DETAIL.md) for the protocol, tool bridge, model
list, options, quota and usage readings, failure mapping, and limitations.

After installing, pick the provider's models in **Settings → Models** (or set
`agent-default-model` to `ctu-portal` / `ctu-dsv4`).
