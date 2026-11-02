import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { factory, id } from '../src/client.js'

test('lib/client.js is exactly the current client build', () => {
  const expected = 'window.__ModuleLoader__.load({\n'
    + '  id: ' + JSON.stringify(id) + ',\n'
    + '  factory: ' + factory.toString() + '\n'
    + '});\n'
  assert.equal(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), expected)
})
