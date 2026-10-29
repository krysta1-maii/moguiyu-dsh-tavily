/**
 * Tests for key routing: priority vs round-robin, per-key availability, and
 * the 432/433 quota block. Every test gets its own temporary DSH home so the
 * state file never touches the real one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-routing-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const { installTavilyTool } = await import('../src/tools.js')
const {
  entryFor,
  keyId,
  readState,
  recordQuotaBlock,
  resetCursor,
  setEnabled,
  setMode,
  statePath,
} = await import('../src/state.js')

const KEYS = ['key-one-0000000000', 'key-two-1111111111', 'key-three-2222222222']

beforeEach(() => {
  rmSync(statePath(), { force: true })
  resetCursor()
})

/** Install the tools against a fake credentials service holding `keys`. */
function install(keys) {
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
      if (service !== 'credentials') return undefined
      return {
        async resolve(ref) {
          if (ref === 'TAVILY_API_KEYS') {
            return keys.length > 0 ? { value: keys.join(','), source: 'file' } : undefined
          }
          if (ref === 'TAVILY_API_KEY') {
            return keys.length > 0 ? { value: keys[0], source: 'file' } : undefined
          }
          return undefined
        },
      }
    },
  }
  const dispose = installTavilyTool(ctx)
  return { dispose, tool: definitions.get('tavily_search') }
}

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
    const key = String(init.headers.authorization).slice('Bearer '.length)
    seen.push(key)
    return handler(key, seen.length)
  }
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

for (const status of [401, 429, 432, 433]) {
  test(`HTTP ${status} on the first key falls through to the next key`, async () => {
    const keys = KEYS.slice(0, 2)
    const { dispose, tool } = install(keys)
    try {
      await withFetch(
        (key) => (key === keys[0] ? new Response('', { status }) : okResponse()),
        async (seen) => {
          const result = await tool.execute({ query: 'priority' }, {})
          assert.deepEqual(seen, [keys[0], keys[1]])
          assert.equal(result.results.length, 1)
        },
      )
    } finally {
      dispose()
    }
  })
}

test('a healthy first key serves every call', async () => {
  const keys = KEYS.slice(0, 3)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await tool.execute({ query: 'a' }, {})
      await tool.execute({ query: 'b' }, {})
      await tool.execute({ query: 'c' }, {})
      assert.deepEqual(seen, [keys[0], keys[0], keys[0]])
    })
  } finally {
    dispose()
  }
})

test('a 432 disables the key for later calls', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 432 }) : okResponse()),
      async (seen) => {
        await tool.execute({ query: 'first' }, {})
        assert.deepEqual(seen, [keys[0], keys[1]])
        await tool.execute({ query: 'second' }, {})
        assert.deepEqual(seen, [keys[0], keys[1], keys[1]])
      },
    )
    assert.equal(entryFor(readState(), keyId(keys[0])).quotaBlock.reason, 'plan')
  } finally {
    dispose()
  }
})

test('a 433 records a paygo block', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 433 }) : okResponse()),
      async () => { await tool.execute({ query: 'paygo' }, {}) },
    )
    assert.equal(entryFor(readState(), keyId(keys[0])).quotaBlock.reason, 'paygo')
  } finally {
    dispose()
  }
})

test('401 and 429 do not persist an availability block', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 429 }) : okResponse()),
      async () => { await tool.execute({ query: 'rate' }, {}) },
    )
    assert.equal(entryFor(readState(), keyId(keys[0])).quotaBlock, null)
  } finally {
    dispose()
  }
})

test('priority mode starts at the first active key every call', async () => {
  const keys = KEYS.slice(0, 3)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => {
        if (key === keys[0]) return new Response('', { status: 432 })
        if (key === keys[1]) return new Response('', { status: 429 })
        return okResponse()
      },
      async (seen) => {
        await tool.execute({ query: 'first' }, {})
        assert.deepEqual(seen, keys)
        await tool.execute({ query: 'second' }, {})
        assert.deepEqual(seen, [keys[0], keys[1], keys[2], keys[1], keys[2]])
      },
    )
  } finally {
    dispose()
  }
})

test('priority mode skips a manually disabled key', async () => {
  const keys = KEYS.slice(0, 2)
  setEnabled(keyId(keys[0]), false)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await tool.execute({ query: 'skip' }, {})
      assert.deepEqual(seen, [keys[1]])
    })
  } finally {
    dispose()
  }
})

test('round-robin walks the active keys in list order', async () => {
  setMode('round_robin')
  const keys = KEYS.slice(0, 3)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await tool.execute({ query: 'a' }, {})
      await tool.execute({ query: 'b' }, {})
      await tool.execute({ query: 'c' }, {})
      await tool.execute({ query: 'd' }, {})
      assert.deepEqual(seen, [keys[0], keys[1], keys[2], keys[0]])
    })
  } finally {
    dispose()
  }
})

test('round-robin skips manually disabled keys', async () => {
  setMode('round_robin')
  const keys = KEYS.slice(0, 3)
  setEnabled(keyId(keys[1]), false)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await tool.execute({ query: 'a' }, {})
      await tool.execute({ query: 'b' }, {})
      await tool.execute({ query: 'c' }, {})
      assert.deepEqual(seen, [keys[0], keys[2], keys[0]])
    })
  } finally {
    dispose()
  }
})

test('round-robin advances past the successful key after a failover', async () => {
  setMode('round_robin')
  const keys = KEYS.slice(0, 3)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 432 }) : okResponse()),
      async (seen) => {
        await tool.execute({ query: 'first' }, {})
        assert.deepEqual(seen, [keys[0], keys[1]])
        await tool.execute({ query: 'second' }, {})
        assert.deepEqual(seen, [keys[0], keys[1], keys[2]])
      },
    )
  } finally {
    dispose()
  }
})

test('all quota-blocked keys fail once each and report the last status', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      () => new Response('', { status: 433 }),
      async (seen) => {
        await assert.rejects(tool.execute({ query: 'quota' }, {}), /all 2 attempted key\(s\) failed with HTTP 433/)
        assert.deepEqual(seen, keys)
      },
    )
  } finally {
    dispose()
  }
})

test('a 500 on the first key ends the call without trying the next key', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 500 }) : okResponse()),
      async (seen) => {
        await assert.rejects(tool.execute({ query: 'first' }, {}), /HTTP 500/)
        assert.deepEqual(seen, [keys[0]])
        await assert.rejects(tool.execute({ query: 'second' }, {}), /HTTP 500/)
        assert.deepEqual(seen, [keys[0], keys[0]])
      },
    )
  } finally {
    dispose()
  }
})

test('all manually disabled keys fail without a request', async () => {
  const keys = KEYS.slice(0, 2)
  setEnabled(keyId(keys[0]), false)
  setEnabled(keyId(keys[1]), false)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await assert.rejects(tool.execute({ query: 'off' }, {}), /no active keys/)
      assert.deepEqual(seen, [])
    })
  } finally {
    dispose()
  }
})

test('all quota-blocked keys probe the oldest one and recover on success', async () => {
  const keys = KEYS.slice(0, 2)
  recordQuotaBlock(keyId(keys[0]), 'plan', '2026-01-01T00:00:00.000Z')
  recordQuotaBlock(keyId(keys[1]), 'plan', '2026-01-02T00:00:00.000Z')
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? okResponse() : new Response('', { status: 432 })),
      async (seen) => {
        const result = await tool.execute({ query: 'probe' }, {})
        assert.deepEqual(seen, [keys[0]])
        assert.equal(result.results.length, 1)
      },
    )
    assert.equal(entryFor(readState(), keyId(keys[0])).quotaBlock, null)
    assert.notEqual(entryFor(readState(), keyId(keys[1])).quotaBlock, null)
  } finally {
    dispose()
  }
})

test('a failed quota probe keeps the block and reports the status', async () => {
  const keys = KEYS.slice(0, 2)
  recordQuotaBlock(keyId(keys[0]), 'plan', '2026-01-01T00:00:00.000Z')
  recordQuotaBlock(keyId(keys[1]), 'plan', '2026-01-02T00:00:00.000Z')
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      () => new Response('', { status: 432 }),
      async (seen) => {
        await assert.rejects(tool.execute({ query: 'probe' }, {}), /still returned HTTP 432/)
        assert.deepEqual(seen, [keys[0]])
      },
    )
    assert.notEqual(entryFor(readState(), keyId(keys[0])).quotaBlock, null)
  } finally {
    dispose()
  }
})
