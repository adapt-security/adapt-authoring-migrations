import createReadOnlyDb from './createReadOnlyDb.js'

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

  async execute (db, options = {}) {
    const { dryRun, log } = options
    for (const op of this.operations) {
      if (dryRun && ['setIndex', 'dropIndex', 'renameCollection'].includes(op.type)) {
        if (op.type === 'setIndex') log?.('info', `[DRY RUN] would create index on ${op.collection}: ${JSON.stringify(op.spec)}`)
        if (op.type === 'dropIndex') log?.('info', `[DRY RUN] would drop index ${op.name} on ${op.collection}`)
        if (op.type === 'renameCollection') log?.('info', `[DRY RUN] would rename collection ${op.from} → ${op.to}`)
        continue
      }
      switch (op.type) {
        case 'mutate': {
          const { collection, ...filter } = op.query
          const docs = await db.collection(collection).find(filter).toArray()
          if (dryRun) {
            log?.('info', `[DRY RUN] would mutate ${docs.length} doc(s) in ${collection}`)
          }
          for (const doc of docs) {
            op.fn(doc)
            if (!dryRun) {
              await db.collection(collection).replaceOne({ _id: doc._id }, doc)
            }
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
          await op.fn(dryRun ? createReadOnlyDb(db, log) : db, options)
          break
      }
    }
  }
}

export default MigrationDSL
