# ctu-chatbot-plugin

DeepSeek Harness LLM provider for the CityUHK IT-portal chatbot.

Install the package directory through the running GUI's **Plugins → Add plugin**
(which both installs the package and selects the bundle), or with
`plugin_manager` `action: install_bundle` and this directory as `target`.

The portal authenticates with a browser session cookie. Export it in the
environment that runs `dsh web`:

```bash
export CITYU_PORTAL_COOKIE='<Cookie header from a signed-in portal tab>'
```

Or override the installed row's `config` with `cookie: '<value>'` in the
profile's `cordis.patch.yml`. See
[`docs/DETAIL.md`](docs/DETAIL.md) for the protocol, model list, options,
failure mapping, and limitations.

After installing, pick the provider's models in **Settings → Models** (or set
`agent-default-model` to `cityu-portal` / `cityu-it-portal`).
