const WRITE_METHODS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'drop']
const DB_WRITE_METHODS = ['renameCollection', 'dropCollection', 'createCollection']

function createReadOnlyDb (db, log) {
  return new Proxy(db, {
    get (target, prop) {
      if (DB_WRITE_METHODS.includes(prop)) {
        return (...args) => {
          log?.('info', `[DRY RUN] db.${prop}(${args.map(a => JSON.stringify(a)).join(', ')})`)
        }
      }
      if (prop === 'collection') {
        return (name) => createReadOnlyCollection(target.collection(name), name, log)
      }
      return target[prop]
    }
  })
}

function createReadOnlyCollection (collection, name, log) {
  return new Proxy(collection, {
    get (target, prop) {
      if (WRITE_METHODS.includes(prop)) {
        return (...args) => {
          log?.('info', `[DRY RUN] ${name}.${prop}(${args.map(a => JSON.stringify(a)).join(', ')})`)
        }
      }
      return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop]
    }
  })
}

export default createReadOnlyDb
