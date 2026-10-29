/**
 * Regression tests for the tool-level key rotation.
 *
 * The failure these cover: a key that answers 432 (plan limit) or 433 (paygo
 * limit) was fatal, so the call threw before reaching a healthy key. And an
 * error that threw out of an attempt left the shared cursor parked on the
 * failing key, so every later call started on that same key.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTavilyTool } from '../src/tools.js'

const KEYS = ['key-one-0000000000', 'key-two-1111111111', 'key-three-2222222222']

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
  test(`HTTP ${status} on the first key rotates to the next key in the same call`, async () => {
    const keys = KEYS.slice(0, 2)
    const { dispose, tool } = install(keys)
    try {
      await withFetch(
        (key) => (key === keys[0] ? new Response('', { status }) : okResponse()),
        async (seen) => {
          const result = await tool.execute({ query: 'rotation' }, {})
          assert.deepEqual(seen, [keys[0], keys[1]])
          assert.equal(result.results.length, 1)
        },
      )
    } finally {
      dispose()
    }
  })
}

test('a quota-dead key costs one attempt per call, never the whole call', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 432 }) : okResponse()),
      async (seen) => {
        await tool.execute({ query: 'first' }, {})
        await tool.execute({ query: 'second' }, {})
        assert.deepEqual(seen, [keys[0], keys[1], keys[0], keys[1]])
      },
    )
  } finally {
    dispose()
  }
})

test('all keys on quota fail once each and report the last status', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      () => new Response('', { status: 433 }),
      async (seen) => {
        await assert.rejects(tool.execute({ query: 'quota' }, {}), /all 2 configured key\(s\) failed with HTTP 433/)
        assert.deepEqual(seen, keys)
      },
    )
  } finally {
    dispose()
  }
})

test('an error that throws still moves the cursor past the failing key', async () => {
  const keys = KEYS.slice(0, 2)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(
      (key) => (key === keys[0] ? new Response('', { status: 500 }) : okResponse()),
      async (seen) => {
        await assert.rejects(tool.execute({ query: 'first' }, {}), /HTTP 500/)
        assert.deepEqual(seen, [keys[0]])
        // The cursor moved past the 500 key, so the next call reaches the
        // healthy key instead of failing on the same one again.
        await tool.execute({ query: 'second' }, {})
        assert.deepEqual(seen, [keys[0], keys[1]])
      },
    )
  } finally {
    dispose()
  }
})

test('rotation wraps over three keys in order', async () => {
  const keys = KEYS.slice(0, 3)
  const { dispose, tool } = install(keys)
  try {
    await withFetch(() => okResponse(), async (seen) => {
      await tool.execute({ query: 'a' }, {})
      await tool.execute({ query: 'b' }, {})
      await tool.execute({ query: 'c' }, {})
      assert.deepEqual(seen, [keys[0], keys[1], keys[2]])
    })
  } finally {
    dispose()
  }
})
