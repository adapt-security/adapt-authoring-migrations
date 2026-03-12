import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import createReadOnlyDb from '../lib/createReadOnlyDb.js'

function createMockDb () {
  const collectionMethods = {
    insertOne: mock.fn(),
    insertMany: mock.fn(),
    updateOne: mock.fn(),
    updateMany: mock.fn(),
    replaceOne: mock.fn(),
    deleteOne: mock.fn(),
    deleteMany: mock.fn(),
    drop: mock.fn(),
    find: mock.fn(() => ({ toArray: async () => [{ _id: '1' }] })),
    findOne: mock.fn(async () => ({ _id: '1' })),
    countDocuments: mock.fn(async () => 5),
    distinct: mock.fn(async () => ['a', 'b'])
  }
  return {
    collection: mock.fn(() => collectionMethods),
    renameCollection: mock.fn(),
    dropCollection: mock.fn(),
    createCollection: mock.fn(),
    _collectionMethods: collectionMethods
  }
}

describe('createReadOnlyDb', () => {
  describe('collection write methods', () => {
    const writeMethods = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'drop']

    for (const method of writeMethods) {
      it(`should intercept ${method} and not call the real method`, async () => {
        const db = createMockDb()
        const logMock = mock.fn()
        const readOnly = createReadOnlyDb(db, logMock)

        await readOnly.collection('content')[method]({ _id: '1' })

        assert.equal(db._collectionMethods[method].mock.callCount(), 0)
        assert.equal(logMock.mock.callCount(), 1)
        assert.ok(logMock.mock.calls[0].arguments[1].includes(`content.${method}`))
      })
    }
  })

  describe('collection read methods', () => {
    it('should pass through find()', async () => {
      const db = createMockDb()
      const readOnly = createReadOnlyDb(db, mock.fn())

      const result = await readOnly.collection('content').find({ _type: 'course' }).toArray()

      assert.deepEqual(result, [{ _id: '1' }])
    })

    it('should pass through findOne()', async () => {
      const db = createMockDb()
      const readOnly = createReadOnlyDb(db, mock.fn())

      const result = await readOnly.collection('content').findOne({ _id: '1' })

      assert.deepEqual(result, { _id: '1' })
    })

    it('should pass through countDocuments()', async () => {
      const db = createMockDb()
      const readOnly = createReadOnlyDb(db, mock.fn())

      const result = await readOnly.collection('content').countDocuments({})

      assert.equal(result, 5)
    })

    it('should pass through distinct()', async () => {
      const db = createMockDb()
      const readOnly = createReadOnlyDb(db, mock.fn())

      const result = await readOnly.collection('content').distinct('_lang')

      assert.deepEqual(result, ['a', 'b'])
    })
  })

  describe('db-level write methods', () => {
    for (const method of ['renameCollection', 'dropCollection', 'createCollection']) {
      it(`should intercept db.${method} and not call the real method`, () => {
        const db = createMockDb()
        const logMock = mock.fn()
        const readOnly = createReadOnlyDb(db, logMock)

        readOnly[method]('old', 'new')

        assert.equal(db[method].mock.callCount(), 0)
        assert.equal(logMock.mock.callCount(), 1)
        assert.ok(logMock.mock.calls[0].arguments[1].includes(`db.${method}`))
      })
    }
  })

  it('should work without a log function', () => {
    const db = createMockDb()
    const readOnly = createReadOnlyDb(db)

    assert.doesNotThrow(() => {
      readOnly.collection('test').insertOne({ x: 1 })
      readOnly.renameCollection('a', 'b')
    })
  })
})
