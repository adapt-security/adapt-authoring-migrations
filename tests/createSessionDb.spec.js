import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import createSessionDb from '../lib/createSessionDb.js'

describe('createSessionDb', () => {
  const session = { id: 'test-session' }

  function createMockDb () {
    const collectionMethods = {
      insertOne: mock.fn(),
      find: mock.fn(() => ({ toArray: async () => [{ _id: '1' }] })),
      updateMany: mock.fn(),
      replaceOne: mock.fn(),
      distinct: mock.fn(async () => ['a'])
    }
    return {
      collection: mock.fn(() => collectionMethods),
      renameCollection: mock.fn(),
      _collectionMethods: collectionMethods
    }
  }

  it('should append session to collection method args', async () => {
    const db = createMockDb()
    const sessionDb = createSessionDb(db, session)

    await sessionDb.collection('test').insertOne({ x: 1 })

    const args = db._collectionMethods.insertOne.mock.calls[0].arguments
    assert.deepEqual(args[0], { x: 1 })
    assert.deepEqual(args[1], { session })
  })

  it('should append session to db-level methods', async () => {
    const db = createMockDb()
    const sessionDb = createSessionDb(db, session)

    await sessionDb.renameCollection('old', 'new')

    const args = db.renameCollection.mock.calls[0].arguments
    assert.equal(args[0], 'old')
    assert.equal(args[1], 'new')
    assert.deepEqual(args[2], { session })
  })

  it('should append session to find()', async () => {
    const db = createMockDb()
    const sessionDb = createSessionDb(db, session)

    await sessionDb.collection('test').find({ active: true })

    const args = db._collectionMethods.find.mock.calls[0].arguments
    assert.deepEqual(args[0], { active: true })
    assert.deepEqual(args[1], { session })
  })

  it('should append session to methods with no arguments', async () => {
    const db = createMockDb()
    const sessionDb = createSessionDb(db, session)

    await sessionDb.collection('test').distinct('_lang')

    const args = db._collectionMethods.distinct.mock.calls[0].arguments
    assert.equal(args[0], '_lang')
    assert.deepEqual(args[1], { session })
  })
})
