import path from 'path'
import semver from 'semver'
import { AbstractModule, loadDependencyFiles } from 'adapt-authoring-core'
import MigrationDSL from './MigrationDSL.js'
import createReadOnlyDb from './createReadOnlyDb.js'
import createSessionDb from './createSessionDb.js'

class MigrationsModule extends AbstractModule {
  /** @override */
  async init () {
    const mongodb = await this.app.waitForModule('mongodb')
    this.client = mongodb.client
    this.db = this.client.db()
    this.useTransactions = await this.supportsTransactions()
    const dryRun = process.env.MIGRATE_DRY_RUN === 'true'
    await this.runMigrations({ dryRun })
  }

  async supportsTransactions () {
    try {
      const admin = this.db.admin()
      const { hosts } = await admin.command({ hello: 1 })
      return hosts?.length > 0
    } catch {
      return false
    }
  }

  async runMigrations (options = {}) {
    const { dryRun } = options
    const discovered = await this.discoverMigrations()
    const completed = await this.getCompletedMigrations()
    const pending = this.filterPending(discovered, completed)

    if (!pending.length) {
      this.log('info', 'no pending migrations')
      return
    }
    const prefix = dryRun ? '[DRY RUN] ' : ''
    this.log('info', `${prefix}running ${pending.length} pending migration(s)`)

    if (dryRun && !this.useTransactions) {
      this.log('warn', 'transactions not supported, using read-only proxy for dry run')
    }

    for (const m of pending) {
      this.log('info', `${prefix}running ${m.module}@${m.version}: ${m.description}`)
      await this.executeMigration(m, options)
    }
  }

  async executeMigration (migration, options = {}) {
    const { dryRun } = options
    if (this.useTransactions) {
      return this.executeWithTransaction(migration, { dryRun })
    }
    if (dryRun) {
      return this.executeWithProxy(migration)
    }
    await migration.dsl.execute(this.db)
    await this.recordCompleted(migration)
  }

  async executeWithTransaction (migration, { dryRun }) {
    const session = this.client.startSession()
    try {
      session.startTransaction()
      const sessionDb = createSessionDb(this.db, session)
      await migration.dsl.execute(sessionDb)
      if (dryRun) {
        await session.abortTransaction()
        this.log('info', '[DRY RUN] transaction aborted, no changes persisted')
      } else {
        await session.commitTransaction()
        await this.recordCompleted(migration)
      }
    } catch (error) {
      await session.abortTransaction()
      throw error
    } finally {
      await session.endSession()
    }
  }

  async executeWithProxy (migration) {
    const log = (...args) => this.log(...args)
    const readOnlyDb = createReadOnlyDb(this.db, log)
    await migration.dsl.execute(readOnlyDb)
  }

  async discoverMigrations () {
    const fileMap = await loadDependencyFiles('migrations/*.js')
    const migrations = []
    for (const [moduleName, files] of Object.entries(fileMap)) {
      for (const filePath of files) {
        const version = path.basename(filePath, '.js')
        if (!semver.valid(version)) {
          this.log('warn', `skipping invalid migration filename: ${filePath}`)
          continue
        }
        const dsl = new MigrationDSL()
        const { default: defineFn } = await import(filePath)
        defineFn(dsl)
        if (!dsl.description) {
          this.log('warn', `skipping migration without describe(): ${filePath}`)
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
    return this.db.collection('migrations').find().toArray()
  }

  async recordCompleted (migration) {
    await this.db.collection('migrations').insertOne({
      module: migration.module,
      version: migration.version,
      description: migration.description,
      completedAt: new Date()
    })
  }
}

export default MigrationsModule
