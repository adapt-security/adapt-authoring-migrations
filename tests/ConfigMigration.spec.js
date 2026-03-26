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

  describe('run', () => {
    it('should register the function', () => {
      const m = new ConfigMigration()
      const fn = async () => {}
      m.run(fn)
      assert.equal(m._fn, fn)
    })
  })

  describe('execute', () => {
    it('should call the registered function with the context', async () => {
      const m = new ConfigMigration()
      const fn = mock.fn()
      m.run(fn)
      const context = { readFile: () => {}, writeFile: () => {} }
      await m.execute(context)

      assert.equal(fn.mock.callCount(), 1)
      assert.equal(fn.mock.calls[0].arguments[0], context)
    })

    it('should throw if no run function was registered', async () => {
      const m = new ConfigMigration()
      await assert.rejects(
        () => m.execute({}),
        { message: 'No run() function registered' }
      )
    })

    it('should propagate errors from the run function', async () => {
      const m = new ConfigMigration()
      m.run(async () => { throw new Error('config write failed') })
      await assert.rejects(
        () => m.execute({}),
        { message: 'config write failed' }
      )
    })
  })
})
