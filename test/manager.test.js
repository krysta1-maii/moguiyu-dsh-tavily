/**
 * Tests for the manager routes: Connection auth boundaries, streaming 64 KiB
 * body cap, no-reveal invariant, priority order, call mode, per-key
 * availability, usage-driven quota recovery, and usage request cancellation.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as clientConnection from '@deepseek-ai/dsh-client-connection'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-manager-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const { MAX_MANAGER_BODY_BYTES, USAGE_TTL_MS, installBackend } = await import('../src/backend.js')
const hostPlugin = await import('../src/index.js')
const { maskValue } = await import('../src/lib.js')
const {
  STATE_INVALID_CODE,
  entryFor,
  keyId,
  readState,
  recordQuotaBlock,
  setEnabled,
  setMode,
  statePath,
} = await import('../src/state.js')

const KEYS = ['tvly-aaaaaaaaaaaaaaaaaaaa', 'tvly-bbbbbbbbbbbbbbbbbbbb', 'tvly-cccccccccccccccccccc']

beforeEach(() => {
  rmSync(statePath(), { force: true })
})

function fakeCredentials(values, writable = true) {
  const store = new Map([['TAVILY_API_KEYS', values.join(',')]])
  const records = new Map()
  const calls = { resolve: 0, set: 0, unset: 0 }
  return {
    store,
    calls,
    async resolve(ref) {
      calls.resolve++
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe() {
      return { configured: true, source: 'file', writable }
    },
    async set(ref, value) {
      calls.set++
      store.set(ref, value)
    },
    async unset(ref) {
      calls.unset++
      store.delete(ref)
    },
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  }
}

function install(values, options = {}) {
  const credentials = fakeCredentials(values, options.writable !== false)
  const routes = new Map()
  const disposers = []
  const listeners = new Map()
  const usageCache = options.usageCache instanceof Map ? options.usageCache : new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    get(service) {
      return service === 'credentials' ? credentials : undefined
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => { listeners.get(event)?.delete(listener) }
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) {
            throw new Error('connection: exact Fetch route ' + JSON.stringify(route.path) + ' is already registered')
          }
          routes.set(route.path, route)
          return async () => {
            await Promise.resolve()
            routes.delete(route.path)
          }
        },
      },
    },
  }
  installBackend(ctx, { usageCache, now: options.now })
  return {
    credentials,
    routes,
    usageCache,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    async dispose() {
      while (disposers.length > 0) await disposers.pop()()
    },
  }
}

async function callRoute(route, method, body, { path = route.path, headers = {}, signal } = {}) {
  const initHeaders = new Headers(headers)
  const init = { method, headers: initHeaders, signal }
  if (body !== undefined) {
    if (!initHeaders.has('content-type')) initHeaders.set('content-type', 'application/json')
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const request = new Request('http://dsh.internal' + path, init)
  const response = await route.fetch(request)
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text === '' ? null : JSON.parse(text),
  }
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
    return handler(key, init)
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Boot a real Cordis Context with the real `@deepseek-ai/dsh-client-connection`
 * plugin, a minimal node:http webServer carrier, and our Host plugin.
 */
async function startRealConnectionServer(keys = KEYS) {
  const credentials = fakeCredentials(keys)
  const ctx = new Context()
  ctx.provide('credentials')
  ctx.set('credentials', credentials)

  const exactRoutes = new Map()
  const prefixRoutes = []
  let serverPort = 0

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    const exact = exactRoutes.get(pathname)
    if (exact !== undefined) {
      await exact.handler(req, res)
      return
    }
    const prefix = prefixRoutes.find((r) => pathname === r.path || pathname.startsWith(r.path + '/'))
    if (prefix !== undefined) {
      await prefix.handler(req, res)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverPort = server.address().port

  ctx.provide('webServer')
  ctx.set('webServer', {
    host: '127.0.0.1',
    port: serverPort,
    protocol: 'http:',
    register(route) {
      if (route.kind === 'exact') {
        exactRoutes.set(route.path, route)
        return () => { exactRoutes.delete(route.path) }
      }
      prefixRoutes.push(route)
      return () => {
        const idx = prefixRoutes.indexOf(route)
        if (idx !== -1) prefixRoutes.splice(idx, 1)
      }
    },
  })

  try {
    await ctx.plugin(clientConnection)
    const hostFiber = ctx.plugin(hostPlugin)
    await hostFiber

    const baseUrl = `http://127.0.0.1:${serverPort}`
    const authUrl = ctx.connection.authenticatedUrl(baseUrl)
    const token = new URL(authUrl).searchParams.get('token')
    const connectRes = await fetch(`${baseUrl}/connect?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    })
    const setCookie = connectRes.headers.get('set-cookie')
    assert.ok(setCookie, 'real Connection /connect must mint a session cookie')
    const cookie = setCookie.split(';', 1)[0]

    return {
      ctx,
      hostFiber,
      credentials,
      baseUrl,
      cookie,
      async close() {
        try {
          await ctx.fiber.dispose()
        } finally {
          server.closeAllConnections()
          await new Promise((resolve) => server.close(resolve))
        }
      },
    }
  } catch (error) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    throw error
  }
}

test('real Connection rejects anonymous, cross-origin, and non-owner requests before handler runs', async () => {
  const env = await startRealConnectionServer(KEYS)
  try {
    const beforeResolve = env.credentials.calls.resolve
    const beforeSet = env.credentials.calls.set

    // 1. Anonymous GET & POST get 401
    for (const [method, path] of [
      ['GET', '/api/tavily-manager'],
      ['GET', '/api/tavily-usage'],
      ['POST', '/api/tavily-manager/update'],
    ]) {
      const res = await fetch(env.baseUrl + path, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({ mode: 'round_robin' }) : undefined,
      })
      assert.equal(res.status, 401, `${method} ${path} must reject anonymous caller with 401`)
    }

    // 2. Cross-origin request (even with cookie) gets 403
    const crossOrigin = await fetch(env.baseUrl + '/api/tavily-manager', {
      headers: { cookie: env.cookie, origin: 'https://evil.example' },
    })
    assert.equal(crossOrigin.status, 403)

    // 3. TAVILY_MANAGER_ALLOW_REMOTE=1 cannot bypass Connection authentication
    const previous = process.env.TAVILY_MANAGER_ALLOW_REMOTE
    process.env.TAVILY_MANAGER_ALLOW_REMOTE = '1'
    try {
      const res = await fetch(env.baseUrl + '/api/tavily-manager')
      assert.equal(res.status, 401)
    } finally {
      if (previous === undefined) delete process.env.TAVILY_MANAGER_ALLOW_REMOTE
      else process.env.TAVILY_MANAGER_ALLOW_REMOTE = previous
    }

    // 4. Non-owner Peer gets 403 on Connection shared handler
    const shared = env.ctx.connection.createSharedFetchHandler('/api')
    const guestPeer = env.ctx.connection.createPeer({ principal: { kind: 'guest' } })
    const nonOwnerGet = await shared.fetch(new Request('http://dsh.internal/api/tavily-manager'), guestPeer)
    assert.equal(nonOwnerGet.status, 403)
    const nonOwnerPost = await shared.fetch(new Request('http://dsh.internal/api/tavily-manager/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'round_robin' }),
    }), guestPeer)
    assert.equal(nonOwnerPost.status, 403)

    // None of the rejected requests touched credentials
    assert.equal(env.credentials.calls.resolve, beforeResolve)
    assert.equal(env.credentials.calls.set, beforeSet)

    // 5. Authenticated owner works over real HTTP for GET manager and streaming POST update
    const getRes = await fetch(env.baseUrl + '/api/tavily-manager', {
      headers: { cookie: env.cookie },
    })
    assert.equal(getRes.status, 200)
    assert.equal(getRes.headers.get('cache-control'), 'no-store')
    const getBody = await getRes.json()
    assert.equal(getBody.ok, true)
    assert.deepEqual(getBody.keys.map((k) => k.masked), KEYS.map(maskValue))

    const postRes = await fetch(env.baseUrl + '/api/tavily-manager/update', {
      method: 'POST',
      headers: { cookie: env.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'round_robin' }),
    })
    assert.equal(postRes.status, 200)
    const postBody = await postRes.json()
    assert.equal(postBody.ok, true)
    assert.equal(postBody.mode, 'round_robin')

    // 6. Unloading Host plugin removes all routes (404), and remounting restores them
    await env.hostFiber.dispose()
    const afterDispose = await fetch(env.baseUrl + '/api/tavily-manager', {
      headers: { cookie: env.cookie },
    })
    assert.equal(afterDispose.status, 404)
    const remounted = env.ctx.plugin(hostPlugin)
    await remounted
    const afterRemount = await fetch(env.baseUrl + '/api/tavily-manager', {
      headers: { cookie: env.cookie },
    })
    assert.equal(afterRemount.status, 200)
  } finally {
    await env.close()
  }
})

test('reveal query parameter is ignored and no response ever leaks a raw key', async () => {
  const { routes } = install(KEYS)
  const getRes = await callRoute(routes.get('/api/tavily-manager'), 'GET', undefined, {
    path: '/api/tavily-manager?reveal=' + encodeURIComponent(maskValue(KEYS[0])),
  })
  assert.equal(getRes.status, 200)
  assert.equal(getRes.body.value, undefined)
  assert.equal(Array.isArray(getRes.body.keys), true)
  for (const key of KEYS) {
    assert.equal(getRes.text.includes(key), false, 'manager GET response must not contain raw key')
  }

  const updateRes = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { mode: 'round_robin' })
  assert.equal(updateRes.status, 200)
  for (const key of KEYS) {
    assert.equal(updateRes.text.includes(key), false, 'manager POST response must not contain raw key')
  }

  await withUsageFetch(
    () => usageResponse({ planUsage: 10, planLimit: 1000 }),
    async () => {
      const usageRes = await callRoute(routes.get('/api/tavily-usage'), 'GET')
      assert.equal(usageRes.status, 200)
      for (const key of KEYS) {
        assert.equal(usageRes.text.includes(key), false, 'usage GET response must not contain raw key')
      }
    },
  )

  const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.equal(clientSource.includes('toggleReveal'), false)
  assert.equal(clientSource.includes('?reveal='), false)
  assert.equal(clientSource.includes('eyeOff'), false)
})

test('POST /api/tavily-manager/update accepts payloads up to 64 KiB and rejects larger fixed-length payloads with 413', async () => {
  const { routes, credentials } = install(KEYS)
  const route = routes.get('/api/tavily-manager/update')

  // Exactly 64 KiB valid JSON object (padded with whitespace) succeeds
  const base = JSON.stringify({ mode: 'round_robin' })
  const exactPayload = base + ' '.repeat(MAX_MANAGER_BODY_BYTES - Buffer.byteLength(base))
  assert.equal(Buffer.byteLength(exactPayload), MAX_MANAGER_BODY_BYTES)
  const okRes = await callRoute(route, 'POST', exactPayload, {
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_MANAGER_BODY_BYTES) },
  })
  assert.equal(okRes.status, 200)
  assert.equal(okRes.body.mode, 'round_robin')

  // 64 KiB + 1 byte with Content-Length returns 413 without touching credentials
  const beforeSet = credentials.calls.set
  const overPayload = base + ' '.repeat(MAX_MANAGER_BODY_BYTES - Buffer.byteLength(base) + 1)
  const overRes = await callRoute(route, 'POST', overPayload, {
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(overPayload)) },
  })
  assert.equal(overRes.status, 413)
  assert.equal(overRes.headers.get('cache-control'), 'no-store')
  assert.equal(credentials.calls.set, beforeSet)
})

test('POST /api/tavily-manager/update enforces 64 KiB cap on unknown-length streaming bodies and cancels reading', async () => {
  const { routes, credentials } = install(KEYS)
  const route = routes.get('/api/tavily-manager/update')

  let pulls = 0
  let cancelled = false
  const chunk = new Uint8Array(16 * 1024).fill(0x20) // 16 KiB spaces
  const stream = new ReadableStream({
    pull(controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode('{"add":["tvly-should-not-save-000000"]}'))
        return
      }
      // Would stream 160 KiB if not stopped at 64 KiB
      if (pulls <= 10) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
  })

  const request = new Request('http://dsh.internal/api/tavily-manager/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 413)
  assert.equal(cancelled, true, 'stream must be cancelled as soon as limit is exceeded')
  assert.ok(pulls < 10, `stream should stop early after crossing 64 KiB, got ${pulls} pulls`)
  assert.equal(credentials.calls.set, 0, 'oversized request must not write credentials')
})

test('protocol validation returns 415, 400, and 405 with Allow header without writing credentials', async () => {
  const { routes, credentials } = install(KEYS)
  const updateRoute = routes.get('/api/tavily-manager/update')
  const managerRoute = routes.get('/api/tavily-manager')
  const usageRoute = routes.get('/api/tavily-usage')

  // 415 wrong media type
  const wrongType = await callRoute(updateRoute, 'POST', JSON.stringify({ mode: 'round_robin' }), {
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.status, 415)

  // 400 malformed JSON
  const badJson = await callRoute(updateRoute, 'POST', '{bad json', {
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(badJson.status, 400)

  // 400 non-object JSON
  const arrayJson = await callRoute(updateRoute, 'POST', JSON.stringify(['not', 'an', 'object']), {
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(arrayJson.status, 400)

  // 405 wrong methods include Allow header
  const badUpdateMethod = await callRoute(updateRoute, 'GET')
  assert.equal(badUpdateMethod.status, 405)
  assert.equal(badUpdateMethod.headers.get('allow'), 'POST')

  const badManagerMethod = await callRoute(managerRoute, 'POST', { mode: 'round_robin' })
  assert.equal(badManagerMethod.status, 405)
  assert.equal(badManagerMethod.headers.get('allow'), 'GET')

  const badUsageMethod = await callRoute(usageRoute, 'POST', {})
  assert.equal(badUsageMethod.status, 405)
  assert.equal(badUsageMethod.headers.get('allow'), 'GET')

  assert.equal(credentials.calls.set, 0)
  assert.equal(credentials.calls.unset, 0)
})

test('usage route aborts upstream fetch and stops remaining keys when request.signal aborts', async () => {
  const keys = ['tvly-abort-aaaa-00000000', 'tvly-abort-bbbb-11111111']
  const { routes } = install(keys)
  const caller = new AbortController()
  const seenKeys = []
  let upstreamAborted = false

  await withUsageFetch(
    (key, init) => new Promise((_resolve, reject) => {
      seenKeys.push(key)
      init.signal.addEventListener('abort', () => {
        upstreamAborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
      caller.abort(new Error('client disconnected'))
    }),
    async () => {
      await callRoute(routes.get('/api/tavily-usage'), 'GET', undefined, { signal: caller.signal })
    },
  )

  assert.equal(upstreamAborted, true)
  assert.deepEqual(seenKeys, [keys[0]], 'second key must not be fetched after caller disconnect')
})

test('GET lists keys in stored priority order', async () => {
  const { routes } = install(KEYS)
  const res = await callRoute(routes.get('/api/tavily-manager'), 'GET')
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
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { order })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), order)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), [KEYS[2], KEYS[0], KEYS[1]].join(','))
  assert.equal(credentials.store.get('TAVILY_API_KEY'), KEYS[2])
})

test('POST order rejects a list that is not a permutation', async () => {
  const { routes, credentials } = install(KEYS)
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { order: [maskValue(KEYS[0])] })
  assert.equal(res.status, 409)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
})

test('removing a key keeps the chosen order of the rest', async () => {
  const { routes, credentials } = install(KEYS)
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', {
    order: [maskValue(KEYS[2]), maskValue(KEYS[0]), maskValue(KEYS[1])],
  })
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { remove: [maskValue(KEYS[0])] })
  assert.equal(res.status, 200)
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), [KEYS[2], KEYS[1]].join(','))
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), [maskValue(KEYS[2]), maskValue(KEYS[1])])
})

test('POST mode persists without rewriting the credential list', async () => {
  const { routes, credentials } = install(KEYS)
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { mode: 'round_robin' })
  assert.equal(res.status, 200)
  assert.equal(res.body.mode, 'round_robin')
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
  const reload = await callRoute(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(reload.body.mode, 'round_robin')
})

test('POST mode rejects an unknown value', async () => {
  const { routes } = install(KEYS)
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { mode: 'random' })
  assert.equal(res.status, 400)
})

test('POST setEnabled turns a key off and on', async () => {
  const { routes } = install(KEYS)
  const id = keyId(KEYS[0])
  let res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id, enabled: false }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].enabled, false)
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[0].primary, false)
  assert.equal(res.body.keys[1].primary, true)
  res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id, enabled: true }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].active, true)
})

test('POST setEnabled true clears a quota block', async () => {
  recordQuotaBlock(keyId(KEYS[0]), 'plan', '2026-01-01T00:00:00.000Z')
  const { routes } = install(KEYS)
  let res = await callRoute(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[0].quotaBlock.reason, 'plan')
  res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id: keyId(KEYS[0]), enabled: true }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.keys[0].active, true)
  assert.equal(res.body.keys[0].quotaBlock, null)
})

test('POST setEnabled rejects an unknown key id', async () => {
  const { routes } = install(KEYS)
  const res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', {
    setEnabled: [{ id: 'not-a-key', enabled: false }],
  })
  assert.equal(res.status, 409)
})

test('mode and toggles work when the key list is read-only', async () => {
  const { routes, credentials } = install(KEYS, { writable: false })
  const id = keyId(KEYS[0])
  let res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id, enabled: false }] })
  assert.equal(res.status, 200)
  assert.equal(entryFor(readState(), id).enabled, false)
  res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { mode: 'round_robin' })
  assert.equal(res.status, 200)
  assert.equal(readState().mode, 'round_robin')
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
  res = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { add: ['tvly-new-key-0000000000'] })
  assert.equal(res.status, 409)
})

test('key changes preserve mode and availability', async () => {
  const { routes } = install(KEYS)
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { mode: 'round_robin' })
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id: keyId(KEYS[0]), enabled: false }] })
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { remove: [maskValue(KEYS[2])] })
  const res = await callRoute(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.body.mode, 'round_robin')
  assert.equal(res.body.keys.length, 2)
  assert.equal(res.body.keys[0].enabled, false)
  assert.equal(res.body.keys[0].active, false)
  assert.equal(res.body.keys[1].active, true)
})

test('key changes merge state updates completed during credential writes', async () => {
  const { routes, credentials } = install(KEYS)
  const update = routes.get('/api/tavily-manager/update')
  const originalSet = credentials.set.bind(credentials)
  let markWriteStarted
  let releaseWrite
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve })
  const writeGate = new Promise((resolve) => { releaseWrite = resolve })
  let blocked = false
  credentials.set = async (ref, value) => {
    if (ref === 'TAVILY_API_KEYS' && !blocked) {
      blocked = true
      markWriteStarted()
      await writeGate
    }
    await originalSet(ref, value)
  }

  const adding = callRoute(update, 'POST', { add: ['tvly-concurrent-key-0000'] })
  await writeStarted
  try {
    const mode = await callRoute(update, 'POST', { mode: 'round_robin' })
    assert.equal(mode.status, 200)
    assert.equal(readState().mode, 'round_robin')
  } finally {
    releaseWrite()
  }
  const added = await adding
  assert.equal(added.status, 200)
  assert.equal(readState().mode, 'round_robin', 'late key write must not restore the preflight mode')
  assert.equal(credentials.store.get('TAVILY_API_KEYS').includes('tvly-concurrent-key-0000'), true)
})

test('removing and re-adding a key resets its availability', async () => {
  const { routes } = install(KEYS)
  const id = keyId(KEYS[2])
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { setEnabled: [{ id, enabled: false }] })
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { remove: [maskValue(KEYS[2])] })
  await callRoute(routes.get('/api/tavily-manager/update'), 'POST', { add: [KEYS[2]] })
  const res = await callRoute(routes.get('/api/tavily-manager'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
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
      const res = await callRoute(routes.get('/api/tavily-usage'), 'GET')
      const row = res.body.perKey.find((entry) => entry.id === id)
      assert.equal(row.ok, false)
      assert.equal(row.active, false)
    },
  )
  assert.notEqual(entryFor(readState(), id).quotaBlock, null)
})

test('usage cache keys by fingerprint only, reuses within TTL, and evicts expired and removed entries', async () => {
  const keys = ['tvly-cache-aaaa-00000000', 'tvly-cache-bbbb-11111111']
  let clock = 1_700_000_000_000
  const inst = install(keys, { now: () => clock })
  let fetches = 0

  await withUsageFetch(
    () => {
      fetches++
      return usageResponse({ planUsage: 42, planLimit: 1000 })
    },
    async () => {
      // First call populates cache
      const first = await callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(first.status, 200)
      assert.equal(fetches, 2)
      assert.deepEqual([...inst.usageCache.keys()].sort(), keys.map(keyId).sort())

      // Cache keys and values must never contain raw API keys
      for (const [k, v] of inst.usageCache) {
        for (const secret of keys) {
          assert.equal(k.includes(secret), false)
          assert.equal(JSON.stringify(v).includes(secret), false)
        }
      }

      // Second call within TTL hits cache without fetching
      clock += USAGE_TTL_MS - 1
      const second = await callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(second.status, 200)
      assert.equal(fetches, 2)

      // Advance past TTL and inject an orphan key id; expired + orphan entries are deleted before refetch
      inst.usageCache.set('deadbeef00000000', { at: clock, details: { fetchedAt: clock } })
      clock += 2
      // Make upstream return 500 so we can observe that expired entries were actually deleted, not merely skipped
      await withUsageFetch(
        () => new Response('', { status: 500 }),
        async () => {
          const expiredRes = await callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
          assert.equal(expiredRes.status, 200)
          assert.equal(inst.usageCache.size, 0, 'expired and orphan cache entries must be deleted')
        },
      )
    },
  )
})

test('usage cache is cleared by credential mutations, credentials/reference-updated events, and Host unload', async () => {
  const keys = ['tvly-evict-aaaa-00000000', 'tvly-evict-bbbb-11111111']
  let clock = 1_700_000_000_000
  const instA = install(keys, { now: () => clock })
  const instB = install(keys, { now: () => clock })

  await withUsageFetch(
    () => usageResponse({ planUsage: 10, planLimit: 1000 }),
    async () => {
      await callRoute(instA.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(instA.usageCache.size, 2)
      // Separate Host install owns an independent cache
      assert.equal(instB.usageCache.size, 0)

      // Removing/replacing a key clears cache
      await callRoute(instA.routes.get('/api/tavily-manager/update'), 'POST', {
        add: ['tvly-evict-cccc-22222222'],
        remove: [maskValue(keys[1])],
      })
      assert.equal(instA.usageCache.size, 0)

      // Repopulate cache, then verify credentials/reference-updated
      await callRoute(instA.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(instA.usageCache.size, 2)
      instA.emit('credentials/reference-updated', 'UNRELATED_REF')
      assert.equal(instA.usageCache.size, 2)
      instA.emit('credentials/reference-updated', 'TAVILY_API_KEYS')
      assert.equal(instA.usageCache.size, 0)

      // Repopulate and verify Host unload clears cache and removes event listener
      await callRoute(instA.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(instA.usageCache.size, 2)
      assert.equal(instA.listenerCount('credentials/reference-updated'), 1)
      await instA.dispose()
      assert.equal(instA.usageCache.size, 0)
      assert.equal(instA.listenerCount('credentials/reference-updated'), 0)
    },
  )
})

test('Host unload aborts in-flight usage and prevents late cache or state writes', async () => {
  const keys = ['tvly-unload-aaaa-00000000']
  const id = keyId(keys[0])
  recordQuotaBlock(id, 'plan', '2026-01-01T00:00:00.000Z')
  const inst = install(keys)
  let upstreamSignal
  let markStarted
  let resolveUpstream
  const started = new Promise((resolve) => { markStarted = resolve })
  const upstream = new Promise((resolve) => { resolveUpstream = resolve })

  await withUsageFetch(
    (_key, init) => {
      upstreamSignal = init.signal
      markStarted()
      return upstream
    },
    async () => {
      const pending = callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
      await started
      await inst.dispose()
      const abortedAtUnload = upstreamSignal.aborted
      resolveUpstream(usageResponse({ planUsage: 0, planLimit: 1000 }))
      const res = await pending
      assert.equal(res.status, 200)
      assert.equal(abortedAtUnload, true, 'Host unload must abort the upstream request')
      assert.equal(inst.routes.size, 0)
      assert.equal(inst.usageCache.size, 0, 'a late response must not refill the disposed cache')
      assert.notEqual(entryFor(readState(), id).quotaBlock, null, 'a late response must not clear quota state')
    },
  )
})

test('usage cache respects minFetchedAt so a pre-block cached sample forces a fresh fetch', async () => {
  const keys = ['tvly-minat-aaaa-00000000']
  const id = keyId(keys[0])
  let clock = 1_700_000_000_000
  const inst = install(keys, { now: () => clock })
  let fetches = 0

  await withUsageFetch(
    () => {
      fetches++
      return usageResponse({ planUsage: fetches === 1 ? 100 : 150, planLimit: 1000 })
    },
    async () => {
      await callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(fetches, 1)
      clock += 1000
      recordQuotaBlock(id, 'plan', new Date(clock).toISOString())
      clock += 1000
      const res = await callRoute(inst.routes.get('/api/tavily-usage'), 'GET')
      assert.equal(fetches, 2, 'cached sample older than quotaBlock must not be reused')
      assert.equal(res.body.perKey[0].active, true)
      assert.equal(res.body.perKey[0].planUsage, 150)
    },
  )
})

test('corrupt state file fails manager GET, usage GET, and manager POST before any credential or state write', async () => {
  const corrupt = '{corrupt-state-content-do-not-leak'
  writeFileSync(statePath(), corrupt, 'utf8')
  const { routes, credentials } = install(KEYS)

  const getRes = await callRoute(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(getRes.status, 500)
  assert.equal(getRes.body.code, STATE_INVALID_CODE)
  assert.equal(getRes.text.includes('corrupt-state-content-do-not-leak'), false)

  const usageRes = await callRoute(routes.get('/api/tavily-usage'), 'GET')
  assert.equal(usageRes.status, 500)
  assert.equal(usageRes.body.code, STATE_INVALID_CODE)

  const postRes = await callRoute(routes.get('/api/tavily-manager/update'), 'POST', {
    add: ['tvly-should-never-write-000000'],
    mode: 'round_robin',
  })
  assert.equal(postRes.status, 500)
  assert.equal(postRes.body.code, STATE_INVALID_CODE)
  assert.equal(credentials.calls.set, 0, 'state preflight failure must block credentials.set')
  assert.equal(credentials.calls.unset, 0, 'state preflight failure must block credentials.unset')
  assert.equal(credentials.store.get('TAVILY_API_KEYS'), KEYS.join(','))
  assert.equal(readFileSync(statePath(), 'utf8'), corrupt, 'corrupt state bytes must remain untouched')
})

test('corrupt legacy tavily-settings.json does not fail or reset current manager state', async () => {
  setMode('round_robin')
  const legacyPath = join(process.env.DSH_HOME, 'tavily-settings.json')
  writeFileSync(legacyPath, '{broken legacy file', 'utf8')
  try {
    const { routes } = install(KEYS)
    const res = await callRoute(routes.get('/api/tavily-manager'), 'GET')
    assert.equal(res.status, 200)
    assert.equal(res.body.mode, 'round_robin')
    assert.equal(readState().mode, 'round_robin')
  } finally {
    rmSync(legacyPath, { force: true })
  }
})
