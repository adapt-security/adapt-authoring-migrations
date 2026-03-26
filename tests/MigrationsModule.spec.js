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
      executeConfMigration: proto.executeConfMigration,
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
      type: 'data',
      description: 'test migration',
      dsl: { execute: mock.fn() },
      ...overrides
    }
  }

  function createConfMigration (overrides) {
    return {
      module: 'mod-a',
      version: '1.0.0',
      type: 'conf',
      description: 'test config migration',
      configMigration: { execute: mock.fn() },
      rootDir: '/tmp/mod-a',
      ...overrides
    }
  }

  describe('filterPending', () => {
    it('should filter out completed migrations', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' },
        { module: 'mod-a', version: '2.0.0', type: 'data', description: 'second' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0', type: 'data' }
      ]
      const pending = inst.filterPending(discovered, completed)
      assert.equal(pending.length, 1)
      assert.equal(pending[0].version, '2.0.0')
    })

    it('should sort by semver then module name then type', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', type: 'conf', description: 'conf' },
        { module: 'mod-b', version: '2.0.0', type: 'data', description: 'b2' },
        { module: 'mod-a', version: '2.0.0', type: 'data', description: 'a2' },
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'a1' }
      ]
      const pending = inst.filterPending(discovered, [])
      assert.equal(pending[0].version, '1.0.0')
      assert.equal(pending[0].type, 'data')
      assert.equal(pending[1].version, '1.0.0')
      assert.equal(pending[1].type, 'conf')
      assert.equal(pending[2].module, 'mod-a')
      assert.equal(pending[2].version, '2.0.0')
      assert.equal(pending[3].module, 'mod-b')
    })

    it('should treat completed records without type as data', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0' }
      ]
      const pending = inst.filterPending(discovered, completed)
      assert.equal(pending.length, 0)
    })

    it('should distinguish data and conf for same module+version', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'data' },
        { module: 'mod-a', version: '1.0.0', type: 'conf', description: 'conf' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0', type: 'data' }
      ]
      const pending = inst.filterPending(discovered, completed)
      assert.equal(pending.length, 1)
      assert.equal(pending[0].type, 'conf')
    })

    it('should return empty array when all are completed', () => {
      const inst = createInstance()
      const discovered = [
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' }
      ]
      const completed = [
        { module: 'mod-a', version: '1.0.0', type: 'data' }
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

    it('should continue running after a migration failure and throw summary', async () => {
      const inst = createInstance()
      let callCount = 0
      inst.executeMigration = mock.fn(async () => {
        callCount++
        if (callCount === 1) throw new Error('boom')
      })
      inst.discoverMigrations = mock.fn(async () => [
        createMigration({ module: 'mod-a', version: '1.0.0' }),
        createMigration({ module: 'mod-b', version: '2.0.0' })
      ])

      await assert.rejects(() => inst.runMigrations(), /1 migration\(s\) failed/)
      assert.equal(inst.executeMigration.mock.callCount(), 2)
    })

    it('should log error for each failed migration', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn(async () => { throw new Error('boom') })
      inst.discoverMigrations = mock.fn(async () => [
        createMigration({ module: 'mod-a', version: '1.0.0' }),
        createMigration({ module: 'mod-b', version: '2.0.0' })
      ])

      await assert.rejects(() => inst.runMigrations(), /2 migration\(s\) failed/)
      const errorLogs = inst.log.mock.calls.filter(c => c.arguments[0] === 'error')
      assert.equal(errorLogs.length, 2)
      assert.ok(errorLogs[0].arguments[1].includes('mod-a@1.0.0 failed'))
      assert.ok(errorLogs[1].arguments[1].includes('mod-b@2.0.0 failed'))
    })

    it('should throw fatal restart error after successful conf migrations', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [
        createConfMigration({ module: 'mod-a', version: '1.0.0' })
      ])
      await assert.rejects(
        () => inst.runMigrations(),
        /Config file\(s\) modified by 1 migration\(s\). Restart required/
      )
    })

    it('should not throw restart error for conf migrations in dryRun mode', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [
        createConfMigration({ module: 'mod-a', version: '1.0.0' })
      ])
      await inst.runMigrations({ dryRun: true })
    })

    it('should not throw restart error if conf migration failed', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn(async (m) => {
        if (m.type === 'conf') throw new Error('conf failed')
      })
      inst.discoverMigrations = mock.fn(async () => [
        createConfMigration({ module: 'mod-a', version: '1.0.0' })
      ])
      await assert.rejects(
        () => inst.runMigrations(),
        /1 migration\(s\) failed/
      )
    })

    it('should skip completed check in dryRun mode', async () => {
      const inst = createInstance()
      inst.executeMigration = mock.fn()
      inst.discoverMigrations = mock.fn(async () => [createMigration()])
      inst.getCompletedMigrations = mock.fn(async () => [
        { module: 'mod-a', version: '1.0.0' }
      ])
      await inst.runMigrations({ dryRun: true })

      assert.equal(inst.getCompletedMigrations.mock.callCount(), 0)
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

    it('should route conf migrations to executeConfMigration', async () => {
      const migration = createConfMigration()
      const inst = createInstance()
      inst.executeConfMigration = mock.fn()
      await inst.executeMigration(migration, { dryRun: false })

      assert.equal(inst.executeConfMigration.mock.callCount(), 1)
      assert.equal(inst.executeConfMigration.mock.calls[0].arguments[0], migration)
    })
  })

  describe('executeConfMigration', () => {
    it('should execute the config migration and record completion', async () => {
      const migration = createConfMigration()
      const insertOneMock = mock.fn()
      const inst = createInstance({
        db: { collection: mock.fn(() => ({ insertOne: insertOneMock })) }
      })
      inst.executeConfMigration = proto.executeConfMigration
      await inst.executeConfMigration(migration, { dryRun: false })

      assert.equal(migration.configMigration.execute.mock.callCount(), 1)
      assert.equal(insertOneMock.mock.callCount(), 1)
    })

    it('should not record completion in dryRun mode', async () => {
      const migration = createConfMigration()
      const insertOneMock = mock.fn()
      const inst = createInstance({
        db: { collection: mock.fn(() => ({ insertOne: insertOneMock })) }
      })
      inst.executeConfMigration = proto.executeConfMigration
      await inst.executeConfMigration(migration, { dryRun: true })

      assert.equal(migration.configMigration.execute.mock.callCount(), 1)
      assert.equal(insertOneMock.mock.callCount(), 0)
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
    it('should return status with type for all discovered migrations', async () => {
      const completedAt = new Date('2026-01-01')
      const inst = createInstance()
      inst.discoverMigrations = mock.fn(async () => [
        { module: 'mod-a', version: '1.0.0', type: 'data', description: 'first' },
        { module: 'mod-a', version: '1.0.0', type: 'conf', description: 'config' }
      ])
      inst.getCompletedMigrations = mock.fn(async () => [
        { module: 'mod-a', version: '1.0.0', type: 'data', completedAt }
      ])
      const status = await inst.getStatus()

      assert.equal(status.length, 2)
      assert.deepEqual(status[0], {
        module: 'mod-a',
        version: '1.0.0',
        type: 'data',
        description: 'first',
        status: 'complete',
        completedAt
      })
      assert.deepEqual(status[1], {
        module: 'mod-a',
        version: '1.0.0',
        type: 'conf',
        description: 'config',
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

    it('should insert a record with type into migrations', async () => {
      const insertOneMock = mock.fn()
      const collectionMock = mock.fn(() => ({ insertOne: insertOneMock }))
      const inst = createInstance({ db: { collection: collectionMock } })
      await inst.recordCompleted({
        module: 'mod-a',
        version: '1.0.0',
        type: 'conf',
        description: 'test'
      })

      assert.equal(collectionMock.mock.calls[0].arguments[0], 'migrations')
      const doc = insertOneMock.mock.calls[0].arguments[0]
      assert.equal(doc.module, 'mod-a')
      assert.equal(doc.version, '1.0.0')
      assert.equal(doc.type, 'conf')
      assert.equal(doc.description, 'test')
      assert.ok(doc.completedAt instanceof Date)
    })
  })

  describe('resetHandler', () => {
    function createRes () {
      const res = {
        statusCode: 200,
        status: mock.fn(function (code) { res.statusCode = code; return res }),
        json: mock.fn()
      }
      return res
    }

    it('should return 400 when module is missing', async () => {
      const inst = createInstance()
      inst.resetHandler = proto.resetHandler
      const res = createRes()
      await inst.resetHandler({ body: { version: '1.0.0' } }, res, mock.fn())

      assert.equal(res.statusCode, 400)
    })

    it('should return 400 when version is missing', async () => {
      const inst = createInstance()
      inst.resetHandler = proto.resetHandler
      const res = createRes()
      await inst.resetHandler({ body: { module: 'mod-a' } }, res, mock.fn())

      assert.equal(res.statusCode, 400)
    })

    it('should return 404 when no record found', async () => {
      const deleteOneMock = mock.fn(async () => ({ deletedCount: 0 }))
      const inst = createInstance({
        db: { collection: mock.fn(() => ({ deleteOne: deleteOneMock })) }
      })
      inst.resetHandler = proto.resetHandler
      const res = createRes()
      await inst.resetHandler({ body: { module: 'mod-a', version: '1.0.0' } }, res, mock.fn())

      assert.equal(res.statusCode, 404)
    })

    it('should delete the record and return success', async () => {
      const deleteOneMock = mock.fn(async () => ({ deletedCount: 1 }))
      const collectionMock = mock.fn(() => ({ deleteOne: deleteOneMock }))
      const inst = createInstance({ db: { collection: collectionMock } })
      inst.resetHandler = proto.resetHandler
      const res = createRes()
      await inst.resetHandler({ body: { module: 'mod-a', version: '1.0.0' } }, res, mock.fn())

      assert.equal(collectionMock.mock.calls[0].arguments[0], 'migrations')
      assert.deepEqual(deleteOneMock.mock.calls[0].arguments[0], { module: 'mod-a', version: '1.0.0' })
      assert.equal(res.statusCode, 200)
    })

    it('should call next on error', async () => {
      const inst = createInstance({
        db: { collection: mock.fn(() => { throw new Error('db error') }) }
      })
      inst.resetHandler = proto.resetHandler
      const next = mock.fn()
      await inst.resetHandler({ body: { module: 'mod-a', version: '1.0.0' } }, createRes(), next)

      assert.equal(next.mock.callCount(), 1)
      assert.equal(next.mock.calls[0].arguments[0].message, 'db error')
    })
  })
})
