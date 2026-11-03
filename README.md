# @moguiyu/dsh-tavily

Advanced Tavily tools and key management for DeepSeek Harness, in one package with two
entries: the Host entry carries the **Plugins** page card and its two HTTP routes, and the
`@moguiyu/dsh-tavily/tools` entry carries the model tools. An agent preset mounts the tools
entry, so each preset decides whether its agents see `tavily_search`, `tavily_extract`,
`tavily_map`, and `tavily_crawl`.

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
- **Locales** — `locale/*.json` supplies the Plugins-list title and description in the
  eight shipped DSH languages; the card body itself remains English.
- **`web_search` is never replaced** — no `ctx.web` provider is registered and
  `web.searchProvider` is never rewritten; the built-in `web_search` keeps its native provider
  and schema.

## One package, two entries

| Entry | Where it runs | What it registers |
| --- | --- | --- |
| `@moguiyu/dsh-tavily` | Host Loader row in `cordis.patch.yml` | `/api/tavily-usage`, `/api/tavily-manager`, the Client card carrier, one startup warning when no key is configured |
| `@moguiyu/dsh-tavily/tools` | A row in an agent preset's `config.plugins` | `tavily_search`, `tavily_extract`, `tavily_map`, `tavily_crawl`, the `tool:tavily_search` and `tool:tavily_direct` prompt sections, and that installation's round-robin cursor |

The split exists because the two halves have opposite placement rules. Tools registered from
the Host row are visible to every preset, including `minimal` and the shipped templates. Routes
cannot move into a preset: `ctx.webServer.register` throws on a duplicate exact path, so the
second preset to mount the same row would be marked broken. The Client card cannot move either:
`dsh-client-modules` only scans Host Loader entries for a `dsh.client` declaration.

## Install

The Plugins card needs DSH **0.1.6-alpha.2 or newer**; on older 0.1.x lines the tools
and routes still load, without a card. The package code runs on Node.js 22 or newer;
paired with DSH **0.2.2**, use Node.js **24.9 or newer**, the runtime's own floor.

Install through **Plugins → Add plugin** in the Web UI, naming the absolute path of
the package tarball or of an unpacked checkout; the manager enables the new bundle
when the installation finishes. The CLI records the dependency in the profile but
does not select it, so enable the `@moguiyu/dsh-tavily` bundle on that page
afterwards:

```bash
dsh plugin --profile web add /absolute/path/to/moguiyu-dsh-tavily-0.8.0.tgz
```

`cordis.patch.yml` inserts the Host `dsh-tavily` row. It does not touch any preset.
From a checkout, `npm run build` regenerates `lib/client.js` from `src/client.js`;
release artifacts already contain the built bundle.

**From 0.7.0 the package alone gives no agent any Tavily tool.** The Host row only supplies
the card and the two routes; a preset must list the tools entry, as in the next section.

## Preset configuration

Add one row to each preset that should have the tools:

```yaml
- id: tavily-tools
  name: '@moguiyu/dsh-tavily/tools'
```

Place it next to `tool-web` (after `exa-tools` where that row exists) so the tool catalog
keeps a predictable order. In the `web` profile used for this release, three active presets
carry the row; `chat-assistant` is deprecated there and intentionally has none:

| Preset | Tavily tools | How the model sees them |
| --- | --- | --- |
| `standard-instant` | yes | native tools |
| `ptc-instant` | yes | `run_code` TypeScript SDK bindings |
| `cordis-ptc` | yes | `run_code` TypeScript SDK bindings |
| `chat-assistant` | no | deprecated preset; its description still mentions Tavily |
| `minimal` | no | — |
| shipped `standard` / `ptc` / `cordis` | no | — |

A subagent that omits a preset inherits its parent's composition, so it sees the parent's
choice. An explicitly chosen preset brings its own.

### DSH 0.2.2 executor migration

0.2.2 moves tool presentation out of `dsh-tools`: the `mode` and `maxParallelSubCalls`
keys are rejected, and the `tool-presentation` row is replaced by `tool-executor-native`
or `tool-executor-ptc`. The Tavily `tavily-tools` row needs no change; in a PTC preset
the four tools appear as `run_code` SDK bindings automatically. Migrate any other preset
row that still writes the removed keys before enabling this package, and re-add the
`tavily-tools` row if the upgrade rebuilds the profile.

## What the Plugins toggle controls

The Host row's toggle in the Plugins page controls the management surface only: the card, the
two `/api` routes, and the startup key check. It does not add or remove any preset's tools.
Stopping Tavily completely takes both steps:

1. remove or disable the `tavily-tools` row in the presets;
2. disable the Host `dsh-tavily` row, or deselect the bundle.

## Remote access

The two `/api/tavily-*` routes accept loopback requests only. A browser on another
machine gets `403` from the card. To manage keys from a remote browser on a trusted
network, launch dsh with `TAVILY_MANAGER_ALLOW_REMOTE=1`; that also exposes the
key-reveal endpoint, so treat it as an explicit trust decision. A reverse proxy that
forwards to the loopback address appears local to the Host; this guard is not an
authentication layer.

## Call routing

Set `TAVILY_API_KEYS` to a comma-separated list, or use `TAVILY_API_KEY` alone.
The list takes precedence when non-empty, matching the management card. The card
has two call orders: **priority**, where every call starts at the first active key,
and **round-robin**, where each call starts after the key attempted by the previous
call. Only active keys participate.

The cursor that makes round-robin work belongs to one tools installation, so each preset
revision counts on its own: two presets may pick the same key on their first call, and a
preset rebuild or a Harness restart resets its cursor. Credentials,
`~/.dsh/tavily-manager.json` (mode and per-key availability), and the usage cache are shared
by every preset: a change in the card applies to all of them from their next call.

A 401, 429, 432, or 433 response moves that call on to the next active key. Each
distinct key is tried at most once per call. 432 and 433 are Tavily's plan-limit and
paygo-limit responses, so the key is also turned off until a usage refresh sees
the matching account limit below 40%. Turning a key off by hand is separate: usage
recovery never re-enables it. When every key is off, the next tool call probes the
oldest quota-blocked key that is still enabled once, so a key that recovered after a
billing cycle does not need a manual refresh. The state file contains no API keys.

## Reload boundaries

- Host entry (`src/index.js`, `src/backend.js`): host plugin changes, verified after a reload.
- Preset tools entry (`src/tools-entry.js`, `src/tools.js`, `src/state.js`): restart the
  Harness; preset-scoped hot reload is not promised.
- Client half (`src/client.js`): run `npm run build` and refresh the page; `lib/client.js`
  is the shipped artifact.
- A working card and its routes say nothing about whether a preset loaded the tools. Check the
  preset's own composition.

## Upgrade from 0.6.0

0.7.0 is a behavior change: the root entry no longer registers the tools. Upgrade the package
and the preset rows in the same maintenance window, with the Harness stopped:

1. stop the Harness;
2. replace the installed package contents with 0.7.0;
3. add the `tavily-tools` row to every preset that needs the tools;
4. start the Harness and check the startup log for broken presets, duplicate routes, and module
   resolution errors.

Rollback restores both halves: stop the Harness, delete the `tavily-tools` rows, reinstall
0.6.0, start again. `~/.dsh/tavily-manager.json` keeps its schema and needs no data rollback.
Rolling back only one half leaves an incomplete state: 0.6.0 has no `/tools` export, so every
preset that still lists the row breaks; and 0.7.0 without the rows gives no preset the tools.

## Uninstall

Remove every `@moguiyu/dsh-tavily/tools` row first, then uninstall the package, then start the
Harness. A package uninstalled while a preset still lists the row leaves that preset broken.

## Development

```bash
npm run check      # node --check every file under src/
npm test           # node --test
npm run build      # regenerate lib/client.js from src/client.js
```

Host half: plain ESM (`src/index.js`, `src/tools-entry.js`, `src/tools.js`,
`src/backend.js`, `src/state.js`, `src/lib.js`). Client half: prebuilt
`window.__ModuleLoader__` bundle at `lib/client.js`, generated from `src/client.js` via
`npm run build`. Plugin metadata lives in `locale/*.json`; the Plugins list reads
those eight files without evaluating JavaScript.

Earlier releases split this across `@moguiyu/dsh-tool-tavily-search` and
`@moguiyu/dsh-tavily-backend`, which this package imported as regular dependencies. From 0.3.0
both are folded in here: one package means no dependency range can drift behind the contract.
Both old packages are deprecated.

## DSH 0.2 compatibility

Version **0.8.0** keeps the 0.6.0 peer ranges and adds an explicit **0.2.2** line:
`^0.2.2-0` covers every 0.2.2 prerelease and the final release, while the older
`^0.2.0-0` and 0.1.x ranges remain. DSH evaluates these peer ranges with prereleases
included, so no version exemption is required. The caret on 0.2.x also admits later
0.2.x releases before 0.3.0.

0.8.0 also adds the eight locale metadata files, limits the two management routes to
loopback requests unless `TAVILY_MANAGER_ALLOW_REMOTE=1`, and aligns the development
dependencies with 0.2.2-alpha.3.

The 0.3.2 host regression baseline against **0.2.0-rc.2** — the compatibility gate,
real tool execution, credential reads/writes, and unload/reload — remains the runtime
baseline. The 0.2.2-alpha.3 check recorded in
[the compatibility note](./docs/0.2.2-alpha.3-compatibility.md) is contract-level: the
package was not booted on a real 0.2.2-alpha.3 instance.

## Documentation

- [0.7.0 acceptance record](https://github.com/moguiyu/dsh-tavily/blob/main/docs/0.7.0-acceptance.md) (Chinese) — delivery shape, verification evidence, limitations, and rollback.
- [0.2.2-alpha.3 compatibility note](https://github.com/moguiyu/dsh-tavily/blob/main/docs/0.2.2-alpha.3-compatibility.md) (Chinese) — 0.7.1/0.8.0 contract check, verification results, and unverified items.
- [0.7.0 Host/preset split plan](https://github.com/moguiyu/dsh-tavily/blob/main/docs/preset-separation-upgrade-plan.md) (Chinese, historical) — the design record written before implementation.
