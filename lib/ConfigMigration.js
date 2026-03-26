class ConfigMigration {
  constructor () {
    this.description = null
    this._fn = null
  }

  describe (text) {
    this.description = text
  }

  run (fn) {
    this._fn = fn
  }

  async execute (context) {
    if (!this._fn) throw new Error('No run() function registered')
    await this._fn(context)
  }
}

export default ConfigMigration
