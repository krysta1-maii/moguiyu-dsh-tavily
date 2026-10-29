/**
 * Tests for the shared routing state: manual intent, quota blocks, recovery
 * metrics, and the memory-only round-robin cursor.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-state-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const {
  RECOVERY_THRESHOLD,
  entryFor,
  getCursor,
  isActive,
  keyId,
  pruneKeys,
  readState,
  recordQuotaBlock,
  recoveryRatio,
  resetCursor,
  setCursor,
  setEnabled,
  setMode,
  statePath,
  clearQuotaBlock,
  usageRatio,
} = await import('../src/state.js')

const KEY = 'tvly-aaaaaaaaaaaaaaaaaaaa'
const OTHER = 'tvly-bbbbbbbbbbbbbbbbbbbb'
const ID = keyId(KEY)

beforeEach(() => {
  rmSync(statePath(), { force: true })
  resetCursor()
})

test('an absent record is enabled and unblocked', () => {
  const state = readState()
  assert.equal(state.mode, 'priority')
  assert.deepEqual(entryFor(state, ID), { enabled: true, quotaBlock: null })
  assert.equal(isActive(entryFor(state, ID)), true)
})

test('key ids are stable, short, and do not contain the key', () => {
  assert.equal(keyId(KEY), keyId(KEY))
  assert.equal(keyId(KEY).length, 16)
  assert.equal(keyId(KEY).includes(KEY), false)
  assert.notEqual(keyId(KEY), keyId(OTHER))
})

test('manual disable and enable control the manual intent', () => {
  setEnabled(ID, false)
  assert.deepEqual(entryFor(readState(), ID), { enabled: false, quotaBlock: null })
  assert.equal(isActive(entryFor(readState(), ID)), false)
  setEnabled(ID, true)
  assert.equal(entryFor(readState(), ID).enabled, true)
})

test('enabling clears a quota block but disabling preserves it', () => {
  recordQuotaBlock(ID, 'plan', '2026-01-01T00:00:00.000Z')
  setEnabled(ID, false)
  assert.deepEqual(entryFor(readState(), ID), {
    enabled: false,
    quotaBlock: { reason: 'plan', at: '2026-01-01T00:00:00.000Z' },
  })
  setEnabled(ID, true)
  assert.deepEqual(entryFor(readState(), ID), { enabled: true, quotaBlock: null })
})

test('clearQuotaBlock only clears the matching reason and an older block', () => {
  recordQuotaBlock(ID, 'plan', '2026-01-02T00:00:00.000Z')
  const sample = Date.parse('2026-01-01T00:00:00.000Z')
  assert.equal(clearQuotaBlock(ID, 'paygo', sample), false)
  assert.notEqual(entryFor(readState(), ID).quotaBlock, null)
  assert.equal(clearQuotaBlock(ID, 'plan', sample), false)
  assert.notEqual(entryFor(readState(), ID).quotaBlock, null)
  assert.equal(clearQuotaBlock(ID, 'plan', Date.parse('2026-01-03T00:00:00.000Z')), true)
  assert.equal(entryFor(readState(), ID).quotaBlock, null)
})

test('mode persists and rejects an unknown value', () => {
  assert.equal(setMode('round_robin'), true)
  assert.equal(readState().mode, 'round_robin')
  assert.equal(setMode('round_robin'), false)
  assert.throws(() => setMode('random'), /mode must be priority or round_robin/)
})

test('usage ratios and recovery use the matching account metric', () => {
  assert.equal(usageRatio(100, 1000), 0.1)
  assert.equal(usageRatio(null, 1000), null)
  assert.equal(usageRatio(100, 0), null)
  const details = { planUsage: 100, planLimit: 1000, paygoUsage: 900, paygoLimit: 1000 }
  assert.equal(recoveryRatio('plan', details), 0.1)
  assert.equal(recoveryRatio('paygo', details), 0.9)
  assert.equal(recoveryRatio('other', details), null)
  assert.equal(RECOVERY_THRESHOLD, 0.4)
})

test('pruneKeys drops records for keys that are gone', () => {
  setEnabled(keyId(KEY), false)
  setEnabled(keyId(OTHER), false)
  assert.equal(pruneKeys([KEY]), true)
  assert.equal(entryFor(readState(), keyId(KEY)).enabled, false)
  assert.deepEqual(entryFor(readState(), keyId(OTHER)), { enabled: true, quotaBlock: null })
})

test('the state file contains no secret and survives a reread', () => {
  setMode('round_robin')
  recordQuotaBlock(ID, 'paygo', '2026-01-01T00:00:00.000Z')
  const text = readFileSync(statePath(), 'utf8')
  assert.equal(text.includes(KEY), false)
  assert.equal(text.includes(OTHER), false)
  assert.equal(readState().mode, 'round_robin')
  assert.equal(readState().keys[ID].quotaBlock.reason, 'paygo')
})

test('a corrupt state file falls back to defaults', () => {
  writeFileSync(statePath(), '{not json', 'utf8')
  const state = readState()
  assert.equal(state.mode, 'priority')
  assert.deepEqual(state.keys, {})
})

test('the round-robin cursor is memory-only', () => {
  assert.equal(getCursor(), null)
  setCursor(ID)
  assert.equal(getCursor(), ID)
  resetCursor()
  assert.equal(getCursor(), null)
});
