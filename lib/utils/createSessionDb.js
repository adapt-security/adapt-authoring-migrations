function createSessionDb (db, session) {
  return new Proxy(db, {
    get (target, prop) {
      if (prop === 'collection') {
        return (name) => createSessionCollection(target.collection(name), session)
      }
      if (typeof target[prop] === 'function') {
        return (...args) => target[prop](...injectSession(args, session))
      }
      return target[prop]
    }
  })
}

function createSessionCollection (collection, session) {
  return new Proxy(collection, {
    get (target, prop) {
      if (typeof target[prop] === 'function') {
        return (...args) => target[prop](...injectSession(args, session))
      }
      return target[prop]
    }
  })
}

function injectSession (args, session) {
  args.push({ session })
  return args
}

export default createSessionDb
