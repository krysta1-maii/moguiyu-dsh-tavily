/**
 * Tests for the manager routes: priority order, call mode, per-key
 * availability, and usage-driven quota recovery.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, beforeEach, test } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-manager-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const { installBackend } = await import('../src/backend.js')
const { maskValue } = await import('../src/lib.js')
const {
  entryFor,
  keyId,
  readState,
  recordQuotaBlock,
  setEnabled,
  statePath,
} = await import('../src/state.js')

const KEYS = ['tvly-aaaaaaaaaaaaaaaaaaaa', 'tvly-bbbbbbbbbbbbbbbbbbbb', 'tvly-cccccccccccccccccccc']

beforeEach(() => {
  rmSync(statePath(), { force: true })
})

function fakeCredentials(values, writable = true) {
  const store = new Map([['TAVILY_API_KEYS', values.join(',')]])
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe() {
      return { configured: true, source: 'file', writable }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

function install(values, options = {}) {
  const credentials = fakeCredentials(values, options.writable !== false)
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    get(service) {
      return service === 'credentials' ? credentials : undefined
    },
    effect(callback) {
      callback()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  installBackend(ctx)
  return { credentials, routes }
}

async function call(handler, method, body, path = '/api/tavily-manager') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.url = path
  const response = {
    statusCode: 0,
    payload: '',
    writeHead(status) {
      this.statusCode = status
      return this
    },
    end(chunk) {
      this.payload += chunk === undefined ? '' : chunk
    },
  }
  await handler(request, response)
  return { status: response.statusCode, body: response.payload === '' ? null : JSON.parse(response.payload) }
}

function usageResponse({ planUsage = 0, planLimit = 1000, paygoUsage = 0, paygoLimit = 100 } = {}) {
  return new Response(JSON.stringify({
    key: { usage: planUsage, limit: planLimit },
    account: {
      current_plan: 'Test',
      plan_usage: planUsage,
      plan_limit: planLimit,
      paygo_usage: paygoUsage,
      paygo_limit: paygoLimit,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function withUsageFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const key = String(init.headers.authorization).slice('Bearer '.length)
    return handler(key)
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

test('GET lists keys in stored priority order', async () => {
  const { routes } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), KEYS.map(maskValue))
  assert.equal(res.body.keys[0].primary, true)
  assert.equal(res.body.mode, 'priority')
  for (const entry of res.body.keys) {
    assert.equal(entry.enabled, true)
    assert.equal(entry.active, true)
    assert.equal(entry.quotaBlock, null)
    assert.equal(entry.id.length, 16)
  }
})

test('POST order rewrites the stored list and the derived primary', async () => {
  const { routes, credentials } = install(KEYS)
  const order = [maskValue(KEYS[2]), maskValue(KEYS[0]), maskValue(KEYS[1])]
  const res = await call(routes.get('/api/tavily-manager'), 'POST', { order })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), order)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), [KEYS[2], KEYS[0], KEYS[1]].join(','))
  assert.equal(credentials.store.get('TAVILY_API_KEY'), KEYS[2])
})

test('POST order rejects a list that is not a permutation', async () => {
  const { routes, credentials } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'POST', { order: [maskValue(KEYS[0])] })
  assert.equal(res.status, 409)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
})

test('removing a key keeps the chosen order of the rest', async () => {
  const { routes, credentials } = install(KEYS)
  await call(routes.get('/api/tavily-manager'), 'POST', {
    order: [maskValue(KEYS[2]), maskValue(KEYS[0]), maskValue(KEYS[1])],
  })
  const res = await call(routes.get('/api/tavily-manager'), 'POST', { remove: [maskValue(KEYS[0])] })
  assert.equal(res.status, 200)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), [KEYS[2], KEYS[1]].join(','))
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), [maskValue(KEYS[2]), maskValue(KEYS[1])])
})

test('POST mode persists without rewriting the credential list', async () => {
  const { routes, credentials } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'POST', { mode: 'round_robin' })
  assert.equal(res.status, 200)
  assert.equal(res.body.mode, 'round_robin')
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
  const reload = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(reload.body.mode, 'round_robin')
})

test('POST mode rejects an unknown value', async () => {
  const { routes } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'POST', { mode: 'random' })
  assert.equal(res.status, 400)
})

test('POST setEnabled turns a key off and on', async () => {
  const { routes } = install(KEYS)
  const id = keyId(KEYS[0])
  let res = await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id, enabled: false }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].enabled, false)
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[0].primary, false)
  assert.equal(res.body.keys[1].primary, true)
  res = await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id, enabled: true }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].active, true)
})

test('POST setEnabled true clears a quota block', async () => {
  recordQuotaBlock(keyId(KEYS[0]), 'plan', '2026-01-01T00:00:00.000Z')
  const { routes } = install(KEYS)
  let res = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[0].quotaBlock.reason, 'plan')
  res = await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id: keyId(KEYS[0]), enabled: true }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].active, true)
  assert.equal(res.body.keys[0].quotaBlock, null)
})

test('POST setEnabled rejects an unknown key id', async () => {
  const { routes } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'POST', {
    setEnabled: [{ id: 'not-a-key', enabled: false }],
  })
  assert.equal(res.status, 409)
})

test('mode and toggles work when the key list is read-only', async () => {
  const { routes, credentials } = install(KEYS, { writable: false })
  const id = keyId(KEYS[0])
  let res = await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id, enabled: false }] })
  assert.equal(res.status, 200)
  assert.equal(entryFor(readState(), id).enabled, false)
  res = await call(routes.get('/api/tavily-manager'), 'POST', { mode: 'round_robin' })
  assert.equal(res.status, 200)
  assert.equal(readState().mode, 'round_robin')
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
  res = await call(routes.get('/api/tavily-manager'), 'POST', { add: ['tvly-new-key-0000000000'] })
  assert.equal(res.status, 409)
})

test('key changes preserve mode and availability', async () => {
  const { routes } = install(KEYS)
  await call(routes.get('/api/tavily-manager'), 'POST', { mode: 'round_robin' })
  await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id: keyId(KEYS[0]), enabled: false }] })
  await call(routes.get('/api/tavily-manager'), 'POST', { remove: [maskValue(KEYS[2])] })
  const res = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.body.mode, 'round_robin')
  assert.equal(res.body.keys.length, 2)
  assert.equal(res.body.keys[0].enabled, false)
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[1].active, true)
})

test('removing and re-adding a key resets its availability', async () => {
  const { routes } = install(KEYS)
  const id = keyId(KEYS[2])
  await call(routes.get('/api/tavily-manager'), 'POST', { setEnabled: [{ id, enabled: false }] })
  await call(routes.get('/api/tavily-manager'), 'POST', { remove: [maskValue(KEYS[2])] })
  await call(routes.get('/api/tavily-manager'), 'POST', { add: [KEYS[2]] })
  const res = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.body.keys.find((entry) => entry.id === id).active, true)
})

test('usage refresh clears a plan block below 40%', async () => {
  const keys = ['tvly-usage-plan-aaaa-0000', 'tvly-usage-plan-bbbb-1111']
  const blocked = keyId(keys[0])
  recordQuotaBlock(blocked, 'plan', '2026-01-01T00:00:00.000Z')
  const { routes } = install(keys)
  await withUsageFetch(
    (key) => usageResponse({ planUsage: key === keys[0] ? 100 : 500, planLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      assert.equal(res.status, 200)
      const row = res.body.perKey.find((entry) => entry.id === blocked)
      assert.equal(row.ok, true)
      assert.equal(row.active, true)
      assert.equal(row.planUsage, 100)
    },
  )
  assert.equal(entryFor(readState(), blocked).quotaBlock, null)
})

test('usage refresh keeps a plan block at or above 40%', async () => {
  const keys = ['tvly-usage-keep-aaaa-0000', 'tvly-usage-keep-bbbb-1111']
  const blocked = keyId(keys[0])
  recordQuotaBlock(blocked, 'plan', '2026-01-01T00:00:00.000Z')
  const { routes } = install(keys)
  await withUsageFetch(
    (key) => usageResponse({ planUsage: key === keys[0] ? 500 : 100, planLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      const row = res.body.perKey.find((entry) => entry.id === blocked)
      assert.equal(row.active, false)
    },
  )
  assert.notEqual(entryFor(readState(), blocked).quotaBlock, null)
})

test('a paygo block uses paygo usage, not plan usage', async () => {
  const keys = ['tvly-usage-paygo-aaaa-0000', 'tvly-usage-paygo-bbbb-1111']
  const stillBlocked = keyId(keys[0])
  const recovered = keyId(keys[1])
  recordQuotaBlock(stillBlocked, 'paygo', '2026-01-01T00:00:00.000Z')
  recordQuotaBlock(recovered, 'paygo', '2026-01-01T00:00:00.000Z')
  const { routes } = install(keys)
  await withUsageFetch(
    (key) => key === keys[0]
      ? usageResponse({ planUsage: 100, planLimit: 1000, paygoUsage: 900, paygoLimit: 1000 })
      : usageResponse({ planUsage: 900, planLimit: 1000, paygoUsage: 100, paygoLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      assert.equal(res.body.perKey.find((entry) => entry.id === stillBlocked).active, false)
      assert.equal(res.body.perKey.find((entry) => entry.id === recovered).active, true)
    },
  )
})

test('usage recovery does not re-enable a manually disabled key', async () => {
  const keys = ['tvly-usage-manual-aaaa-0000', 'tvly-usage-manual-bbbb-1111']
  const id = keyId(keys[0])
  recordQuotaBlock(id, 'plan', '2026-01-01T00:00:00.000Z')
  setEnabled(id, false)
  const { routes } = install(keys)
  await withUsageFetch(
    () => usageResponse({ planUsage: 0, planLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      const row = res.body.perKey.find((entry) => entry.id === id)
      assert.equal(row.enabled, false)
      assert.equal(row.active, false)
      assert.equal(row.quotaBlock, null)
    },
  )
  assert.equal(entryFor(readState(), id).enabled, false)
})

test('a usage sample older than the block does not clear it', async () => {
  const keys = ['tvly-usage-old-aaaa-0000', 'tvly-usage-old-bbbb-1111']
  const id = keyId(keys[0])
  recordQuotaBlock(id, 'plan', '2999-01-01T00:00:00.000Z')
  const { routes } = install(keys)
  await withUsageFetch(
    (key) => usageResponse({ planUsage: key === keys[0] ? 0 : 100, planLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      assert.equal(res.body.perKey.find((entry) => entry.id === id).active, false)
    },
  )
  assert.notEqual(entryFor(readState(), id).quotaBlock, null)
})

test('a usage request that returns 432 leaves the block in place', async () => {
  const keys = ['tvly-usage-432-aaaa-0000', 'tvly-usage-432-bbbb-1111']
  const id = keyId(keys[0])
  recordQuotaBlock(id, 'plan', '2026-01-01T00:00:00.000Z')
  const { routes } = install(keys)
  await withUsageFetch(
    (key) => key === keys[0] ? new Response('', { status: 432 }) : usageResponse({ planUsage: 100, planLimit: 1000 }),
    async () => {
      const res = await call(routes.get('/api/tavily-usage'), 'GET', undefined, '/api/tavily-usage')
      const row = res.body.perKey.find((entry) => entry.id === id)
      assert.equal(row.ok, false)
      assert.equal(row.active, false)
    },
  )
  assert.notEqual(entryFor(readState(), id).quotaBlock, null)
});
