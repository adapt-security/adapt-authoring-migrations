import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { serializeConfig } from '../lib/utils/serializeConfig.js'

describe('serializeConfig', () => {
  it('should serialise scalars', () => {
    assert.equal(serializeConfig('hi'), '"hi"')
    assert.equal(serializeConfig(42), '42')
    assert.equal(serializeConfig(true), 'true')
    assert.equal(serializeConfig(null), 'null')
    assert.equal(serializeConfig(undefined), 'undefined')
  })

  it('should serialise empty containers', () => {
    assert.equal(serializeConfig({}), '{}')
    assert.equal(serializeConfig([]), '[]')
  })

  it('should preserve undefined-valued keys (unlike JSON)', () => {
    const out = serializeConfig({ a: 1, b: undefined })
    assert.ok(out.includes('"b": undefined'))
  })

  it('should quote keys and match a 2-space nested shape', () => {
    const out = serializeConfig({ mod: { key: 'val' } })
    assert.equal(out, '{\n  "mod": {\n    "key": "val"\n  }\n}')
  })

  it('should round-trip via a real ES module import, keeping undefined', async () => {
    const value = {
      'adapt-authoring-assets': { customFfmpegCommand: undefined, other: 'x' },
      'adapt-authoring-core': { logLevels: ['error', 'warn'], nested: { n: 1 } }
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ser-'))
    const file = path.join(dir, 'out.config.js')
    await fs.writeFile(file, `export default ${serializeConfig(value)}\n`, 'utf8')
    const loaded = (await import(pathToFileURL(file).href)).default
    assert.deepEqual(loaded['adapt-authoring-core'], value['adapt-authoring-core'])
    assert.ok('customFfmpegCommand' in loaded['adapt-authoring-assets'])
    assert.equal(loaded['adapt-authoring-assets'].customFfmpegCommand, undefined)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
