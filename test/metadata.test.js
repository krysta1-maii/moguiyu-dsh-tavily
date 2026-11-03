/**
 * Tests for the package-level plugin metadata: the eight locale files the
 * Plugins list reads, and the manifest entries that publish them.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const LOCALES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

test('the package publishes metadata for all eight shipped DSH locales', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.files.includes('locale'), true)
  assert.deepEqual(
    readdirSync(new URL('../locale', import.meta.url)).sort(),
    LOCALES.map((id) => id + '.json').sort(),
  )
  for (const id of LOCALES) {
    const file = new URL(`../locale/${id}.json`, import.meta.url)
    const { meta } = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof meta?.title, 'string', id + ': title must be a string')
    assert.ok(meta.title.trim().length > 0, id + ': title must not be empty')
    assert.equal(typeof meta?.description, 'string', id + ': description must be a string')
    assert.ok(meta.description.trim().length > 0, id + ': description must not be empty')
  }
})
