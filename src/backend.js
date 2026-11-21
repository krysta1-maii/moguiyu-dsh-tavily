/**
 * Routes half of `@moguiyu/dsh-tavily`: key, availability, and usage
 * management on DSH Connection Fetch routes (`/api/tavily-usage`,
 * `/api/tavily-manager`, `/api/tavily-manager/update`). The built-in
 * `web_search` tool is never replaced — no web search provider is registered
 * and `web.searchProvider` is never touched.
 *
 * The manager owns three pieces of state now: the credential list, the call
 * mode (priority or round-robin), and a per-key availability record. The
 * availability record is deliberately separate from the credential list, so a
 * key can be turned off or quota-blocked without rewriting the list and
 * without losing its position.
 *
 * Only the package root entry imports this module. The preset tools entry
 * (`./tools`) never loads it, so no preset can register a second copy of any
 * route, and the management routes exist exactly once per Host.
 *
 * All routes run behind `ctx.connection.fetch`, which enforces Host/Origin
 * trust, authentication, and owner-only access before our handlers execute.
 * Full API keys are never returned by any route.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { maskValue, parseKeyList, readJsonFile, reorderByMask } from './lib.js'
import {
  MODE_PRIORITY,
  MODE_ROUND_ROBIN,
  RECOVERY_THRESHOLD,
  clearQuotaBlock,
  entryFor,
  isActive,
  keyId,
  readState,
  recoveryRatio,
  setEnabled,
  setMode,
  writeState,
} from './state.js'

export const MAX_MANAGER_BODY_BYTES = 64 * 1024
export const USAGE_TTL_MS = 60000

const USAGE_TIMEOUT_MS = 15000

const LEGACY_STATE = 'tavily-settings.json'
const REFS = ['TAVILY_API_KEYS', 'TAVILY_API_KEY']
const MODES = new Set([MODE_PRIORITY, MODE_ROUND_ROBIN])

const READONLY_LIST = 'TAVILY_API_KEYS is supplied read-only by the launching environment, so the key list cannot be changed here. Unset it in the shell you start dsh from, or manage keys in ~/.dsh/.credentials.yaml.'
const READONLY_PRIMARY = 'That key comes from TAVILY_API_KEY, which the launching environment supplies read-only. Unset it in the shell you start dsh from.'

function legacyStatePath() {
  return join(resolveDshHome(), LEGACY_STATE)
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function methodNotAllowed(allowed) {
  return jsonResponse(405, { ok: false, error: 'method not allowed' }, { allow: allowed.join(', ') })
}

/**
 * Stream a JSON object body up to `maxBytes`. Checks `Content-Length` early
 * when present, and always counts actual streamed bytes so unknown-length or
 * misdeclared bodies cannot bypass the cap. Cancels the stream on rejection.
 */
async function readJsonBody(request, maxBytes = MAX_MANAGER_BODY_BYTES) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    await request.body?.cancel().catch(() => {})
    return { ok: false, status: 415, error: 'content-type must be application/json' }
  }
  const declared = request.headers.get('content-length')?.trim()
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => {})
    return { ok: false, status: 413, error: 'request body too large' }
  }
  if (request.body === null) return { ok: true, value: {} }
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && value.byteLength > 0) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return { ok: false, status: 413, error: 'request body too large' }
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return { ok: true, value: {} }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder('utf-8').decode(bytes)
  if (text.length === 0) return { ok: true, value: {} }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' }
  }
  return { ok: true, value: parsed }
}

function metric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pruneUsageCache(cache, activeIds, currentTime) {
  for (const [id, entry] of cache) {
    if (currentTime - entry.at >= USAGE_TTL_MS || (activeIds !== undefined && !activeIds.has(id))) {
      cache.delete(id)
    }
  }
}

/**
 * Fetch one key's usage. The response separates the key's own counters from
 * the account plan and pay-as-you-go counters; recovery uses the account
 * counters because 432/433 are account-level plan/paygo errors.
 *
 * `minFetchedAt` forces a fresh request when the cached sample predates a
 * quota block; a sample taken before the block must not clear it.
 * `signal` cancels the upstream request when the caller disconnects.
 * The cache is owned by the Host install and keyed strictly by `keyId(key)`.
 */
async function fetchUsageDetailsFor(key, { cache, id = keyId(key), minFetchedAt = 0, signal, now = Date.now } = {}) {
  const minAt = Number.isFinite(minFetchedAt) ? minFetchedAt : 0
  const cached = cache.get(id)
  if (cached !== undefined) {
    if (now() - cached.at >= USAGE_TTL_MS) {
      cache.delete(id)
    } else if (cached.details.fetchedAt >= minAt) {
      return cached.details
    }
  }
  if (signal?.aborted) return null
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal !== undefined && signal !== null) {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.tavily.com/usage', {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const json = await response.json()
    const account = json !== null && typeof json === 'object' ? json.account : undefined
    const keyInfo = json !== null && typeof json === 'object' ? json.key : undefined
    const keyUsage = metric(keyInfo?.usage)
    const keyLimit = metric(keyInfo?.limit)
    const planUsage = metric(account?.plan_usage)
    const planLimit = metric(account?.plan_limit)
    const paygoUsage = metric(account?.paygo_usage)
    const paygoLimit = metric(account?.paygo_limit)
    const currentPlan = account !== undefined && typeof account.current_plan === 'string' ? account.current_plan : null
    if (keyUsage === null && planUsage === null && paygoUsage === null) return null
    const fetchedAt = now()
    const details = {
      usage: keyUsage !== null ? keyUsage : planUsage,
      keyUsage,
      keyLimit,
      planUsage,
      planLimit,
      paygoUsage,
      paygoLimit,
      currentPlan,
      fetchedAt,
    }
    cache.set(id, { at: fetchedAt, details })
    return details
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }
}

/** Resolve one credential ref to its string value, or `null` when absent. */
async function resolveRef(credentials, ref) {
  try {
    const hit = await credentials.resolve(ref)
    return hit !== undefined && hit !== null && typeof hit.value === 'string' ? hit.value : null
  } catch {
    return null
  }
}

/**
 * Whether a ref can be written here. The launching environment's variables are
 * inherited READ-ONLY: `set`/`unset` throw for them (`describe().writable === false`).
 * Assume writable when the service cannot say.
 */
async function refWritable(credentials, ref) {
  try {
    const info = await credentials.describe(ref)
    return info === undefined || info === null || info.writable !== false
  } catch {
    return true
  }
}

/**
 * The managed key list, and where it came from.
 *
 * `TAVILY_API_KEYS` is AUTHORITATIVE. `TAVILY_API_KEY` — the derived primary — is
 * read only as a fallback, for a deployment that sets nothing else. The two used to
 * be unioned, and that was a bug with two faces: an environment-supplied
 * `TAVILY_API_KEY` re-added its key on every read, so that key could never be deleted
 * from the card; and every write then tried to re-sync the primary, which the
 * launching environment owns, so the write threw AFTER the list had already changed.
 */
async function collectStoredKeys(credentials) {
  const fromList = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEYS') ?? '')
  if (fromList.length > 0) return { values: dedupe([...fromList]), source: 'list' }
  const fromPrimary = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEY') ?? '')
  return { values: dedupe([...fromPrimary]), source: fromPrimary.length > 0 ? 'primary' : 'list' }
}

function dedupe(values) {
  const out = []
  const seen = new Set()
  for (const key of values) {
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Keep the derived primary in step with the list, best effort. The tools read
 * `TAVILY_API_KEYS`, so a primary the environment owns must never fail the request.
 */
async function syncPrimary(credentials, value) {
  if (!(await refWritable(credentials, 'TAVILY_API_KEY'))) return false
  try {
    if (value === null) await credentials.unset('TAVILY_API_KEY')
    else await credentials.set('TAVILY_API_KEY', value)
    return true
  } catch {
    return false
  }
}

/**
 * Warn once, at Host startup, when neither `TAVILY_API_KEYS` nor
 * `TAVILY_API_KEY` holds a key.
 *
 * The check lives here rather than in `installTavilyTool` because the tools
 * entry is mounted by several presets; a check there would print the same
 * warning once per preset. It reuses `collectStoredKeys`, so it reads the
 * credential service exactly as the card does, caches no secret, and prints no
 * key material. Any failure degrades to one warning.
 */
export function warnIfNoKeys(ctx) {
  const credentials = ctx !== undefined && ctx !== null ? ctx.get('credentials') : undefined
  if (credentials === undefined || credentials === null) return
  collectStoredKeys(credentials).then(({ values }) => {
    if (values.length === 0) {
      ctx.logger.warn('tavily_search: TAVILY_API_KEYS or TAVILY_API_KEY is not configured; add it via the Tavily card on the Plugins page or ~/.dsh/.credentials.yaml')
    }
  }).catch((error) => {
    ctx.logger.warn('tavily_search: credential check failed: %s', error instanceof Error ? error.message : String(error))
  })
}

/**
 * Register the Tavily key/usage routes on `ctx.connection.fetch`:
 * `GET /api/tavily-usage`, `GET /api/tavily-manager`, and
 * `POST /api/tavily-manager/update`.
 *
 * Every route is registered through `ctx.effect`, so the calling fiber owns
 * it and unloading the row disposes every route cleanly.
 */
export function installBackend(ctx, options = {}) {
  const credentials = ctx.get('credentials')
  const usageCache = options.usageCache instanceof Map ? options.usageCache : new Map()
  const now = typeof options.now === 'function' ? options.now : Date.now

  ctx.effect(() => () => {
    usageCache.clear()
  }, 'tavily-backend: usage cache')

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('credentials/reference-updated', (ref) => {
      if (ref === 'TAVILY_API_KEYS' || ref === 'TAVILY_API_KEY') usageCache.clear()
    }), 'tavily-backend: credentials cache invalidation')
  }

  function errorResponse(error) {
    if (error instanceof Error && typeof error.code === 'string' && error.code.startsWith('TAVILY_')) {
      return jsonResponse(500, { ok: false, code: error.code, error: error.message })
    }
    ctx.logger.warn('tavily-backend: request failed: %s', error instanceof Error ? error.message : String(error))
    return jsonResponse(500, { ok: false, error: 'internal server error' })
  }

  // ── key manager payload ────────────────────────────────────────────────────
  async function buildManagerPayload(keys, source = 'list') {
    const state = readState()
    const keySavedAt = state.keySavedAt !== undefined && typeof state.keySavedAt === 'object' ? state.keySavedAt : {}
    if (Object.keys(keySavedAt).length === 0 && credentials !== undefined) {
      // Migrate dates recorded by the pre-0.2 layout (ref-keyed legacy file).
      const legacy = readJsonFile(legacyStatePath(), null)
      if (legacy !== null && typeof legacy === 'object') {
        for (const ref of REFS) {
          const entry = legacy[ref]
          if (entry !== null && typeof entry === 'object' && typeof entry.savedAt === 'string') {
            try {
              const hit = await credentials.resolve(ref)
              if (hit !== undefined) keySavedAt[maskValue(hit.value)] = entry.savedAt
            } catch {
              /* keep going */
            }
          }
        }
      }
    }
    // The card needs to know what it may change. A ref inherited from the
    // launching environment is read-only, and saying so beats a raw 500 from
    // `set` after the list has already been written.
    const keysWritable = credentials === undefined ? true : await refWritable(credentials, 'TAVILY_API_KEYS')
    const primaryWritable = credentials === undefined ? true : await refWritable(credentials, 'TAVILY_API_KEY')
    const removable = source === 'list' ? keysWritable : primaryWritable
    const entries = keys.map((value) => {
      const id = keyId(value)
      const entry = entryFor(state, id)
      const masked = maskValue(value)
      return {
        id,
        masked,
        savedAt: keySavedAt[masked] !== undefined ? keySavedAt[masked] : null,
        enabled: entry.enabled,
        active: isActive(entry),
        quotaBlock: entry.quotaBlock,
        removable,
      }
    })
    const firstActive = entries.findIndex((entry) => entry.active)
    return {
      keys: entries.map((entry, index) => ({ ...entry, primary: state.mode === MODE_PRIORITY && index === firstActive })),
      mode: state.mode,
      source,
      writable: { keys: keysWritable, primary: primaryWritable },
    }
  }

  /**
   * The usage refresh is also the reconciliation point for quota blocks: a
   * 432/433 key comes back only when the same limit the block was based on is
   * below 40% again. This is a GET with a side effect on purpose — the card's
   * refresh is the only trigger, and it must leave the tool layer with the
   * recovered state.
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/tavily-usage',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      if (credentials === undefined) return jsonResponse(500, { ok: false, error: 'credentials service unavailable' })
      try {
        const { values: keys } = await collectStoredKeys(credentials)
        pruneUsageCache(usageCache, new Set(keys.map(keyId)), now())
        if (keys.length === 0) return jsonResponse(200, { ok: false, error: 'no Tavily API key configured' })
        const initial = readState()
        const fetched = []
        for (const key of keys) {
          if (request.signal?.aborted) break
          const id = keyId(key)
          const entry = entryFor(initial, id)
          const blockAt = entry.quotaBlock !== null ? Date.parse(entry.quotaBlock.at) : 0
          const details = await fetchUsageDetailsFor(key, {
            cache: usageCache,
            id,
            minFetchedAt: Number.isFinite(blockAt) ? blockAt : 0,
            signal: request.signal,
            now,
          })
          if (details !== null && entry.quotaBlock !== null) {
            const ratio = recoveryRatio(entry.quotaBlock.reason, details)
            if (ratio !== null && ratio < RECOVERY_THRESHOLD) {
              if (clearQuotaBlock(id, entry.quotaBlock.reason, details.fetchedAt)) {
                ctx.logger.info('tavily: quota block cleared for key %s (%s)', id, entry.quotaBlock.reason)
              }
            }
          }
          fetched.push({ key, id, details })
        }
        const finalState = readState()
        const perKey = fetched.map(({ key, id, details }) => {
          const entry = entryFor(finalState, id)
          const base = {
            id,
            masked: maskValue(key),
            enabled: entry.enabled,
            active: isActive(entry),
            quotaBlock: entry.quotaBlock,
          }
          return details === null
            ? { ok: false, ...base, error: 'usage unavailable' }
            : { ok: true, ...base, ...details }
        })
        const okRows = perKey.filter((row) => row.ok)
        return jsonResponse(200, {
          ok: true,
          perKey,
          totals: {
            keys: keys.length,
            okKeys: okRows.length,
            usage: okRows.reduce((sum, row) => sum + (row.usage || 0), 0),
            planUsage: okRows.reduce((sum, row) => sum + (row.planUsage || 0), 0),
            planLimit: okRows.every((row) => row.planLimit !== null) ? okRows.reduce((sum, row) => sum + row.planLimit, 0) : null,
          },
        })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'tavily-backend: route /api/tavily-usage')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/tavily-manager',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      if (credentials === undefined) return jsonResponse(500, { ok: false, error: 'credentials service unavailable' })
      try {
        const { values: keys, source } = await collectStoredKeys(credentials)
        return jsonResponse(200, { ok: true, ...(await buildManagerPayload(keys, source)) })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'tavily-backend: route /api/tavily-manager')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/tavily-manager/update',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        await request.body?.cancel().catch(() => {})
        return methodNotAllowed(['POST'])
      }
      if (credentials === undefined) {
        await request.body?.cancel().catch(() => {})
        return jsonResponse(500, { ok: false, error: 'credentials service unavailable' })
      }
      try {
        const parsed = await readJsonBody(request, MAX_MANAGER_BODY_BYTES)
        if (!parsed.ok) return jsonResponse(parsed.status, { ok: false, error: parsed.error })
        const body = parsed.value

        const addValues = Array.isArray(body.add)
          ? body.add.map((item) => typeof item === 'string' ? item.trim() : '').filter((value) => value.length > 0)
          : []
        const removeMasked = Array.isArray(body.remove)
          ? body.remove.filter((item) => typeof item === 'string' && item.length > 0)
          : []
        const orderMasked = Array.isArray(body.order)
          ? body.order.filter((item) => typeof item === 'string' && item.length > 0)
          : []
        const modeValue = body.mode === undefined ? null : body.mode
        if (modeValue !== null && (typeof modeValue !== 'string' || !MODES.has(modeValue))) {
          return jsonResponse(400, { ok: false, error: 'mode must be priority or round_robin' })
        }
        if (body.setEnabled !== undefined && !Array.isArray(body.setEnabled)) {
          return jsonResponse(400, { ok: false, error: 'setEnabled must be an array of { id, enabled }' })
        }
        const toggles = []
        for (const item of Array.isArray(body.setEnabled) ? body.setEnabled : []) {
          if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || typeof item.enabled !== 'boolean') {
            return jsonResponse(400, { ok: false, error: 'setEnabled must be an array of { id, enabled }' })
          }
          toggles.push({ id: item.id, enabled: item.enabled })
        }

        const keysChanged = addValues.length > 0 || removeMasked.length > 0 || orderMasked.length > 0
        let { values: stored, source } = await collectStoredKeys(credentials)
        if (orderMasked.length > 0) {
          const reordered = reorderByMask(stored, orderMasked)
          if (reordered === null) {
            return jsonResponse(409, { ok: false, error: 'order must list every current key exactly once, by its masked value' })
          }
          stored = reordered
        }
        if (removeMasked.length > 0) {
          stored = stored.filter((key) => !removeMasked.includes(maskValue(key)))
        }
        const values = [...stored]
        for (const value of addValues) {
          if (!values.includes(value)) values.push(value)
        }
        const knownIds = new Set(values.map(keyId))
        for (const toggle of toggles) {
          if (!knownIds.has(toggle.id)) {
            return jsonResponse(409, { ok: false, error: 'setEnabled references a key that is not in the list' })
          }
        }

        // A ref the launching environment supplies is inherited READ-ONLY: set and
        // unset throw for it. Decide that BEFORE writing anything. Mode and
        // availability changes only touch the routing state, so they stay
        // available even when the list itself is read-only.
        if (keysChanged) {
          const canWriteList = await refWritable(credentials, 'TAVILY_API_KEYS')
          const canWritePrimary = await refWritable(credentials, 'TAVILY_API_KEY')
          if (!canWriteList) return jsonResponse(409, { ok: false, error: READONLY_LIST })
          if (!canWritePrimary && source === 'primary' && removeMasked.length > 0) {
            return jsonResponse(409, { ok: false, error: READONLY_PRIMARY })
          }
          // Emptying the list while an inherited primary still carries a key would
          // read straight back as that key, so refuse rather than appear to undo itself.
          if (values.length === 0 && !canWritePrimary) {
            const inherited = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEY') ?? '')
            if (inherited.length > 0) return jsonResponse(409, { ok: false, error: READONLY_PRIMARY })
          }

          if (values.length === 0) {
            await credentials.unset('TAVILY_API_KEYS')
            await syncPrimary(credentials, null)
          } else {
            await credentials.set('TAVILY_API_KEYS', values.join(','))
            await syncPrimary(credentials, values[0])
          }

          if (addValues.length > 0 || removeMasked.length > 0) {
            usageCache.clear()
          }

          // Keep the saved dates, prune availability records for removed keys,
          // and preserve mode/availability while replacing keySavedAt.
          const state = readState()
          const kept = new Set(values.map(keyId))
          for (const id of Object.keys(state.keys)) {
            if (!kept.has(id)) delete state.keys[id]
          }
          const now = new Date().toISOString()
          const nextSavedAt = {}
          for (const value of values) {
            const masked = maskValue(value)
            nextSavedAt[masked] = state.keySavedAt[masked] !== undefined ? state.keySavedAt[masked] : now
          }
          state.keySavedAt = nextSavedAt
          writeState(state)
        }

        if (modeValue !== null) setMode(modeValue)
        for (const toggle of toggles) setEnabled(toggle.id, toggle.enabled)

        return jsonResponse(200, { ok: true, ...(await buildManagerPayload(values, source)) })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'tavily-backend: route /api/tavily-manager/update')
}
