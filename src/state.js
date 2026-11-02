/**
 * Shared routing state for `@moguiyu/dsh-tavily`.
 *
 * The key list itself stays in credentials; this module only records how the
 * list should be used:
 *
 * - `mode`: "priority" starts every call at the first active key, while
 *   "round_robin" starts after the key attempted by the previous call.
 * - `keys[id]`: a per-key availability record. `enabled` is the user's manual
 *   intent; `quotaBlock` is the automatic 432/433 block. Effective
 *   availability is `enabled && quotaBlock === null`. Keeping the two
 *   separate is what stops the usage refresh from re-enabling a key the user
 *   turned off by hand.
 *
 * State lives next to the existing `keySavedAt` records in
 * `~/.dsh/tavily-manager.json`, keyed by a short SHA-256 id rather than the
 * display mask. The file holds no secret. The file is shared by every preset:
 * the call order and the availability records apply process-wide, while the
 * round-robin cursor is per installation and lives in `tools.js`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readJsonFile } from './lib.js'

export const MODE_PRIORITY = 'priority'
export const MODE_ROUND_ROBIN = 'round_robin'

/** Re-enable a quota-blocked key only after this fraction of its limit is used. */
export const RECOVERY_THRESHOLD = 0.4

const STATE_FILE = 'tavily-manager.json'

export function statePath() {
  return join(resolveDshHome(), STATE_FILE)
}

/** Stable, non-reversible id used in the API and in the state file. */
export function keyId(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

function normalizeQuotaBlock(value) {
  if (value === null || typeof value !== 'object') return null
  const reason = value.reason === 'paygo' ? 'paygo' : value.reason === 'plan' ? 'plan' : null
  if (reason === null) return null
  const at = typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at)) ? value.at : new Date().toISOString()
  return { reason, at }
}

function normalizeEntry(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    enabled: source.enabled !== false,
    quotaBlock: normalizeQuotaBlock(source.quotaBlock),
  }
}

export function normalizeState(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const keys = {}
  if (source.keys !== null && typeof source.keys === 'object' && !Array.isArray(source.keys)) {
    for (const [id, entry] of Object.entries(source.keys)) keys[id] = normalizeEntry(entry)
  }
  return {
    ...source,
    mode: source.mode === MODE_ROUND_ROBIN ? MODE_ROUND_ROBIN : MODE_PRIORITY,
    keys,
    keySavedAt: source.keySavedAt !== null && typeof source.keySavedAt === 'object' && !Array.isArray(source.keySavedAt)
      ? source.keySavedAt
      : {},
  }
}

export function readState() {
  return normalizeState(readJsonFile(statePath(), {}))
}

export function writeState(state) {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function updateEntry(id, update) {
  const state = readState()
  const before = entryFor(state, id)
  const entry = { enabled: before.enabled, quotaBlock: before.quotaBlock === null ? null : { ...before.quotaBlock } }
  update(entry)
  if (entry.enabled === before.enabled && JSON.stringify(entry.quotaBlock) === JSON.stringify(before.quotaBlock)) return false
  state.keys[id] = entry
  writeState(state)
  return true
}

/** The availability record for a key; absent records mean enabled and unblocked. */
export function entryFor(state, id) {
  const entry = state.keys[id]
  return entry === undefined ? { enabled: true, quotaBlock: null } : entry
}

export function isActive(entry) {
  return entry.enabled && entry.quotaBlock === null
}

export function setMode(mode) {
  if (mode !== MODE_PRIORITY && mode !== MODE_ROUND_ROBIN) throw new Error('mode must be priority or round_robin')
  const state = readState()
  if (state.mode === mode) return false
  state.mode = mode
  writeState(state)
  return true
}

/**
 * Set manual intent. Enabling also clears a quota block: the user asking for
 * the key is an explicit override of the automatic decision.
 */
export function setEnabled(id, enabled) {
  return updateEntry(id, (entry) => {
    entry.enabled = enabled === true
    if (entry.enabled) entry.quotaBlock = null
  })
}

export function recordQuotaBlock(id, reason, at = new Date().toISOString()) {
  if (reason !== 'plan' && reason !== 'paygo') throw new Error('quota reason must be plan or paygo')
  return updateEntry(id, (entry) => {
    entry.quotaBlock = { reason, at }
  })
}

/**
 * Clear a quota block only when the reason matches and the block predates the
 * usage sample. `notAfter` is the sample's epoch milliseconds: a block set
 * after that sample must survive, or a concurrent 432 would be undone by a
 * stale refresh.
 */
export function clearQuotaBlock(id, reason, notAfter) {
  return updateEntry(id, (entry) => {
    if (entry.quotaBlock === null) return
    if (reason !== undefined && entry.quotaBlock.reason !== reason) return
    if (notAfter !== undefined) {
      const blockedAt = Date.parse(entry.quotaBlock.at)
      if (Number.isFinite(blockedAt) && blockedAt > notAfter) return
    }
    entry.quotaBlock = null
  })
}

/** Drop records for keys that are no longer configured. */
export function pruneKeys(keys) {
  const known = new Set(keys.map((key) => keyId(key)))
  const state = readState()
  let changed = false
  for (const id of Object.keys(state.keys)) {
    if (!known.has(id)) {
      delete state.keys[id]
      changed = true
    }
  }
  if (changed) writeState(state)
  return changed
}

export function usageRatio(used, limit) {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null
  return used / limit
}

/** The ratio that governs recovery for a block reason; null when unavailable. */
export function recoveryRatio(reason, details) {
  if (details === null || details === undefined) return null
  if (reason === 'plan') return usageRatio(details.planUsage, details.planLimit)
  if (reason === 'paygo') return usageRatio(details.paygoUsage, details.paygoLimit)
  return null
}
