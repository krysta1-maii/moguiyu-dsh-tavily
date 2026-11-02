/**
 * `@moguiyu/dsh-tavily/tools` preset entry: the four Tavily model tools and the
 * tool:tavily_search / tool:tavily_direct prompt sections.
 *
 * Agent presets mount this entry by name, so a preset that does not list it
 * gives its agents no Tavily tools at all; the Host row alone provides only the
 * management card and the two /api routes. Each mounting composition keeps its
 * own tool registrations and its own round-robin cursor, while credentials,
 * ~/.dsh/tavily-manager.json, and the usage cache stay shared with the Host
 * entry through the credential service and the state file.
 *
 * This entry registers no HTTP route and no Client resource, so several presets
 * may mount it at the same time.
 */
import { installTavilyTool } from './tools.js'

export const name = 'dsh-tavily-tools'

export const inject = ['tools', 'credentials', 'systemPrompt']

export function apply(ctx) {
  // The owning composition disposes every tool and prompt section this entry
  // registered when the preset row unloads or is rebuilt.
  ctx.effect(() => installTavilyTool(ctx), 'dsh-tavily: tools')
}
