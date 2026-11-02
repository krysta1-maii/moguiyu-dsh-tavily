/**
 * Tests for the two package entries.
 *
 * The Host entry (`src/index.js`, exported as `.`) owns the management card
 * carrier and the two exact routes; it must register no model tool and no
 * prompt section. The preset entry (`src/tools-entry.js`, exported as
 * `./tools`) owns the four tools and both prompt sections; it must register no
 * route, read no webServer, and keep its round-robin cursor to itself.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-entries-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const host = await import('../src/index.js')
const preset = await import('../src/tools-entry.js')
const state = await import('../src/state.js')

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const KEYS = ['tvly-entry-one-0000000000', 'tvly-entry-two-1111111111']

beforeEach(() => {
  rmSync(state.statePath(), { force: true })
})

function fakeCredentials(keys) {
  return {
    async resolve(ref) {
      if (ref === 'TAVILY_API_KEYS') return keys.length > 0 ? { value: keys.join(','), source: 'file' } : undefined
      if (ref === 'TAVILY_API_KEY') return keys.length > 0 ? { value: keys[0], source: 'file' } : undefined
      return undefined
    },
  }
}

/** A webServer that behaves like the Host one: a duplicate exact route throws. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    service: {
      register(route) {
        if (routes.has(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
}

/** A Host-shaped context: credentials, effect tracking, webServer, probes. */
function hostContext({ keys = KEYS, webServer = fakeWebServer() } = {}) {
  const disposers = []
  const warnings = []
  const toolNames = new Set()
  const sections = new Set()
  const ctx = {
    logger: { info() {}, warn: (...args) => { warnings.push(args) } },
    get(name) {
      if (name === 'credentials') return fakeCredentials(keys)
      if (name === 'tools') {
        return { register(definition) { toolNames.add(definition.name); return () => toolNames.delete(definition.name) } }
      }
      if (name === 'systemPrompt') {
        return { section(section) { sections.add(section.name); return () => sections.delete(section.name) } }
      }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
    webServer: webServer.service,
  }
  return { ctx, disposers, warnings, toolNames, sections, routes: webServer.routes }
}

function unload(disposers) {
  while (disposers.length > 0) disposers.pop()()
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the Host entry registers exactly the two management routes', () => {
  const { ctx, routes, toolNames, sections } = hostContext()
  host.apply(ctx)
  assert.deepEqual([...routes.keys()].sort(), ['/api/tavily-manager', '/api/tavily-usage'])
  assert.equal(toolNames.size, 0)
  assert.equal(sections.size, 0)
  assert.deepEqual(host.inject, ['webServer', 'credentials'])
})

test('unloading the Host entry removes both routes', () => {
  const { ctx, routes, disposers } = hostContext()
  host.apply(ctx)
  assert.equal(routes.size, 2)
  unload(disposers)
  assert.equal(routes.size, 0)
})

test('a second Host mount fails on the duplicate exact route', () => {
  const server = fakeWebServer()
  host.apply(hostContext({ webServer: server }).ctx)
  assert.throws(() => host.apply(hostContext({ webServer: server }).ctx), /duplicate exact route/)
})

test('a missing key warns once per Host mount', async () => {
  const { ctx, warnings } = hostContext({ keys: [] })
  host.apply(ctx)
  await tick()
  const missing = warnings.filter(([message]) => String(message).includes('is not configured'))
  assert.equal(missing.length, 1)
  assert.match(String(missing[0][0]), /TAVILY_API_KEYS or TAVILY_API_KEY/)
})

test('a configured key prints no warning', async () => {
  const { ctx, warnings } = hostContext()
  host.apply(ctx)
  await tick()
  assert.deepEqual(warnings, [])
})

/** A preset-shaped context: tools, prompt sections, credentials, no webServer. */
function presetContext({ keys = KEYS } = {}) {
  const tools = new Map()
  const sections = new Map()
  const disposers = []
  // `inject: ['tools']` exposes the registry as a context property; the other
  // two services are optional and read through ctx.get.
  const registry = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: registry,
    get(name) {
      if (name === 'webServer') throw new Error('the preset entry must not read webServer')
      if (name === 'credentials') return fakeCredentials(keys)
      if (name === 'tools') return registry
      if (name === 'systemPrompt') {
        return { section(section) { sections.set(section.name, section); return () => sections.delete(section.name) } }
      }
      return undefined
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, tools, sections, disposers }
}

test('the preset entry registers the four tools and both prompt sections', () => {
  const { ctx, tools, sections } = presetContext()
  preset.apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), ['tavily_crawl', 'tavily_extract', 'tavily_map', 'tavily_search'])
  assert.deepEqual([...sections.keys()].sort(), ['tool:tavily_direct', 'tool:tavily_search'])
  assert.deepEqual(preset.inject, ['tools', 'credentials', 'systemPrompt'])
})

test('unloading the preset entry removes every tool and section, and it can be remounted', () => {
  const { ctx, tools, sections, disposers } = presetContext()
  preset.apply(ctx)
  assert.equal(tools.size, 4)
  unload(disposers)
  assert.equal(tools.size, 0)
  assert.equal(sections.size, 0)
  preset.apply(ctx)
  assert.equal(tools.size, 4)
  assert.equal(sections.size, 2)
})

function okResponse() {
  return new Response(JSON.stringify({ results: [{ url: 'https://example.com', title: 'Example' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Replace `fetch` for one run and record the API key of every attempt. */
async function withFetch(handler, run) {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push(String(init.headers.authorization).slice('Bearer '.length))
    return handler(seen.length)
  }
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

test('two preset installations advance their own round-robin cursor', async () => {
  assert.equal(state.setMode('round_robin'), true)
  const first = presetContext()
  const second = presetContext()
  preset.apply(first.ctx)
  preset.apply(second.ctx)
  const toolA = first.tools.get('tavily_search')
  const toolB = second.tools.get('tavily_search')
  await withFetch(() => okResponse(), async (seen) => {
    await toolA.execute({ query: 'a1' }, {})
    await toolA.execute({ query: 'a2' }, {})
    await toolB.execute({ query: 'b1' }, {})
    // The second install starts at the first key, not where the first one left off.
    assert.deepEqual(seen, [KEYS[0], KEYS[1], KEYS[0]])
  })
})

test('two preset installations share priority order', async () => {
  const first = presetContext()
  const second = presetContext()
  preset.apply(first.ctx)
  preset.apply(second.ctx)
  await withFetch(() => okResponse(), async (seen) => {
    await first.tools.get('tavily_search').execute({ query: 'a' }, {})
    await second.tools.get('tavily_search').execute({ query: 'b' }, {})
    assert.deepEqual(seen, [KEYS[0], KEYS[0]])
  })
})

test('both entries are exported and point at existing files', () => {
  for (const key of ['.', './tools']) {
    const target = pkg.exports[key]
    assert.equal(typeof target, 'string')
    assert.equal(existsSync(new URL('../' + target.replace(/^\.\//, ''), import.meta.url)), true)
  }
  assert.equal(pkg.main, pkg.exports['.'])
  assert.equal(host.name, 'dsh-tavily')
  assert.equal(preset.name, 'dsh-tavily-tools')
})

test('the preset entry never loads the backend module', () => {
  const source = readFileSync(new URL('../src/tools-entry.js', import.meta.url), 'utf8')
  assert.equal(source.includes('backend'), false)
  assert.equal(source.includes('webServer'), false)
})

test('the bundle patch still inserts exactly one Host row', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal(patch.split("name: '@moguiyu/dsh-tavily'").length - 1, 1)
  assert.equal(patch.includes('/tools'), false)
})

test('the request user-agent version matches package.json', () => {
  const source = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8')
  const match = /dsh-tool-tavily-search\/([0-9][^']*)'/.exec(source)
  assert.notEqual(match, null)
  assert.equal(match[1], pkg.version)
})
