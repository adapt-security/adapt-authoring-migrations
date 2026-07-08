import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import ConfigMigration from '../lib/ConfigMigration.js'

describe('ConfigMigration', () => {
  describe('describe', () => {
    it('should set the description', () => {
      const m = new ConfigMigration()
      m.describe('test config migration')
      assert.equal(m.description, 'test config migration')
    })
  })

  describe('where + mutate', () => {
    it('should record an operation with the module name', () => {
      const fn = () => {}
      const m = new ConfigMigration()
      m.where('mod-a').mutate(fn)
      assert.equal(m.operations.length, 1)
      assert.equal(m.operations[0].module, 'mod-a')
      assert.equal(m.operations[0].fn, fn)
    })

    it('should skip mutate when where module is not in config', () => {
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.where('mod-b').mutate(fn)
      m.execute({ 'mod-a': {} })
      assert.equal(fn.mock.callCount(), 0)
    })

    it('should run mutate when where module is in config', () => {
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.where('mod-a').mutate(fn)
      m.execute({ 'mod-a': { key: 'val' } })
      assert.equal(fn.mock.callCount(), 1)
    })

    it('should support mutate without where', () => {
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.mutate(fn)
      m.execute({ 'mod-a': {} })
      assert.equal(fn.mock.callCount(), 1)
    })

    it('should pass (config, context) to the mutate fn', () => {
      const fn = mock.fn()
      const m = new ConfigMigration()
      const config = { 'mod-a': { key: 'val' } }
      const context = { merged: { 'mod-a': { key: 'val', fromDefaults: 1 } }, isOverrides: true }
      m.mutate(fn)
      m.execute(config, context)
      assert.equal(fn.mock.calls[0].arguments[0], config)
      assert.equal(fn.mock.calls[0].arguments[1], context)
    })

    it('should default context to an empty object when omitted', () => {
      let seen
      const m = new ConfigMigration()
      m.mutate((config, context) => { seen = context })
      m.execute({ 'mod-a': {} })
      assert.deepEqual(seen, {})
    })
  })

  describe('replace', () => {
    it('should replace a key to another module with a new name', () => {
      const config = {
        'mod-a': { oldKey: 'value', other: 1 },
        'mod-b': {}
      }
      const m = new ConfigMigration()
      m.where('mod-a').replace('oldKey', 'mod-b', 'newKey')
      m.execute(config)

      assert.deepEqual(config, {
        'mod-a': { other: 1 },
        'mod-b': { newKey: 'value' }
      })
    })

    it('should keep the same key name when destKey is omitted', () => {
      const config = { 'mod-a': { key: 'value' }, 'mod-b': {} }
      const m = new ConfigMigration()
      m.where('mod-a').replace('key', 'mod-b')
      m.execute(config)

      assert.deepEqual(config, { 'mod-b': { key: 'value' } })
    })

    it('should create destination module section if it does not exist', () => {
      const config = { 'mod-a': { key: 'value' } }
      const m = new ConfigMigration()
      m.where('mod-a').replace('key', 'mod-b', 'newKey')
      m.execute(config)

      assert.deepEqual(config, { 'mod-b': { newKey: 'value' } })
    })

    it('should skip replace when source key does not exist', () => {
      const config = { 'mod-a': { other: 1 } }
      const m = new ConfigMigration()
      m.where('mod-a').replace('missing', 'mod-b', 'newKey')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { other: 1 } })
    })

    it('should skip replace when where module is not in config', () => {
      const config = { 'mod-a': { key: 'value' } }
      const m = new ConfigMigration()
      m.where('mod-b').replace('key', 'mod-a', 'newKey')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { key: 'value' } })
    })

    it('should rename within the same module', () => {
      const config = { 'mod-a': { oldKey: 'value' } }
      const m = new ConfigMigration()
      m.where('mod-a').replace('oldKey', 'mod-a', 'newKey')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { newKey: 'value' } })
    })

    it('should clean up empty source module after replaces', () => {
      const config = { 'mod-a': { key: 'value' } }
      const m = new ConfigMigration()
      m.where('mod-a').replace('key', 'mod-b', 'key')
      m.execute(config)

      assert.equal(config['mod-a'], undefined)
      assert.deepEqual(config['mod-b'], { key: 'value' })
    })
  })

  describe('remove', () => {
    it('should remove a single key', () => {
      const config = { 'mod-a': { keep: 1, drop: 2 } }
      const m = new ConfigMigration()
      m.where('mod-a').remove('drop')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { keep: 1 } })
    })

    it('should remove multiple keys', () => {
      const config = { 'mod-a': { a: 1, b: 2, c: 3 } }
      const m = new ConfigMigration()
      m.where('mod-a').remove('a', 'b')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { c: 3 } })
    })

    it('should clean up empty module after removes', () => {
      const config = { 'mod-a': { only: 1 } }
      const m = new ConfigMigration()
      m.where('mod-a').remove('only')
      m.execute(config)

      assert.equal(config['mod-a'], undefined)
    })

    it('should skip remove when where module is not in config', () => {
      const config = { 'mod-a': { key: 1 } }
      const m = new ConfigMigration()
      m.where('mod-b').remove('key')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { key: 1 } })
    })

    it('should not throw when removing a non-existent key', () => {
      const config = { 'mod-a': { key: 1 } }
      const m = new ConfigMigration()
      m.where('mod-a').remove('missing')
      m.execute(config)

      assert.deepEqual(config, { 'mod-a': { key: 1 } })
    })
  })

  describe('chaining', () => {
    it('should support chaining move, remove, and mutate', () => {
      const config = {
        'old-mod': { levels: ['info'], showTimestamp: true, mute: false, dateFormat: 'iso' }
      }
      const m = new ConfigMigration()
      m
        .where('old-mod')
        .replace('levels', 'new-mod', 'logLevels')
        .replace('showTimestamp', 'new-mod', 'showLogTimestamp')
        .remove('mute', 'dateFormat')

      m.execute(config)

      assert.deepEqual(config, {
        'new-mod': { logLevels: ['info'], showLogTimestamp: true }
      })
    })

    it('should support multiple where blocks', () => {
      const config = {
        'mod-a': { key: 'a' },
        'mod-b': { key: 'b' }
      }
      const m = new ConfigMigration()
      m
        .where('mod-a').replace('key', 'mod-c', 'fromA')
        .where('mod-b').replace('key', 'mod-c', 'fromB')
      m.execute(config)

      assert.deepEqual(config, {
        'mod-c': { fromA: 'a', fromB: 'b' }
      })
    })
  })
})
