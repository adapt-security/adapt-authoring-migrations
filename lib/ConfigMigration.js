class ConfigMigration {
  constructor () {
    this.description = null
    this.operations = []
    this._currentModule = null
  }

  describe (text) {
    this.description = text
  }

  where (moduleName) {
    this._currentModule = moduleName
    return this
  }

  replace (key, destModule, destKey) {
    this.operations.push({
      type: 'replace',
      module: this._currentModule,
      key,
      destModule,
      destKey: destKey || key
    })
    return this
  }

  remove (...keys) {
    for (const key of keys) {
      this.operations.push({
        type: 'remove',
        module: this._currentModule,
        key
      })
    }
    return this
  }

  mutate (fn) {
    this.operations.push({ type: 'mutate', module: this._currentModule, fn })
    this._currentModule = null
    return this
  }

  execute (config) {
    const touched = new Set()
    for (const op of this.operations) {
      if (op.module && !(op.module in config)) continue
      switch (op.type) {
        case 'replace': {
          if (!(op.key in config[op.module])) break
          config[op.destModule] ||= {}
          config[op.destModule][op.destKey] = config[op.module][op.key]
          delete config[op.module][op.key]
          touched.add(op.module)
          break
        }
        case 'remove': {
          delete config[op.module]?.[op.key]
          touched.add(op.module)
          break
        }
        case 'mutate': {
          op.fn(config)
          this._currentModule = null
          break
        }
      }
    }
    for (const mod of touched) {
      if (config[mod] && !Object.keys(config[mod]).length) {
        delete config[mod]
      }
    }
  }
}

export default ConfigMigration
