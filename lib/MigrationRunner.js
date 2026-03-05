import path from 'path'
import semver from 'semver'
import { loadDependencyFiles } from 'adapt-authoring-core'
import MigrationDSL from './MigrationDSL.js'

class MigrationRunner {
  constructor (module) {
    this.module = module
    this.db = module.db
  }

  async run () {
    const discovered = await this.discoverMigrations()
    const completed = await this.getCompletedMigrations()
    const pending = this.filterPending(discovered, completed)

    if (!pending.length) {
      this.module.log('info', 'no pending migrations')
      return
    }
    this.module.log('info', `running ${pending.length} pending migration(s)`)

    for (const m of pending) {
      this.module.log('info', `running ${m.module}@${m.version}: ${m.description}`)
      await m.dsl.execute(this.db)
      await this.recordCompleted(m)
    }
  }

  async discoverMigrations () {
    const fileMap = await loadDependencyFiles('migrations/*.js')
    const migrations = []
    for (const [moduleName, files] of Object.entries(fileMap)) {
      for (const filePath of files) {
        const version = path.basename(filePath, '.js')
        if (!semver.valid(version)) {
          this.module.log('warn', `skipping invalid migration filename: ${filePath}`)
          continue
        }
        const dsl = new MigrationDSL()
        const { default: defineFn } = await import(filePath)
        defineFn(dsl)
        if (!dsl.description) {
          this.module.log('warn', `skipping migration without describe(): ${filePath}`)
          continue
        }
        migrations.push({ module: moduleName, version, description: dsl.description, dsl })
      }
    }
    return migrations
  }

  filterPending (discovered, completed) {
    const completedSet = new Set(completed.map(c => `${c.module}@${c.version}`))
    return discovered
      .filter(m => !completedSet.has(`${m.module}@${m.version}`))
      .sort((a, b) => semver.compare(a.version, b.version) || a.module.localeCompare(b.module))
  }

  async getCompletedMigrations () {
    return this.db.collection('_migrations').find().toArray()
  }

  async recordCompleted (migration) {
    await this.db.collection('_migrations').insertOne({
      module: migration.module,
      version: migration.version,
      description: migration.description,
      completedAt: new Date()
    })
  }
}

export default MigrationRunner
