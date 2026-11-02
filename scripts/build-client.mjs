/**
 * Build lib/client.js from src/client.js.
 *
 * The browser module loader expects a lazy CommonJS factory:
 * window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *
 * Run with `npm run build` (or `node scripts/build-client.mjs`).
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { factory, id } from '../src/client.js'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const output = join(root, 'lib', 'client.js')

const source = 'window.__ModuleLoader__.load({\n'
  + '  id: ' + JSON.stringify(id) + ',\n'
  + '  factory: ' + factory.toString() + '\n'
  + '});\n'

await mkdir(dirname(output), { recursive: true })
await writeFile(output, source)
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' })
console.log('wrote ' + output + ' (' + Buffer.byteLength(source) + ' bytes)')
