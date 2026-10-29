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
  site's links, or crawl a site and return its pages. Same call order and failover as search.
- **Card** — key list in stored order, usage gauge, up/down controls, a priority/round-robin
  switch, and per-key availability tags. Only active keys are used; a 432/433 response turns
  a key off until a usage refresh sees that limit below 40%. It registers into the Plugins
  page's `plugins.bundle.config` slot, keyed `@moguiyu/dsh-tavily`, and needs DSH
  **0.1.6-alpha.2 or newer** — the release that retired `settings.plugin.item` and moved plugin
  configuration off the Settings page. On older lines the tools and routes work; there is simply
  no card.
- **`web_search` is never replaced** — no `ctx.web` provider is registered and
  `web.searchProvider` is never rewritten; the built-in `web_search` keeps its native provider
  and schema.

Host half: plain ESM (`src/index.js`, `src/tools.js`, `src/backend.js`, `src/state.js`,
`src/lib.js`). Client half: prebuilt `window.__ModuleLoader__` bundle at `lib/client.js`,
generated from `src/client.js` via `pnpm build`.

Earlier releases split this across `@moguiyu/dsh-tool-tavily-search` and
`@moguiyu/dsh-tavily-backend`, which this package imported as regular dependencies. From 0.3.0
both are folded in here: one package means no dependency range can drift behind the contract,
which is exactly how the old tool-level switch broke. Both old packages are deprecated.

There is no tool-level on/off switch. Composing the plugin registers the tools, and the Plugins
page's own bundle toggle is the only on/off.

## DSH 0.2 compatibility

Version **0.6.0** accepts the same DSH peers as 0.3.2 (`^0.2.0-0` and the
earlier 0.1.x ranges). The 0.3.2 host regression baseline against **0.2.0-rc.2**
— the compatibility gate, real tool execution, credential reads/writes and
unload/reload — remains the baseline for this line. No version exemption is
required.

Set `TAVILY_API_KEYS` to a comma-separated list, or use `TAVILY_API_KEY` alone.
The list takes precedence when non-empty, matching the management card. The card
has two call orders: **priority**, where every call starts at the first active key,
and **round-robin**, where each call starts after the key attempted by the previous
call. Only active keys participate.

A 401, 429, 432, or 433 response moves that call on to the next active key. Each
distinct key is tried at most once per call. 432 and 433 are Tavily's plan-limit and
paygo-limit responses, so the key is also turned off until a usage refresh sees
the matching account limit below 40%. Turning a key off by hand is separate: usage
recovery never re-enables it. When every key is off, the next tool call probes the
oldest quota-blocked key that is still enabled once, so a key that recovered after a
billing cycle does not need a manual refresh. The manager records the mode and per-key availability in
`~/.dsh/tavily-manager.json`; that file contains no API keys.

See the [workspace README](../../README.md) for install and configuration.
