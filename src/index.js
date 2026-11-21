/**
 * `@moguiyu/dsh-tavily` Host entry: the Plugins-page management card, its
 * Connection Fetch routes (/api/tavily-usage, /api/tavily-manager,
 * /api/tavily-manager/update), and one startup check for a missing Tavily key.
 *
 * This entry registers no model tools and no tool:tavily_search /
 * tool:tavily_direct prompt section. Those live in the separate
 * `@moguiyu/dsh-tavily/tools` entry that agent presets mount, so each preset
 * decides whether its agents receive the Tavily tools. Keeping the routes here
 * means several presets can mount the tools entry without registering a second
 * copy of any route — `ctx.connection.fetch.register` throws on a duplicate
 * exact path, which would mark the later preset broken.
 *
 * All management routes are registered on `ctx.connection.fetch`, so DSH's
 * Connection Host/Origin fence, authentication, and owner-only authorization
 * apply before any handler runs.
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

export const inject = ['connection', 'credentials']

export function apply(ctx) {
  // The owning fiber disposes all management routes when the row is disabled,
  // unloaded, or the bundle is removed.
  installBackend(ctx)
  // One check per Host mount, not one per preset that mounts the tools entry.
  warnIfNoKeys(ctx)
}
