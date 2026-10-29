/**
 * Routes half of `@moguiyu/dsh-tavily`: key, availability, and usage
 * management on the harness webServer (`/api/tavily-usage`,
 * `/api/tavily-manager`). The built-in `web_search` tool is never replaced —
 * no web search provider is registered and `web.searchProvider` is never
 * touched.
 *
 * The manager owns three pieces of state now: the credential list, the call
 * mode (priority or round-robin), and a per-key availability record. The
 * availability record is deliberately separate from the credential list, so a
 * key can be turned off or quota-blocked without rewriting the list and
 * without losing its position.
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

const USAGE_TTL_MS = 60000
const usageCache = new Map()

const LEGACY_STATE = 'tavily-settings.json'
const REFS = ['TAVILY_API_KEYS', 'TAVILY_API_KEY']
const MODES = new Set([MODE_PRIORITY, MODE_ROUND_ROBIN])

const READONLY_LIST = 'TAVILY_API_KEYS is supplied read-only by the launching environment, so the key list cannot be changed here. Unset it in the shell you start dsh from, or manage keys in ~/.dsh/.credentials.yaml.'
const READONLY_PRIMARY = 'That key comes from TAVILY_API_KEY, which the launching environment supplies read-only. Unset it in the shell you start dsh from.'

function legacyStatePath() {
  return join(resolveDshHome(), LEGACY_STATE)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text.length > 0 ? JSON.parse(text) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function metric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Fetch one key's usage. The response separates the key's own counters from
 * the account plan and pay-as-you-go counters; recovery uses the account
 * counters because 432/433 are account-level plan/paygo errors.
 *
 * `minFetchedAt` forces a fresh request when the cached sample predates a
 * quota block; a sample taken before the block must not clear it.
 */
async function fetchUsageDetailsFor(key, { minFetchedAt = 0 } = {}) {
  const cached = usageCache.get(key)
  const minAt = Number.isFinite(minFetchedAt) ? minFetchedAt : 0
  if (cached !== undefined && Date.now() - cached.at < USAGE_TTL_MS && cached.details.fetchedAt >= minAt) {
    return cached.details
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let response
    try {
      response = await fetch('https://api.tavily.com/usage', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
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
    const details = {
      usage: keyUsage !== null ? keyUsage : planUsage,
      keyUsage,
      keyLimit,
      planUsage,
      planLimit,
      paygoUsage,
      paygoLimit,
      currentPlan,
      fetchedAt: Date.now(),
    }
    usageCache.set(key, { at: details.fetchedAt, details })
    return details
  } catch {
    return null
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
 * Register the Tavily key/usage routes on `ctx.webServer`:
 * `/api/tavily-usage` and `/api/tavily-manager`.
 *
 * Every route is registered through `ctx.effect`, so the calling fiber owns
 * it and unloading the row leaves nothing registered.
 */
export function installBackend(ctx) {
  const credentials = ctx.get('credentials')

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-usage',
    handler: async (_req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const { values: keys } = await collectStoredKeys(credentials)
        if (keys.length === 0) return send(res, 200, { ok: false, error: 'no Tavily API key configured' })
        const initial = readState()
        const fetched = []
        for (const key of keys) {
          const id = keyId(key)
          const entry = entryFor(initial, id)
          const blockAt = entry.quotaBlock !== null ? Date.parse(entry.quotaBlock.at) : 0
          const details = await fetchUsageDetailsFor(key, { minFetchedAt: Number.isFinite(blockAt) ? blockAt : 0 })
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
        return send(res, 200, {
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
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'tavily-backend: route /api/tavily-usage')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/tavily-manager',
    handler: async (req, res) => {
      if (credentials === undefined) return send(res, 500, { ok: false, error: 'credentials service unavailable' })
      try {
        const url = new URL(req.url || '/', 'http://x')
        if (req.method === 'GET') {
          const reveal = url.searchParams.get('reveal')
          const { values: keys, source } = await collectStoredKeys(credentials)
          if (reveal !== null) {
            const match = keys.find((key) => maskValue(key) === reveal)
            if (match === undefined) return send(res, 404, { ok: false, error: 'key not found' })
            return send(res, 200, { ok: true, value: match })
          }
          return send(res, 200, { ok: true, ...(await buildManagerPayload(keys, source)) })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
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
            return send(res, 400, { ok: false, error: 'mode must be priority or round_robin' })
          }
          if (body.setEnabled !== undefined && !Array.isArray(body.setEnabled)) {
            return send(res, 400, { ok: false, error: 'setEnabled must be an array of { id, enabled }' })
          }
          const toggles = []
          for (const item of Array.isArray(body.setEnabled) ? body.setEnabled : []) {
            if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0 || typeof item.enabled !== 'boolean') {
              return send(res, 400, { ok: false, error: 'setEnabled must be an array of { id, enabled }' })
            }
            toggles.push({ id: item.id, enabled: item.enabled })
          }

          const keysChanged = addValues.length > 0 || removeMasked.length > 0 || orderMasked.length > 0
          let { values: stored, source } = await collectStoredKeys(credentials)
          if (orderMasked.length > 0) {
            const reordered = reorderByMask(stored, orderMasked)
            if (reordered === null) {
              return send(res, 409, { ok: false, error: 'order must list every current key exactly once, by its masked value' })
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
              return send(res, 409, { ok: false, error: 'setEnabled references a key that is not in the list' })
            }
          }

          // A ref the launching environment supplies is inherited READ-ONLY: set and
          // unset throw for it. Decide that BEFORE writing anything. Mode and
          // availability changes only touch the routing state, so they stay
          // available even when the list itself is read-only.
          if (keysChanged) {
            const canWriteList = await refWritable(credentials, 'TAVILY_API_KEYS')
            const canWritePrimary = await refWritable(credentials, 'TAVILY_API_KEY')
            if (!canWriteList) return send(res, 409, { ok: false, error: READONLY_LIST })
            if (!canWritePrimary && source === 'primary' && removeMasked.length > 0) {
              return send(res, 409, { ok: false, error: READONLY_PRIMARY })
            }
            // Emptying the list while an inherited primary still carries a key would
            // read straight back as that key, so refuse rather than appear to undo itself.
            if (values.length === 0 && !canWritePrimary) {
              const inherited = parseKeyList(await resolveRef(credentials, 'TAVILY_API_KEY') ?? '')
              if (inherited.length > 0) return send(res, 409, { ok: false, error: READONLY_PRIMARY })
            }

            if (values.length === 0) {
              await credentials.unset('TAVILY_API_KEYS')
              await syncPrimary(credentials, null)
            } else {
              await credentials.set('TAVILY_API_KEYS', values.join(','))
              await syncPrimary(credentials, values[0])
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

          return send(res, 200, { ok: true, ...(await buildManagerPayload(values, source)) })
        }
        return send(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'tavily-backend: route /api/tavily-manager')
}
