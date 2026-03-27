import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import DataMigration from '../lib/DataMigration.js'
import { filterPending } from '../lib/runMigrations.js'

// ── DataMigration ────────────────────────────────────────────────────

describe('DataMigration', () => {
  describe('describe', () => {
    it('should set the description', () => {
      const dsl = new DataMigration()
      dsl.describe('test migration')
      assert.equal(dsl.description, 'test migration')
    })
  })

  describe('where + mutate', () => {
    it('should record a mutate operation with the query', () => {
      const dsl = new DataMigration()
      const fn = () => {}
      dsl.where({ collection: 'users', active: true }).mutate(fn)
      assert.equal(dsl.operations.length, 1)
      assert.equal(dsl.operations[0].type, 'mutate')
      assert.deepEqual(dsl.operations[0].query, { collection: 'users', active: true })
      assert.equal(dsl.operations[0].fn, fn)
    })

    it('should clear _currentQuery after mutate', () => {
      const dsl = new DataMigration()
      dsl.where({ collection: 'x' }).mutate(() => {})
      assert.equal(dsl._currentQuery, null)
    })
  })

  describe('where + check', () => {
    it('should record a check operation with the query', () => {
      const dsl = new DataMigration()
      const fn = () => {}
      dsl.where({ collection: 'items', status: 'active' }).check(fn)
      assert.equal(dsl.operations.length, 1)
      assert.equal(dsl.operations[0].type, 'check')
      assert.deepEqual(dsl.operations[0].query, { collection: 'items', status: 'active' })
    })
  })

  describe('setIndex', () => {
    it('should record a setIndex operation', () => {
      const dsl = new DataMigration()
      dsl.setIndex('users', { email: 1 }, { unique: true })
      assert.equal(dsl.operations.length, 1)
      assert.deepEqual(dsl.operations[0], {
        type: 'setIndex',
        collection: 'users',
        spec: { email: 1 },
        options: { unique: true }
      })
    })

    it('should work without options', () => {
      const dsl = new DataMigration()
      dsl.setIndex('logs', { createdAt: -1 })
      assert.equal(dsl.operations[0].options, undefined)
    })
  })

  describe('dropIndex', () => {
    it('should record a dropIndex operation', () => {
      const dsl = new DataMigration()
      dsl.dropIndex('users', 'email_1')
      assert.deepEqual(dsl.operations[0], {
        type: 'dropIndex',
        collection: 'users',
        name: 'email_1'
      })
    })
  })

  describe('renameCollection', () => {
    it('should record a renameCollection operation', () => {
      const dsl = new DataMigration()
      dsl.renameCollection('old_name', 'new_name')
      assert.deepEqual(dsl.operations[0], {
        type: 'renameCollection',
        from: 'old_name',
        to: 'new_name'
      })
    })
  })

  describe('runCommand', () => {
    it('should record a runCommand operation', () => {
      const fn = async () => {}
      const dsl = new DataMigration()
      dsl.runCommand(fn)
      assert.equal(dsl.operations[0].type, 'runCommand')
      assert.equal(dsl.operations[0].fn, fn)
    })
  })

  describe('chaining', () => {
    it('should support chaining multiple operations', () => {
      const dsl = new DataMigration()
      dsl
        .where({ collection: 'a' }).mutate(() => {})
        .where({ collection: 'b' }).check(() => {})
        .setIndex('c', { x: 1 })
        .dropIndex('c', 'old_idx')
        .renameCollection('d', 'e')
        .runCommand(() => {})

      assert.equal(dsl.operations.length, 6)
      assert.equal(dsl.operations[0].type, 'mutate')
      assert.equal(dsl.operations[1].type, 'check')
      assert.equal(dsl.operations[2].type, 'setIndex')
      assert.equal(dsl.operations[3].type, 'dropIndex')
      assert.equal(dsl.operations[4].type, 'renameCollection')
      assert.equal(dsl.operations[5].type, 'runCommand')
    })
  })

  describe('execute', () => {
    it('should find and replace docs for mutate operations', async () => {
      const docs = [
        { _id: '1', name: 'old' },
        { _id: '2', name: 'old' }
      ]
      const replacedDocs = []
      const db = {
        collection: mock.fn(() => ({
          find: mock.fn(() => ({ toArray: async () => [...docs.map(d => ({ ...d }))] })),
          replaceOne: mock.fn(async (filter, doc) => { replacedDocs.push({ filter, doc }) })
        }))
      }
      const dsl = new DataMigration()
      dsl.where({ collection: 'test', name: 'old' }).mutate(doc => { doc.name = 'new' })
      await dsl.execute(db)

      assert.equal(replacedDocs.length, 2)
      assert.equal(replacedDocs[0].doc.name, 'new')
      assert.equal(replacedDocs[1].doc.name, 'new')
    })

    it('should pass filter without collection to find', async () => {
      let capturedFilter
      const db = {
        collection: mock.fn(() => ({
          find: mock.fn((filter) => {
            capturedFilter = filter
            return { toArray: async () => [] }
          }),
          replaceOne: mock.fn()
        }))
      }
      const dsl = new DataMigration()
      dsl.where({ collection: 'test', active: true, status: 'pending' }).mutate(() => {})
      await dsl.execute(db)

      assert.deepEqual(capturedFilter, { active: true, status: 'pending' })
    })

    it('should throw on check failure', async () => {
      const db = {
        collection: mock.fn(() => ({
          find: mock.fn(() => ({ toArray: async () => [{ _id: '1', invalid: true }] }))
        }))
      }
      const dsl = new DataMigration()
      dsl.where({ collection: 'test' }).check(doc => {
        if (doc.invalid) throw new Error('validation failed')
      })
      await assert.rejects(
        () => dsl.execute(db),
        { message: 'validation failed' }
      )
    })

    it('should call createIndex for setIndex', async () => {
      const createIndexMock = mock.fn()
      const db = {
        collection: mock.fn(() => ({ createIndex: createIndexMock }))
      }
      const dsl = new DataMigration()
      dsl.setIndex('users', { email: 1 }, { unique: true })
      await dsl.execute(db)

      assert.equal(db.collection.mock.calls[0].arguments[0], 'users')
      assert.deepEqual(createIndexMock.mock.calls[0].arguments, [{ email: 1 }, { unique: true }])
    })

    it('should pass empty options when none provided for setIndex', async () => {
      const createIndexMock = mock.fn()
      const db = {
        collection: mock.fn(() => ({ createIndex: createIndexMock }))
      }
      const dsl = new DataMigration()
      dsl.setIndex('users', { email: 1 })
      await dsl.execute(db)

      assert.deepEqual(createIndexMock.mock.calls[0].arguments[1], {})
    })

    it('should call dropIndex for dropIndex', async () => {
      const dropIndexMock = mock.fn()
      const db = {
        collection: mock.fn(() => ({ dropIndex: dropIndexMock }))
      }
      const dsl = new DataMigration()
      dsl.dropIndex('users', 'email_1')
      await dsl.execute(db)

      assert.equal(dropIndexMock.mock.calls[0].arguments[0], 'email_1')
    })

    it('should call db.renameCollection for renameCollection', async () => {
      const db = { renameCollection: mock.fn() }
      const dsl = new DataMigration()
      dsl.renameCollection('old', 'new')
      await dsl.execute(db)

      assert.deepEqual(db.renameCollection.mock.calls[0].arguments, ['old', 'new'])
    })

    it('should call fn(db) for runCommand', async () => {
      const commandFn = mock.fn()
      const db = {}
      const dsl = new DataMigration()
      dsl.runCommand(commandFn)
      await dsl.execute(db)

      assert.equal(commandFn.mock.calls[0].arguments[0], db)
    })

    it('should execute operations in order', async () => {
      const order = []
      const db = {
        collection: mock.fn(() => ({
          find: mock.fn(() => ({
            toArray: async () => {
              order.push('find')
              return [{ _id: '1' }]
            }
          })),
          replaceOne: mock.fn(async () => { order.push('replace') }),
          createIndex: mock.fn(async () => { order.push('createIndex') })
        })),
        renameCollection: mock.fn(async () => { order.push('rename') })
      }
      const dsl = new DataMigration()
      dsl.where({ collection: 'a' }).mutate(() => {})
      dsl.setIndex('a', { x: 1 })
      dsl.renameCollection('b', 'c')
      await dsl.execute(db)

      assert.deepEqual(order, ['find', 'replace', 'createIndex', 'rename'])
    })
  })
})

// ── filterPending ────────────────────────────────────────────────────

describe('filterPending', () => {
  it('should filter out completed migrations', () => {
    const discovered = [
      { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' },
      { module: 'mod-a', version: '2.0.0', type: 'data', description: 'second' }
    ]
    const completed = [
      { module: 'mod-a', version: '1.0.0', type: 'data' }
    ]
    const pending = filterPending(discovered, completed)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].version, '2.0.0')
  })

  it('should sort by semver then module name then type', () => {
    const discovered = [
      { module: 'mod-a', version: '1.0.0', type: 'conf', description: 'conf' },
      { module: 'mod-b', version: '2.0.0', type: 'data', description: 'b2' },
      { module: 'mod-a', version: '2.0.0', type: 'data', description: 'a2' },
      { module: 'mod-a', version: '1.0.0', type: 'data', description: 'a1' }
    ]
    const pending = filterPending(discovered, [])
    assert.equal(pending[0].version, '1.0.0')
    assert.equal(pending[0].type, 'data')
    assert.equal(pending[1].version, '1.0.0')
    assert.equal(pending[1].type, 'conf')
    assert.equal(pending[2].module, 'mod-a')
    assert.equal(pending[2].version, '2.0.0')
    assert.equal(pending[3].module, 'mod-b')
  })

  it('should treat completed records without type as data', () => {
    const discovered = [
      { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' }
    ]
    const completed = [
      { module: 'mod-a', version: '1.0.0' }
    ]
    const pending = filterPending(discovered, completed)
    assert.equal(pending.length, 0)
  })

  it('should distinguish data and conf for same module+version', () => {
    const discovered = [
      { module: 'mod-a', version: '1.0.0', type: 'data', description: 'data' },
      { module: 'mod-a', version: '1.0.0', type: 'conf', description: 'conf' }
    ]
    const completed = [
      { module: 'mod-a', version: '1.0.0', type: 'data' }
    ]
    const pending = filterPending(discovered, completed)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].type, 'conf')
  })

  it('should return empty array when all are completed', () => {
    const discovered = [
      { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' }
    ]
    const completed = [
      { module: 'mod-a', version: '1.0.0', type: 'data' }
    ]
    const pending = filterPending(discovered, completed)
    assert.equal(pending.length, 0)
  })

  it('should return empty array when nothing is discovered', () => {
    const pending = filterPending([], [])
    assert.equal(pending.length, 0)
  })
})
