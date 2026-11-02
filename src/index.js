/**
 * `@moguiyu/dsh-tavily` Host entry: the Plugins-page management card, its two
 * exact routes (/api/tavily-usage, /api/tavily-manager), and one startup check
 * for a missing Tavily key.
 *
 * This entry registers no model tools and no tool:tavily_search /
 * tool:tavily_direct prompt section. Those live in the separate
 * `@moguiyu/dsh-tavily/tools` entry that agent presets mount, so each preset
 * decides whether its agents receive the Tavily tools. Keeping the routes here
 * means several presets can mount the tools entry without registering a second
 * copy of either route — `ctx.webServer.register` throws on a duplicate exact
 * path, which would mark the later preset broken.
 *
 * The Host row also stays the only carrier of the Client half: dsh-client-modules
 * scans Host Loader entries for a `dsh.client` declaration, so moving this row
 * into a preset would drop the card from the Plugins page.
 *
 * The package never registers a web search provider and never changes
 * `ctx.web`, so the built-in `web_search` and `web_fetch` keep their native
 * providers and schemas.
 */
import { installBackend, warnIfNoKeys } from './backend.js'

export const name = 'dsh-tavily'

export const inject = ['webServer', 'credentials']

export function apply(ctx) {
  // The owning fiber disposes both management routes when the row is disabled,
  // unloaded, or the bundle is removed.
  installBackend(ctx)
  // One check per Host mount, not one per preset that mounts the tools entry.
  warnIfNoKeys(ctx)
}
