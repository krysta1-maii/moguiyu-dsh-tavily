/**
 * Tests for cancellation identity and timeout separation across normal calls,
 * failover loops, quota-blocked probes, listener/timer cleanup, and the real
 * DSH 0.2.2-rc.5 native tool execution pipeline.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import SystemPromptService from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-cancel-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const { TAVILY_TIMEOUT_CODE, combineSignals, installTavilyTool } = await import('../src/tools.js')
const { keyId, recordQuotaBlock, statePath } = await import('../src/state.js')

const KEYS = ['tvly-cancel-one-000000', 'tvly-cancel-two-111111']

beforeEach(() => {
  rmSync(statePath(), { force: true })
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

function install(keys, options = {}) {
  const definitions = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get(service) {
      return service === 'credentials' ? fakeCredentials(keys) : undefined
    },
  }
  const dispose = installTavilyTool(ctx, options)
  return { dispose, tool: definitions.get('tavily_search') }
}

function okResponse() {
  return new Response(JSON.stringify({ results: [{ url: 'https://example.com', title: 'Example' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function withFetch(handler, run) {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    const key = String(init.headers.authorization).slice('Bearer '.length)
    seen.push({ key, signal: init.signal, url })
    return handler(key, init, seen.length)
  }
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

test('normal request cancellation propagates the exact caller reason', async () => {
  const { dispose, tool } = install(KEYS)
  const controller = new AbortController()
  const customReason = new Error('user pressed stop')
  try {
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        queueMicrotask(() => controller.abort(customReason))
      }),
      async (seen) => {
        await assert.rejects(
          tool.execute({ query: 'cancel me' }, { signal: controller.signal }),
          (error) => {
            assert.equal(error, customReason)
            return true
          },
        )
        assert.equal(seen.length, 1)
      },
    )
  } finally {
    dispose()
  }
})

test('pre-aborted caller signal rejects immediately with caller reason and issues zero requests', async () => {
  const { dispose, tool } = install(KEYS)
  const controller = new AbortController()
  const reason = { kind: 'caller-cancelled' }
  controller.abort(reason)
  try {
    await withFetch(
      () => okResponse(),
      async (seen) => {
        await assert.rejects(
          tool.execute({ query: 'already cancelled' }, { signal: controller.signal }),
          (error) => {
            assert.equal(error, reason)
            return true
          },
        )
        assert.equal(seen.length, 0)
      },
    )
  } finally {
    dispose()
  }
})

test('own timeout throws HarnessError with TAVILY_TIMEOUT rather than caller cancellation', async () => {
  const { dispose, tool } = install(KEYS, { timeouts: { search: 25 } })
  const controller = new AbortController()
  try {
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }),
      async () => {
        await assert.rejects(
          tool.execute({ query: 'slow request' }, { signal: controller.signal }),
          (error) => {
            assert.equal(error instanceof HarnessError, true)
            assert.equal(error.code, TAVILY_TIMEOUT_CODE)
            assert.notEqual(error.name, 'AbortError')
            assert.equal(controller.signal.aborted, false)
            return true
          },
        )
      },
    )
  } finally {
    dispose()
  }
})

test('failover stops immediately on caller cancellation and does not attempt the next key', async () => {
  const { dispose, tool } = install(KEYS)
  const controller = new AbortController()
  const reason = new Error('stop between keys')
  try {
    await withFetch(
      (_key, _init, attempt) => {
        if (attempt === 1) {
          controller.abort(reason)
          return new Response('', { status: 429 })
        }
        return okResponse()
      },
      async (seen) => {
        await assert.rejects(
          tool.execute({ query: 'failover cancel' }, { signal: controller.signal }),
          (error) => {
            assert.equal(error, reason)
            return true
          },
        )
        assert.deepEqual(seen.map((s) => s.key), [KEYS[0]], 'second key must not be attempted after cancellation')
      },
    )
  } finally {
    dispose()
  }
})

test('quota-blocked probe preserves caller cancellation and own TAVILY_TIMEOUT without wrapping', async () => {
  recordQuotaBlock(keyId(KEYS[0]), 'plan', '2026-01-01T00:00:00.000Z')
  recordQuotaBlock(keyId(KEYS[1]), 'plan', '2026-01-02T00:00:00.000Z')

  // 1. Caller cancellation during probe
  const cancelInst = install(KEYS)
  const caller = new AbortController()
  const cancelReason = new Error('probe cancelled by caller')
  try {
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        queueMicrotask(() => caller.abort(cancelReason))
      }),
      async () => {
        await assert.rejects(
          cancelInst.tool.execute({ query: 'probe cancel' }, { signal: caller.signal }),
          (error) => {
            assert.equal(error, cancelReason)
            return true
          },
        )
      },
    )
  } finally {
    cancelInst.dispose()
  }

  // 2. Own timeout during probe
  const timeoutInst = install(KEYS, { timeouts: { search: 25 } })
  try {
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
      async () => {
        await assert.rejects(
          timeoutInst.tool.execute({ query: 'probe timeout' }, {}),
          (error) => {
            assert.equal(error instanceof HarnessError, true)
            assert.equal(error.code, TAVILY_TIMEOUT_CODE)
            assert.equal(error.message.includes('quota-blocked probe failed'), false)
            return true
          },
        )
      },
    )
  } finally {
    timeoutInst.dispose()
  }
})

test('combineSignals cleans up its timer and caller abort listener on dispose', async () => {
  let activeListeners = 0
  const fakeSignal = {
    aborted: false,
    reason: undefined,
    addEventListener(type) {
      if (type === 'abort') activeListeners++
    },
    removeEventListener(type) {
      if (type === 'abort') activeListeners--
    },
  }
  const combined = combineSignals(fakeSignal, 60_000, 'search')
  assert.equal(activeListeners, 1)
  combined.dispose()
  assert.equal(activeListeners, 0)

  // Also verify through a real tool execution that the listener is detached on completion
  const { dispose, tool } = install(KEYS)
  try {
    await withFetch(() => okResponse(), async () => {
      await tool.execute({ query: 'cleanup' }, { signal: fakeSignal })
    })
    assert.equal(activeListeners, 0)
  } finally {
    dispose()
  }
})

test('real DSH 0.2.2-rc.5 native tool pipeline classifies caller cancellation as ABORTED and own timeout as TAVILY_TIMEOUT', async () => {
  const ctx = new Context()
  ctx.provide('credentials')
  ctx.set('credentials', fakeCredentials(KEYS))
  await ctx.plugin(SystemPromptService)
  await ctx.plugin(ToolsService)
  await ctx.plugin(nativeExecutor)
  const disposeTools = installTavilyTool(ctx, { timeouts: { search: 25 } })

  try {
    // 1. Caller cancellation -> pipeline classifies as AbortError / ABORTED
    const caller = new AbortController()
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        queueMicrotask(() => caller.abort(new Error('turn aborted')))
      }),
      async () => {
        const batch = await ctx.tools.execute({
          calls: [{ id: 'call-cancel', name: 'tavily_search', arguments: JSON.stringify({ query: 'pipeline cancel' }) }],
          signal: caller.signal,
        })
        assert.equal(batch.results.length, 1)
        const { result } = batch.results[0]
        assert.equal(result.isError, true)
        assert.equal(result.error?.info?.code, TOOL_ABORTED)
        assert.equal(result.error?.info?.name, 'AbortError')
      },
    )

    // 2. Own timeout -> pipeline preserves HarnessError / TAVILY_TIMEOUT (NOT ABORTED)
    const liveCaller = new AbortController()
    await withFetch(
      (_key, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      }),
      async () => {
        const batch = await ctx.tools.execute({
          calls: [{ id: 'call-timeout', name: 'tavily_search', arguments: JSON.stringify({ query: 'pipeline timeout' }) }],
          signal: liveCaller.signal,
        })
        assert.equal(batch.results.length, 1)
        const { result } = batch.results[0]
        assert.equal(result.isError, true)
        assert.equal(result.error?.info?.code, TAVILY_TIMEOUT_CODE)
        assert.equal(result.error?.info?.name, 'HarnessError')
        assert.notEqual(result.error?.info?.code, TOOL_ABORTED)
      },
    )
  } finally {
    disposeTools()
    await ctx.fiber.dispose()
  }
})
