import semver from 'semver'
import { AbstractModule, loadDependencyFiles } from 'adapt-authoring-core'
import { loadRouteConfig, registerRoutes } from 'adapt-authoring-server'
import MigrationDSL from './MigrationDSL.js'
import ConfigMigration from './ConfigMigration.js'
import { createConfigContext, createReadOnlyDb, createSessionDb, parseFilename } from './utils.js'

class MigrationsModule extends AbstractModule {
  /** @override */
  async init () {
    const [mongodb, auth, server] = await this.app.waitForModule('mongodb', 'auth', 'server')
    this.client = mongodb.client
    this.db = this.client.db()
    this.useTransactions = await this.supportsTransactions()

    const config = await loadRouteConfig(this.rootDir, this)
    const router = server.api.createChildRouter(config.root)
    registerRoutes(router, config.routes, auth)

    const dryRun = this.getConfig('dryRun')
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
    const completed = dryRun ? [] : await this.getCompletedMigrations()
    const pending = this.filterPending(discovered, completed)

    if (!pending.length) {
      this.log('info', 'no pending migrations')
      return
    }
    const prefix = dryRun ? '[DRY RUN] ' : ''
    const mode = this.useTransactions ? 'transactions' : (dryRun ? 'read-only proxy' : 'no transactions')
    this.log('info', `${prefix}running ${pending.length} pending migration(s) (${mode})`)

    const errors = []
    let confMigrationsRan = 0
    for (const m of pending) {
      this.log('info', `${prefix}running ${m.module}@${m.version} [${m.type}]: ${m.description}`)
      try {
        await this.executeMigration(m, options)
        if (m.type === 'conf' && !dryRun) confMigrationsRan++
      } catch (error) {
        this.log('error', `${prefix}${m.module}@${m.version} failed: ${error.message}`)
        errors.push({ module: m.module, version: m.version, error })
      }
    }
    if (errors.length) {
      const msg = `${errors.length} migration(s) failed: ${errors.map(e => `${e.module}@${e.version}`).join(', ')}`
      throw new Error(msg)
    }
    if (confMigrationsRan > 0) {
      throw new Error(`Config file(s) modified by ${confMigrationsRan} migration(s). Restart required to load updated configuration.`)
    }
  }

  async executeMigration (migration, options = {}) {
    const { dryRun } = options
    if (migration.type === 'conf') {
      return this.executeConfMigration(migration, { dryRun })
    }
    if (this.useTransactions) {
      return this.executeWithTransaction(migration, { dryRun })
    }
    if (dryRun) {
      return this.executeWithProxy(migration)
    }
    await migration.dsl.execute(this.db)
    await this.recordCompleted(migration)
  }

  async executeConfMigration (migration, { dryRun }) {
    const log = (...args) => this.log(...args)
    const context = createConfigContext(migration.rootDir, { dryRun, log })
    await migration.configMigration.execute(context)
    if (!dryRun) {
      await this.recordCompleted(migration)
    }
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

  async statusHandler (req, res, next) {
    try {
      res.json(await this.getStatus())
    } catch (e) {
      next(e)
    }
  }

  async resetHandler (req, res, next) {
    try {
      const { module, version, type } = req.body
      if (!module || !version) {
        res.status(400).json({ error: 'module and version are required' })
        return
      }
      const query = { module, version }
      if (type) query.type = type
      const { deletedCount } = await this.db.collection('migrations').deleteOne(query)
      if (!deletedCount) {
        res.status(404).json({ error: `no completion record found for ${module}@${version}` })
        return
      }
      res.json({ message: `reset ${module}@${version}, migration will re-run on next start` })
    } catch (e) {
      next(e)
    }
  }

  async getStatus () {
    const discovered = await this.discoverMigrations()
    const completed = await this.getCompletedMigrations()
    const completedMap = new Map(completed.map(c => [migrationKey(c), c]))
    return discovered.map(m => {
      const record = completedMap.get(migrationKey(m))
      return {
        module: m.module,
        version: m.version,
        type: m.type,
        description: m.description,
        status: record ? 'complete' : 'pending',
        completedAt: record?.completedAt ?? null
      }
    })
  }

  async discoverMigrations () {
    const fileMap = await loadDependencyFiles('migrations/*.js')
    const migrations = []
    for (const [moduleName, files] of Object.entries(fileMap)) {
      for (const filePath of files) {
        const parsed = parseFilename(filePath)
        if (!parsed) {
          this.log('warn', `skipping invalid migration filename: ${filePath}`)
          continue
        }
        const { version, type } = parsed
        const { default: defineFn } = await import(filePath)

        if (type === 'conf') {
          const configMigration = new ConfigMigration()
          defineFn(configMigration)
          if (!configMigration.description) {
            this.log('warn', `skipping migration without describe(): ${filePath}`)
            continue
          }
          const dep = this.app.dependencies[moduleName]
          migrations.push({ module: moduleName, version, type, description: configMigration.description, configMigration, rootDir: dep.rootDir })
        } else {
          const dsl = new MigrationDSL()
          defineFn(dsl)
          if (!dsl.description) {
            this.log('warn', `skipping migration without describe(): ${filePath}`)
            continue
          }
          migrations.push({ module: moduleName, version, type, description: dsl.description, dsl })
        }
      }
    }
    return migrations
  }

  filterPending (discovered, completed) {
    const completedSet = new Set(completed.map(c => migrationKey(c)))
    return discovered
      .filter(m => !completedSet.has(migrationKey(m)))
      .sort((a, b) => {
        return semver.compare(a.version, b.version) ||
          a.module.localeCompare(b.module) ||
          typeOrder(a.type) - typeOrder(b.type)
      })
  }

  async getCompletedMigrations () {
    return this.db.collection('migrations').find().toArray()
  }

  async recordCompleted (migration) {
    await this.db.collection('migrations').insertOne({
      module: migration.module,
      version: migration.version,
      type: migration.type,
      description: migration.description,
      completedAt: new Date()
    })
  }
}

function migrationKey (m) {
  return `${m.module}@${m.version}:${m.type || 'data'}`
}

function typeOrder (type) {
  return type === 'conf' ? 1 : 0
}

export default MigrationsModule
