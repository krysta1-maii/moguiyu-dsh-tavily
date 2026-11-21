/**
 * Tests for the shared routing state: manual intent, quota blocks, and
 * recovery metrics. The round-robin cursor is not state: it lives in each
 * tools installation.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { HarnessError } from '@deepseek-ai/dsh-error'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-tavily-state-'))
after(() => rmSync(process.env.DSH_HOME, { recursive: true, force: true }))

const stateModule = await import('../src/state.js')
const {
  RECOVERY_THRESHOLD,
  STATE_INVALID_CODE,
  STATE_READ_FAILED_CODE,
  entryFor,
  isActive,
  keyId,
  pruneKeys,
  readState,
  recordQuotaBlock,
  recoveryRatio,
  setEnabled,
  setMode,
  statePath,
  clearQuotaBlock,
  usageRatio,
} = stateModule

const KEY = 'tvly-aaaaaaaaaaaaaaaaaaaa'
const OTHER = 'tvly-bbbbbbbbbbbbbbbbbbbb'
const ID = keyId(KEY)

beforeEach(() => {
  rmSync(statePath(), { recursive: true, force: true })
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

// WP4 replaces the old "corrupt state falls back to defaults" behavior:
// silent fallback caused subsequent writes to overwrite a damaged state file.
test('a corrupt state file fails with TAVILY_STATE_INVALID and is never overwritten by mutations', () => {
  const corrupt = '{not json secret-marker-xyz'
  writeFileSync(statePath(), corrupt, 'utf8')

  const checkInvalid = (fn) => {
    assert.throws(fn, (error) => {
      assert.equal(error instanceof HarnessError, true)
      assert.equal(error.code, STATE_INVALID_CODE)
      assert.equal(error.message.includes(statePath()), true)
      assert.equal(error.message.includes('JSON_PARSE_ERROR'), true)
      assert.equal(error.message.includes('secret-marker-xyz'), false)
      return true
    })
  }

  checkInvalid(() => readState())
  checkInvalid(() => setMode('round_robin'))
  checkInvalid(() => setEnabled(ID, false))
  checkInvalid(() => recordQuotaBlock(ID, 'plan'))
  checkInvalid(() => clearQuotaBlock(ID, 'plan'))
  checkInvalid(() => pruneKeys([KEY]))

  assert.equal(readFileSync(statePath(), 'utf8'), corrupt)
})

test('a non-object JSON root fails with TAVILY_STATE_INVALID without overwriting the file', () => {
  for (const raw of ['[]', 'null', '"hello"', '42', 'true']) {
    writeFileSync(statePath(), raw, 'utf8')
    assert.throws(() => readState(), (error) => {
      assert.equal(error instanceof HarnessError, true)
      assert.equal(error.code, STATE_INVALID_CODE)
      assert.equal(error.message.includes(statePath()), true)
      assert.equal(error.message.includes('EXPECTED_OBJECT'), true)
      return true
    })
    assert.throws(() => setMode('round_robin'), (error) => error.code === STATE_INVALID_CODE)
    assert.equal(readFileSync(statePath(), 'utf8'), raw)
  }
})

test('permission and I/O read failures throw TAVILY_STATE_READ_FAILED without modifying disk state', () => {
  // 1. Directory at state path triggers EISDIR
  mkdirSync(statePath())
  assert.throws(() => readState(), (error) => {
    assert.equal(error instanceof HarnessError, true)
    assert.equal(error.code, STATE_READ_FAILED_CODE)
    assert.equal(error.message.includes(statePath()), true)
    assert.equal(error.message.includes('EISDIR'), true)
    return true
  })
  rmSync(statePath(), { recursive: true, force: true })

  // 2. Simulated I/O error via custom reader
  assert.throws(
    () => readState(() => ({ kind: 'read_error', fsCode: 'EIO', cause: new Error('disk failure') })),
    (error) => {
      assert.equal(error instanceof HarnessError, true)
      assert.equal(error.code, STATE_READ_FAILED_CODE)
      assert.equal(error.message.includes(statePath()), true)
      assert.equal(error.message.includes('EIO'), true)
      return true
    },
  )

  // 3. Unreadable file permissions (non-root)
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const valid = JSON.stringify({ mode: 'round_robin', keys: {}, keySavedAt: {} }) + '\n'
    writeFileSync(statePath(), valid, 'utf8')
    chmodSync(statePath(), 0o000)
    try {
      assert.throws(() => readState(), (error) => {
        assert.equal(error instanceof HarnessError, true)
        assert.equal(error.code, STATE_READ_FAILED_CODE)
        assert.equal(error.message.includes(statePath()), true)
        assert.equal(error.message.includes('EACCES'), true)
        return true
      })
      assert.throws(() => setEnabled(ID, false), (error) => error.code === STATE_READ_FAILED_CODE)
    } finally {
      chmodSync(statePath(), 0o600)
    }
    assert.equal(readFileSync(statePath(), 'utf8'), valid)
  }
})

test('the round-robin cursor is not part of the shared state module', () => {
  for (const name of ['getCursor', 'setCursor', 'resetCursor']) {
    assert.equal(name in stateModule, false, name + ' must not be exported from state.js')
  }
});
