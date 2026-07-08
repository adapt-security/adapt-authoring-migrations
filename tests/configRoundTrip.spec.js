import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import ConfigMigration from '../lib/ConfigMigration.js'
import { executeConfMigration } from '../lib/runMigrations.js'

// A defaults.config.js that carries the round-trip markers, mirroring the umbrella's.
const DEFAULTS_FIXTURE = `
const defaults = { 'mod-x': { keepDefault: 1, sharedKey: 'default' } }
const CONFIG_OVERRIDES = Symbol.for('adapt-authoring:configOverrides')
const CONFIG_DEFAULTS = Symbol.for('adapt-authoring:configDefaults')
export function withOverrides (overrides) {
  const merged = { ...defaults }
  for (const [k, v] of Object.entries(overrides)) merged[k] = { ...(defaults[k] || {}), ...v }
  Object.defineProperty(merged, CONFIG_OVERRIDES, {
    value: { overrides, importSpecifier: './defaults.config.js', helper: 'withOverrides' },
    enumerable: false
  })
  return merged
}
Object.defineProperty(defaults, CONFIG_DEFAULTS, { value: { role: 'defaults' }, enumerable: false })
export default defaults
`

function fakeDb () {
  const inserted = []
  return { inserted, collection: () => ({ insertOne: async doc => { inserted.push(doc) } }) }
}

function collectLog () {
  const logs = []
  return { logs, log: (level, id, msg) => logs.push({ level, msg }) }
}

function confMigration (build) {
  const cm = new ConfigMigration()
  build(cm)
  return { module: 'mod-x', version: '1.0.0', type: 'conf', description: cm.description, configMigration: cm }
}

async function makeConfDir (files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confmig-'))
  await fs.mkdir(path.join(dir, 'conf'))
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, 'conf', name), content, 'utf8')
  }
  return dir
}

// Re-import a written file from a fresh copy so the ESM cache doesn't return the pre-write module.
async function importFresh (dir, ...names) {
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'confimport-'))
  await fs.mkdir(path.join(fresh, 'conf'))
  for (const name of names) {
    await fs.copyFile(path.join(dir, 'conf', name), path.join(fresh, 'conf', name))
  }
  return (await import(pathToFileURL(path.join(fresh, 'conf', names[0])).href)).default
}

describe('executeConfMigration round-trip', () => {
  it('should transform only the overrides and re-emit withOverrides(), skipping the baseline', async () => {
    const dir = await makeConfDir({
      'defaults.config.js': DEFAULTS_FIXTURE,
      'production.config.js': "import { withOverrides } from './defaults.config.js'\nexport default withOverrides({ 'mod-x': { override: 'A', dropMe: 'gone' }, 'mod-y': { onlyOverride: true } })\n"
    })
    const db = fakeDb()
    const { log } = collectLog()
    const confState = { loaded: false, files: new Map() }
    await executeConfMigration(confMigration(cm => { cm.describe('drop'); cm.where('mod-x').remove('dropMe') }),
      { readOnlyConfig: false, dryRun: false, db, rootDir: dir, log, confState })

    const prod = await fs.readFile(path.join(dir, 'conf', 'production.config.js'), 'utf8')
    assert.ok(prod.startsWith("import { withOverrides } from './defaults.config.js'"))
    assert.ok(prod.includes('export default withOverrides({'))
    assert.ok(prod.includes('"override": "A"'))
    assert.ok(!prod.includes('dropMe'), 'removed key gone')
    assert.ok(!prod.includes('keepDefault'), 'defaults NOT inlined')

    // baseline left untouched
    const def = await fs.readFile(path.join(dir, 'conf', 'defaults.config.js'), 'utf8')
    assert.equal(def, DEFAULTS_FIXTURE)

    // rewritten file is valid and still merges defaults
    const merged = await importFresh(dir, 'production.config.js', 'defaults.config.js')
    assert.equal(merged['mod-x'].override, 'A')
    assert.equal(merged['mod-x'].keepDefault, 1)
    assert.ok(!('dropMe' in merged['mod-x']))
    assert.equal(merged['mod-y'].onlyOverride, true)

    assert.equal(db.inserted.length, 1)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should rewrite a plain object export and preserve undefined-valued keys', async () => {
    const dir = await makeConfDir({
      'production.config.js': 'export default { "mod-a": { keep: 1, unset: undefined, drop: 2 } }\n'
    })
    const db = fakeDb()
    const { log } = collectLog()
    const confState = { loaded: false, files: new Map() }
    await executeConfMigration(confMigration(cm => { cm.describe('drop'); cm.where('mod-a').remove('drop') }),
      { readOnlyConfig: false, dryRun: false, db, rootDir: dir, log, confState })

    const text = await fs.readFile(path.join(dir, 'conf', 'production.config.js'), 'utf8')
    assert.ok(text.startsWith('export default {'))
    assert.ok(text.includes('"unset": undefined'), 'undefined preserved')
    assert.ok(!text.includes('drop'))

    const loaded = await importFresh(dir, 'production.config.js')
    assert.ok('unset' in loaded['mod-a'])
    assert.equal(loaded['mod-a'].unset, undefined)
    assert.equal(loaded['mod-a'].keep, 1)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should compose multiple config migrations on one file', async () => {
    const dir = await makeConfDir({
      'defaults.config.js': DEFAULTS_FIXTURE,
      'production.config.js': "import { withOverrides } from './defaults.config.js'\nexport default withOverrides({ 'mod-x': { a: 1, b: 2, c: 3 } })\n"
    })
    const db = fakeDb()
    const { log } = collectLog()
    const confState = { loaded: false, files: new Map() }
    const ctx = { readOnlyConfig: false, dryRun: false, db, rootDir: dir, log, confState }
    await executeConfMigration(confMigration(cm => { cm.describe('m1'); cm.where('mod-x').remove('a') }), ctx)
    await executeConfMigration(confMigration(cm => { cm.describe('m2'); cm.where('mod-x').remove('b') }), ctx)

    const merged = await importFresh(dir, 'production.config.js', 'defaults.config.js')
    assert.ok(!('a' in merged['mod-x']), 'first migration kept')
    assert.ok(!('b' in merged['mod-x']), 'second migration kept')
    assert.equal(merged['mod-x'].c, 3)
    assert.equal(db.inserted.length, 2)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should not write and not record in read-only mode', async () => {
    const original = "import { withOverrides } from './defaults.config.js'\nexport default withOverrides({ 'mod-x': { override: 'A' } })\n"
    const dir = await makeConfDir({ 'defaults.config.js': DEFAULTS_FIXTURE, 'production.config.js': original })
    const db = fakeDb()
    const { logs, log } = collectLog()
    const confState = { loaded: false, files: new Map() }
    await executeConfMigration(confMigration(cm => { cm.describe('drop'); cm.where('mod-x').remove('override') }),
      { readOnlyConfig: true, dryRun: false, db, rootDir: dir, log, confState })

    const prod = await fs.readFile(path.join(dir, 'conf', 'production.config.js'), 'utf8')
    assert.equal(prod, original, 'file untouched in read-only mode')
    assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('READ-ONLY CONFIG')))
    assert.equal(db.inserted.length, 0, 'not recorded, so it re-warns next boot')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('should report instead of write when the conf dir is not writable, and not record', async () => {
    const db = fakeDb()
    const { logs, log } = collectLog()
    // pre-loaded cache with writable:false, so no real FS write is attempted
    const confState = {
      loaded: true,
      writable: false,
      files: new Map([['/app/conf/production.config.js', {
        kind: 'overrides',
        meta: { overrides: { 'mod-x': { override: 'A' } }, importSpecifier: './defaults.config.js', helper: 'withOverrides' },
        working: { 'mod-x': { override: 'A' } },
        baselineMerged: { 'mod-x': { override: 'A', keepDefault: 1 } }
      }]])
    }
    await executeConfMigration(confMigration(cm => { cm.describe('drop'); cm.where('mod-x').remove('override') }),
      { readOnlyConfig: false, dryRun: false, db, rootDir: '/app', log, confState })

    assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('conf dir is not writable')))
    assert.ok(logs.some(l => l.msg.startsWith('  - mod-x.override')))
    assert.equal(db.inserted.length, 0, 'not recorded, so it re-reports next boot')
  })

  it('should skip a file whose mutate is not null-safe and not record', async () => {
    const dir = await makeConfDir({
      'defaults.config.js': DEFAULTS_FIXTURE,
      'production.config.js': "import { withOverrides } from './defaults.config.js'\nexport default withOverrides({ 'mod-y': { keep: 1 } })\n"
    })
    const db = fakeDb()
    const { logs, log } = collectLog()
    const confState = { loaded: false, files: new Map() }
    // mutate assumes a section that exists only in defaults (mod-x), not the overrides
    await executeConfMigration(confMigration(cm => { cm.describe('bad'); cm.mutate(config => { config['mod-x'].sharedKey = 'x' }) }),
      { readOnlyConfig: false, dryRun: false, db, rootDir: dir, log, confState })

    assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('null-safe')))
    assert.equal(db.inserted.length, 0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
