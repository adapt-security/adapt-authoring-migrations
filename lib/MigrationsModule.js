import { AbstractModule } from 'adapt-authoring-core'
import MigrationRunner from './MigrationRunner.js'

class MigrationsModule extends AbstractModule {
  /** @override */
  async init () {
    const mongodb = await this.app.waitForModule('mongodb')
    this.db = mongodb.client.db()
    this.runner = new MigrationRunner(this)
    await this.runner.run()
  }
}

export default MigrationsModule
