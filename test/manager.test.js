/**
 * Tests for the manager route's priority ordering: the list the card shows is
 * the list the tools try, and a POST that moves a key rewrites that list.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-manager-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const { installBackend } = await import('../src/backend.js')
const { maskValue } = await import('../src/lib.js')

const KEYS = ['tvly-aaaaaaaaaaaaaaaaaaaa', 'tvly-bbbbbbbbbbbbbbbbbbbb', 'tvly-cccccccccccccccccccc']

function fakeCredentials(values) {
  const store = new Map([['TAVILY_API_KEYS', values.join(',')]])
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe() {
      return { configured: true, source: 'file', writable: true }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

function install(values) {
  const credentials = fakeCredentials(values)
  const routes = new Map()
  const ctx = {
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

async function call(handler, method, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.url = '/api/tavily-manager'
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

test('GET lists keys in stored priority order', async () => {
  const { routes } = install(KEYS)
  const res = await call(routes.get('/api/tavily-manager'), 'GET')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.keys.map((entry) => entry.masked), KEYS.map(maskValue))
  assert.equal(res.body.keys[0].primary, true)
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
