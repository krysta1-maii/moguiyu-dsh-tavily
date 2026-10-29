/**
 * Pure helpers for the Tavily backend (exported for tests).
 */
import { readFileSync } from 'node:fs'

/**
 * Mask a key for display: `first12…last4`; comma-separated lists are masked
 * per part. Never reveals more than a fingerprint.
 */
export function maskValue(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  return value.split(',').map((part) => {
    const p = part.trim()
    if (p.length <= 12) return '••••'
    return p.slice(0, 12) + '…' + p.slice(-4)
  }).join(', ')
}

/** Split a comma-separated credential value into trimmed, deduped keys. */
export function parseKeyList(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  const out = []
  for (const part of value.split(',')) {
    const key = part.trim()
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Reorder `keys` by a permutation of their masked values.
 *
 * The card identifies keys by `maskValue`, so a move sends the new order as
 * masked fingerprints. Returns `null` when the request is not a permutation of
 * the current list, or when two keys share a fingerprint — the order cannot be
 * applied without guessing which key is which.
 */
export function reorderByMask(keys, order) {
  if (!Array.isArray(order) || order.length !== keys.length) return null
  const byMask = new Map()
  for (const key of keys) {
    const masked = maskValue(key)
    if (byMask.has(masked)) return null
    byMask.set(masked, key)
  }
  const seen = new Set()
  const out = []
  for (const masked of order) {
    if (typeof masked !== 'string' || seen.has(masked)) return null
    const key = byMask.get(masked)
    if (key === undefined) return null
    seen.add(masked)
    out.push(key)
  }
  return out
}

/** Read a JSON object file; `fallback` on missing or unparsable content. */
export function readJsonFile(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}
