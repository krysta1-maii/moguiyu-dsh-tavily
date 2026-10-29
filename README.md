# @moguiyu/dsh-tavily

Everything in one package: the advanced Tavily model tools (`tavily_search`, `tavily_extract`,
`tavily_map`, `tavily_crawl`), the key/usage HTTP routes, and the browser card on the **Plugins**
page.

The bundle and plugin entries use the bundled Tavily color icon from
[Lobe Icons](https://github.com/lobehub/lobe-icons). See
[third-party notices](./THIRD_PARTY_NOTICES.md) for attribution and licensing.

- **`tavily_search`** — full Tavily surface (`max_results`, `search_depth`, `topic`, `days`,
  `include_answer`, `include_raw_content`, `include_domains`, `exclude_domains`).
- **`tavily_extract` / `tavily_map` / `tavily_crawl`** — read a known URL's content, map a
  site's links, or crawl a site and return its pages. Same key-rotation/failover as search.
- **Card** — key list, usage gauge, and the strategy selector. It registers into the Plugins
  page's `plugins.bundle.config` slot, keyed `@moguiyu/dsh-tavily`, and needs DSH
  **0.1.6-alpha.2 or newer** — the release that retired `settings.plugin.item` and moved plugin
  configuration off the Settings page. On older lines the tools and routes work; there is simply
  no card.
- **`web_search` is never replaced** — no `ctx.web` provider is registered and
  `web.searchProvider` is never rewritten; the built-in `web_search` keeps its native provider
  and schema.

Host half: plain ESM (`src/index.js`, `src/tools.js`, `src/backend.js`, `src/lib.js`). Client
half: prebuilt `window.__ModuleLoader__` bundle at `lib/client.js`, generated from
`src/client.js` via `pnpm build`.

Earlier releases split this across `@moguiyu/dsh-tool-tavily-search` and
`@moguiyu/dsh-tavily-backend`, which this package imported as regular dependencies. From 0.3.0
both are folded in here: one package means no dependency range can drift behind the contract,
which is exactly how the old tool-level switch broke. Both old packages are deprecated.

There is no tool-level on/off switch. Composing the plugin registers the tools, and the Plugins
page's own bundle toggle is the only on/off.

## DSH 0.2 compatibility

Version **0.4.0** accepts the same DSH peers as 0.3.2 (`^0.2.0-0` and the
earlier 0.1.x ranges). The 0.3.2 host regression baseline against **0.2.0-rc.2**
— the compatibility gate, real tool execution, credential reads/writes and
unload/reload — is unchanged by this release, which touches only the in-tool
retry classification and rotation cursor. No version exemption is required.

Set `TAVILY_API_KEYS` to a comma-separated list, or use `TAVILY_API_KEY` alone.
The list takes precedence when non-empty, matching the management card. HTTP
401/429/432/433 tries each distinct configured key at most once per call before
reporting failure. 432 and 433 are Tavily's plan-limit and paygo-limit responses,
so a key that has spent its allowance is skipped for the next key instead of
failing the call.

See the [workspace README](../../README.md) for install and configuration.
