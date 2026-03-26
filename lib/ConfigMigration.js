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

  mutate (fn) {
    this.operations.push({ module: this._currentModule, fn })
    this._currentModule = null
    return this
  }

  execute (config) {
    for (const op of this.operations) {
      if (op.module && !(op.module in config)) continue
      op.fn(config)
    }
  }
}

export default ConfigMigration
