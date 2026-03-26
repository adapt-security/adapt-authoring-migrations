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
      m.where('adapt-authoring-logger').mutate(fn)
      assert.equal(m.operations.length, 1)
      assert.equal(m.operations[0].module, 'adapt-authoring-logger')
      assert.equal(m.operations[0].fn, fn)
    })

    it('should clear _currentModule after mutate', () => {
      const m = new ConfigMigration()
      m.where('mod-a').mutate(() => {})
      assert.equal(m._currentModule, null)
    })

    it('should support mutate without where', () => {
      const fn = () => {}
      const m = new ConfigMigration()
      m.mutate(fn)
      assert.equal(m.operations.length, 1)
      assert.equal(m.operations[0].module, null)
      assert.equal(m.operations[0].fn, fn)
    })
  })

  describe('chaining', () => {
    it('should support chaining multiple where/mutate pairs', () => {
      const m = new ConfigMigration()
      m
        .where('mod-a').mutate(() => {})
        .where('mod-b').mutate(() => {})
        .mutate(() => {})

      assert.equal(m.operations.length, 3)
      assert.equal(m.operations[0].module, 'mod-a')
      assert.equal(m.operations[1].module, 'mod-b')
      assert.equal(m.operations[2].module, null)
    })
  })

  describe('execute', () => {
    it('should call mutate fn with the config object', () => {
      const config = { 'mod-a': { key: 'value' } }
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.mutate(fn)
      m.execute(config)

      assert.equal(fn.mock.callCount(), 1)
      assert.equal(fn.mock.calls[0].arguments[0], config)
    })

    it('should skip mutate when where module is not in config', () => {
      const config = { 'mod-a': { key: 'value' } }
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.where('mod-b').mutate(fn)
      m.execute(config)

      assert.equal(fn.mock.callCount(), 0)
    })

    it('should run mutate when where module is in config', () => {
      const config = { 'mod-a': { key: 'value' } }
      const fn = mock.fn()
      const m = new ConfigMigration()
      m.where('mod-a').mutate(fn)
      m.execute(config)

      assert.equal(fn.mock.callCount(), 1)
      assert.equal(fn.mock.calls[0].arguments[0], config)
    })

    it('should execute operations in order', () => {
      const order = []
      const config = { 'mod-a': {}, 'mod-b': {} }
      const m = new ConfigMigration()
      m
        .where('mod-a').mutate(() => order.push('a'))
        .where('mod-b').mutate(() => order.push('b'))
        .mutate(() => order.push('c'))
      m.execute(config)

      assert.deepEqual(order, ['a', 'b', 'c'])
    })

    it('should allow mutate to modify the config object', () => {
      const config = {
        'old-module': { key: 'value' },
        'new-module': {}
      }
      const m = new ConfigMigration()
      m.where('old-module').mutate(cfg => {
        cfg['new-module'].key = cfg['old-module'].key
        delete cfg['old-module']
      })
      m.execute(config)

      assert.deepEqual(config, { 'new-module': { key: 'value' } })
    })
  })
})
