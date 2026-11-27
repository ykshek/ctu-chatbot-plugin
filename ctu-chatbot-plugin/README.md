# ctu-chatbot-plugin

DeepSeek Harness LLM provider for the CityUHK IT-portal chatbot.

Install the package directory through the running GUI's **Plugins → Add plugin**
(which both installs the package and selects the bundle), or with
`plugin_manager` `action: install_bundle` and this directory as `target`.

The portal authenticates with a browser session cookie. After installing, open
**Settings → Plugins → CityU chatbot**, paste the `Cookie` request header from a
signed-in portal request, and press **Save**. That page also lists every model's
remaining portal quota, and the composer dock shows the selected model's quota
as a pill.

For a headless install the same credential can come from the environment:

```bash
export CITYU_PORTAL_COOKIE='<Cookie header from a signed-in portal tab>'
```

See [`docs/DETAIL.md`](docs/DETAIL.md) for the protocol, model list, options,
quota and usage readings, failure mapping, and limitations.

After installing, pick the provider's models in **Settings → Models** (or set
`agent-default-model` to `cityu-portal` / `cityu-it-portal`).
