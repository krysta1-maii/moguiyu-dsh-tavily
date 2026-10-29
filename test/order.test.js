/**
 * Tests for the masked-order helper the manager route uses to persist priority.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { maskValue, reorderByMask } from '../src/lib.js'

const A = 'tvly-aaaaaaaaaaaaaaaaaaaa'
const B = 'tvly-bbbbbbbbbbbbbbbbbbbb'
const C = 'tvly-cccccccccccccccccccc'

test('applies a full permutation of masked keys', () => {
  const order = [maskValue(C), maskValue(A), maskValue(B)]
  assert.deepEqual(reorderByMask([A, B, C], order), [C, A, B])
})

test('rejects a partial or extended list', () => {
  assert.equal(reorderByMask([A, B, C], [maskValue(A), maskValue(B)]), null)
  assert.equal(reorderByMask([A, B], [maskValue(A), maskValue(B), maskValue(C)]), null)
})

test('rejects an unknown or repeated masked key', () => {
  assert.equal(reorderByMask([A, B], [maskValue(A), maskValue(C)]), null)
  assert.equal(reorderByMask([A, B], [maskValue(A), maskValue(A)]), null)
})

test('refuses to guess when two keys share a mask', () => {
  const prefix = 'tvly-' + 'a'.repeat(7)
  const twinOne = prefix + 'X' + 'abcd'
  const twinTwo = prefix + 'Y' + 'abcd'
  assert.equal(maskValue(twinOne), maskValue(twinTwo))
  assert.equal(reorderByMask([twinOne, twinTwo], [maskValue(twinOne), maskValue(twinTwo)]), null)
})
