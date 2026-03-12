import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import MigrationDSL from '../lib/MigrationDSL.js'
import MigrationsModule from '../lib/MigrationsModule.js'

// ── MigrationDSL ────────────────────────────────────────────────────

describe('MigrationDSL', () => {
  describe('describe', () => {
    it('should set the description', () => {
      const dsl = new MigrationDSL()
      dsl.describe('test migration')
      assert.equal(dsl.description, 'test migration')
    })
  })

  describe('where + mutate', () => {
    it('should record a mutate operation with the query', () => {
      const dsl = new MigrationDSL()
      const fn = () => {}
      dsl.where({ collection: 'users', active: true }).mutate(fn)
      assert.equal(dsl.operations.length, 1)
      assert.equal(dsl.operations[0].type, 'mutate')
      assert.deepEqual(dsl.operations[0].query, { collection: 'users', active: true })
      assert.equal(dsl.operations[0].fn, fn)
    })

    it('should clear _currentQuery after mutate', () => {
      const dsl = new MigrationDSL()
      dsl.where({ collection: 'x' }).mutate(() => {})
      assert.equal(dsl._currentQuery, null)
    })
  })

  describe('where + check', () => {
    it('should record a check operation with the query', () => {
      const dsl = new MigrationDSL()
      const fn = () => {}
      dsl.where({ collection: 'items', status: 'active' }).check(fn)
      assert.equal(dsl.operations.length, 1)
      assert.equal(dsl.operations[0].type, 'check')
      assert.deepEqual(dsl.operations[0].query, { collection: 'items', status: 'active' })
    })
  })

  describe('setIndex', () => {
    it('should record a setIndex operation', () => {
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
      dsl.setIndex('logs', { createdAt: -1 })
      assert.equal(dsl.operations[0].options, undefined)
    })
  })

  describe('dropIndex', () => {
    it('should record a dropIndex operation', () => {
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
      dsl.runCommand(fn)
      assert.equal(dsl.operations[0].type, 'runCommand')
      assert.equal(dsl.operations[0].fn, fn)
    })
  })

  describe('chaining', () => {
    it('should support chaining multiple operations', () => {
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
      dsl.setIndex('users', { email: 1 })
      await dsl.execute(db)

      assert.deepEqual(createIndexMock.mock.calls[0].arguments[1], {})
    })

    it('should call dropIndex for dropIndex', async () => {
      const dropIndexMock = mock.fn()
      const db = {
        collection: mock.fn(() => ({ dropIndex: dropIndexMock }))
      }
      const dsl = new MigrationDSL()
      dsl.dropIndex('users', 'email_1')
      await dsl.execute(db)

      assert.equal(dropIndexMock.mock.calls[0].arguments[0], 'email_1')
    })

    it('should call db.renameCollection for renameCollection', async () => {
      const db = { renameCollection: mock.fn() }
      const dsl = new MigrationDSL()
      dsl.renameCollection('old', 'new')
      await dsl.execute(db)

      assert.deepEqual(db.renameCollection.mock.calls[0].arguments, ['old', 'new'])
    })

    it('should call fn(db) for runCommand', async () => {
      const commandFn = mock.fn()
      const db = {}
      const dsl = new MigrationDSL()
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
      const dsl = new MigrationDSL()
      dsl.where({ collection: 'a' }).mutate(() => {})
      dsl.setIndex('a', { x: 1 })
      dsl.renameCollection('b', 'c')
      await dsl.execute(db)

      assert.deepEqual(order, ['find', 'replace', 'createIndex', 'rename'])
    })
  })
})

// ── MigrationsModule ────────────────────────────────────────────────

describe('MigrationsModule', () => {
  const proto = MigrationsModule.prototype

  function createInstance (overrides) {
    const inst = {
      db: {
        collection: mock.fn(() => ({
          find: mock.fn(() => ({ toArray: async () => [] })),
          insertOne: mock.fn()
        }))
      },
      log: mock.fn(),
      useTransactions: false,
      runMigrations: proto.runMigrations,
      executeMigration: proto.executeMigration,
      executeWithTransaction: proto.executeWithTransaction,
      executeWithProxy: proto.executeWithProxy,
      filterPending: proto.filterPending,
      getCompletedMigrations: proto.getCompletedMigrations,
      getStatus: proto.getStatus,
      recordCompleted: proto.recordCompleted,
      ...overrides
    }
    return inst
  }

  function createMigration (overrides) {
    return {
      module: 'mod-a',
      version: '1.0.0',
      description: 'test migration',
      dsl: { execute: mock.fn() },
      ...overrides
    }
  }

  describe('filterPending', () => {
    it('should filter out completed migrations', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', description: 'first' },
        { module: 'mod-a', version: '2.0.0', description: 'second' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0' }
      ]
      const pending = inst.filterPending(discovered, completed)
      assert.equal(pending.length, 1)
      assert.equal(pending[0].version, '2.0.0')
    })

    it('should sort by semver then module name', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-b', version: '2.0.0', description: 'b2' },
        { module: 'mod-a', version: '2.0.0', description: 'a2' },
        { module: 'mod-a', version: '1.0.0', description: 'a1' }
      ]
      const pending = inst.filterPending(discovered, [])
      assert.equal(pending[0].version, '1.0.0')
      assert.equal(pending[1].module, 'mod-a')
      assert.equal(pending[1].version, '2.0.0')
      assert.equal(pending[2].module, 'mod-b')
      assert.equal(pending[2].version, '2.0.0')
    })

    it('should return empty array when all are completed', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', description: 'first' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0' }
      ]
      const pending = inst.filterPending(discovered, completed)
      assert.equal(pending.length, 0)
    })

    it('should return empty array when nothing is discovered', () => {
      const inst = createInstance()
      const pending = inst.filterPending([], [])
      assert.equal(pending.length, 0)
    })
  })

  describe('runMigrations', () => {
    it('should log "no pending migrations" when none are pending', async () => {
      const inst = createInstance()
      inst.discoverMigrations = mock.fn(async () => [])
      await inst.runMigrations()

      assert.equal(inst.log.mock.callCount(), 1)
      assert.equal(inst.log.mock.calls[0].arguments[0], 'info')
      assert.ok(inst.log.mock.calls[0].arguments[1].includes('no pending'))
    })

    it('should call executeMigration for each pending migration', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [
        createMigration({ version: '1.0.0' }),
        createMigration({ version: '2.0.0' })
      ])
      await inst.runMigrations()

      assert.equal(inst.executeMigration.mock.callCount(), 2)
    })

    it('should pass dryRun option to executeMigration', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [createMigration()])
      await inst.runMigrations({ dryRun: true })

      assert.deepEqual(inst.executeMigration.mock.calls[0].arguments[1], { dryRun: true })
    })

    it('should log execution mode', async () => {
      const inst = createInstance({ useTransactions: true })
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [createMigration()])
      await inst.runMigrations()

      const infoLogs = inst.log.mock.calls.filter(c => c.arguments[0] === 'info')
      assert.ok(infoLogs.some(c => c.arguments[1].includes('(transactions)')))
    })

    it('should log read-only proxy mode when dryRun without transactions', async () => {
      const inst = createInstance({ useTransactions: false })
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [createMigration()])
      await inst.runMigrations({ dryRun: true })

      const infoLogs = inst.log.mock.calls.filter(c => c.arguments[0] === 'info')
      assert.ok(infoLogs.some(c => c.arguments[1].includes('(read-only proxy)')))
    })

    it('should stop on migration failure', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn(async () => { throw new Error('boom') })
      inst.discoverMigrations = mock.fn(async () => [
        createMigration({ version: '1.0.0' }),
        createMigration({ version: '2.0.0' })
      ])

      await assert.rejects(() => inst.runMigrations(), { message: 'boom' })
      assert.equal(inst.executeMigration.mock.callCount(), 1)
    })
  })

  describe('executeMigration', () => {
    it('should execute directly and record when no transaction and no dryRun', async () => {
      const migration = createMigration()
      const insertOneMock = mock.fn()
      const inst = createInstance({
        useTransactions: false,
        db: {
          collection: mock.fn(() => ({
            find: mock.fn(() => ({ toArray: async () => [] })),
            insertOne: insertOneMock
          }))
        }
      })
      await inst.executeMigration(migration)

      assert.equal(migration.dsl.execute.mock.callCount(), 1)
      assert.equal(migration.dsl.execute.mock.calls[0].arguments[0], inst.db)
      assert.equal(insertOneMock.mock.callCount(), 1)
    })

    it('should use transaction when useTransactions is true', async () => {
      const migration = createMigration()
      const inst = createInstance({ useTransactions: true })
      inst.executeWithTransaction = mock.fn()
      await inst.executeMigration(migration)

      assert.equal(inst.executeWithTransaction.mock.callCount(), 1)
    })

    it('should use proxy when dryRun is true and no transactions', async () => {
      const migration = createMigration()
      const inst = createInstance({ useTransactions: false })
      inst.executeWithProxy = mock.fn()
      await inst.executeMigration(migration, { dryRun: true })

      assert.equal(inst.executeWithProxy.mock.callCount(), 1)
    })
  })

  describe('executeWithTransaction', () => {
    function createMockSession () {
      return {
        startTransaction: mock.fn(),
        commitTransaction: mock.fn(),
        abortTransaction: mock.fn(),
        endSession: mock.fn()
      }
    }

    it('should commit transaction on success', async () => {
      const session = createMockSession()
      const migration = createMigration()
      const inst = createInstance({
        client: { startSession: mock.fn(() => session) }
      })
      await inst.executeWithTransaction(migration, { dryRun: false })

      assert.equal(session.startTransaction.mock.callCount(), 1)
      assert.equal(session.commitTransaction.mock.callCount(), 1)
      assert.equal(session.abortTransaction.mock.callCount(), 0)
      assert.equal(session.endSession.mock.callCount(), 1)
    })

    it('should abort transaction on dryRun', async () => {
      const session = createMockSession()
      const migration = createMigration()
      const inst = createInstance({
        client: { startSession: mock.fn(() => session) }
      })
      await inst.executeWithTransaction(migration, { dryRun: true })

      assert.equal(session.abortTransaction.mock.callCount(), 1)
      assert.equal(session.commitTransaction.mock.callCount(), 0)
      assert.equal(session.endSession.mock.callCount(), 1)
    })

    it('should abort transaction and rethrow on error', async () => {
      const session = createMockSession()
      const migration = createMigration({
        dsl: { execute: mock.fn(async () => { throw new Error('fail') }) }
      })
      const inst = createInstance({
        client: { startSession: mock.fn(() => session) }
      })

      await assert.rejects(
        () => inst.executeWithTransaction(migration, { dryRun: false }),
        { message: 'fail' }
      )
      assert.equal(session.abortTransaction.mock.callCount(), 1)
      assert.equal(session.commitTransaction.mock.callCount(), 0)
      assert.equal(session.endSession.mock.callCount(), 1)
    })

    it('should record completed after commit', async () => {
      const session = createMockSession()
      const insertOneMock = mock.fn()
      const migration = createMigration()
      const inst = createInstance({
        client: { startSession: mock.fn(() => session) },
        db: {
          collection: mock.fn(() => ({
            find: mock.fn(() => ({ toArray: async () => [] })),
            insertOne: insertOneMock
          }))
        }
      })
      await inst.executeWithTransaction(migration, { dryRun: false })

      assert.equal(insertOneMock.mock.callCount(), 1)
    })

    it('should not record completed on dryRun', async () => {
      const session = createMockSession()
      const insertOneMock = mock.fn()
      const migration = createMigration()
      const inst = createInstance({
        client: { startSession: mock.fn(() => session) },
        db: {
          collection: mock.fn(() => ({
            find: mock.fn(() => ({ toArray: async () => [] })),
            insertOne: insertOneMock
          }))
        }
      })
      await inst.executeWithTransaction(migration, { dryRun: true })

      assert.equal(insertOneMock.mock.callCount(), 0)
    })
  })

  describe('executeWithProxy', () => {
    it('should execute with a read-only db', async () => {
      const insertOneMock = mock.fn()
      const migration = createMigration({
        dsl: {
          execute: mock.fn(async (db) => {
            await db.collection('test').insertOne({ x: 1 })
          })
        }
      })
      const inst = createInstance({
        db: {
          collection: mock.fn(() => ({
            insertOne: insertOneMock,
            find: mock.fn(() => ({ toArray: async () => [] }))
          }))
        }
      })
      await inst.executeWithProxy(migration)

      assert.equal(insertOneMock.mock.callCount(), 0)
    })

    it('should not record completed', async () => {
      const insertOneMock = mock.fn()
      const migration = createMigration()
      const inst = createInstance({
        db: {
          collection: mock.fn(() => ({
            find: mock.fn(() => ({ toArray: async () => [] })),
            insertOne: insertOneMock
          }))
        }
      })
      await inst.executeWithProxy(migration)

      assert.equal(insertOneMock.mock.callCount(), 0)
    })
  })

  describe('getStatus', () => {
    it('should return status for all discovered migrations', async () => {
      const completedAt = new Date('2026-01-01')
      const inst = createInstance()
      inst.discoverMigrations = mock.fn(async () => [
        { module: 'mod-a', version: '1.0.0', description: 'first' },
        { module: 'mod-a', version: '2.0.0', description: 'second' }
      ])
      inst.getCompletedMigrations = mock.fn(async () => [
        { module: 'mod-a', version: '1.0.0', completedAt }
      ])
      const status = await inst.getStatus()

      assert.equal(status.length, 2)
      assert.deepEqual(status[0], {
        module: 'mod-a',
        version: '1.0.0',
        description: 'first',
        status: 'complete',
        completedAt
      })
      assert.deepEqual(status[1], {
        module: 'mod-a',
        version: '2.0.0',
        description: 'second',
        status: 'pending',
        completedAt: null
      })
    })

    it('should return empty array when no migrations exist', async () => {
      const inst = createInstance()
      inst.discoverMigrations = mock.fn(async () => [])
      inst.getCompletedMigrations = mock.fn(async () => [])
      const status = await inst.getStatus()

      assert.deepEqual(status, [])
    })
  })

  describe('recordCompleted', () => {
    it('should query the migrations collection', async () => {
      const docs = [{ module: 'mod-a', version: '1.0.0' }]
      const collectionMock = mock.fn(() => ({
        find: mock.fn(() => ({ toArray: async () => docs }))
      }))
      const inst = createInstance({ db: { collection: collectionMock } })
      const result = await inst.getCompletedMigrations()

      assert.equal(collectionMock.mock.calls[0].arguments[0], 'migrations')
      assert.deepEqual(result, docs)
    })

    it('should insert a record into migrations', async () => {
      const insertOneMock = mock.fn()
      const collectionMock = mock.fn(() => ({ insertOne: insertOneMock }))
      const inst = createInstance({ db: { collection: collectionMock } })
      await inst.recordCompleted({
        module: 'mod-a',
        version: '1.0.0',
        description: 'test'
      })

      assert.equal(collectionMock.mock.calls[0].arguments[0], 'migrations')
      const doc = insertOneMock.mock.calls[0].arguments[0]
      assert.equal(doc.module, 'mod-a')
      assert.equal(doc.version, '1.0.0')
      assert.equal(doc.description, 'test')
      assert.ok(doc.completedAt instanceof Date)
    })
  })
})
