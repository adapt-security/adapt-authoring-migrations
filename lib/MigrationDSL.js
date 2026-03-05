class MigrationDSL {
  constructor () {
    this.description = null
    this.operations = []
    this._currentQuery = null
  }

  describe (text) {
    this.description = text
  }

  where (query) {
    this._currentQuery = query
    return this
  }

  mutate (fn) {
    this.operations.push({ type: 'mutate', query: this._currentQuery, fn })
    this._currentQuery = null
    return this
  }

  check (fn) {
    this.operations.push({ type: 'check', query: this._currentQuery, fn })
    this._currentQuery = null
    return this
  }

  setIndex (collection, spec, options) {
    this.operations.push({ type: 'setIndex', collection, spec, options })
    return this
  }

  dropIndex (collection, name) {
    this.operations.push({ type: 'dropIndex', collection, name })
    return this
  }

  renameCollection (from, to) {
    this.operations.push({ type: 'renameCollection', from, to })
    return this
  }

  runCommand (fn) {
    this.operations.push({ type: 'runCommand', fn })
    return this
  }

  async execute (db) {
    for (const op of this.operations) {
      switch (op.type) {
        case 'mutate': {
          const { collection, ...filter } = op.query
          const docs = await db.collection(collection).find(filter).toArray()
          for (const doc of docs) {
            op.fn(doc)
            await db.collection(collection).replaceOne({ _id: doc._id }, doc)
          }
          break
        }
        case 'check': {
          const { collection, ...filter } = op.query
          const docs = await db.collection(collection).find(filter).toArray()
          for (const doc of docs) op.fn(doc)
          break
        }
        case 'setIndex':
          await db.collection(op.collection).createIndex(op.spec, op.options || {})
          break
        case 'dropIndex':
          await db.collection(op.collection).dropIndex(op.name)
          break
        case 'renameCollection':
          await db.renameCollection(op.from, op.to)
          break
        case 'runCommand':
          await op.fn(db)
          break
      }
    }
  }
}

export default MigrationDSL
