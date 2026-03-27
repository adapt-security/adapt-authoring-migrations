import fs from 'fs/promises'
import path from 'path'
import { glob } from 'glob'
import semver from 'semver'
import { MongoClient } from 'mongodb'
import DataMigration from './DataMigration.js'
import ConfigMigration from './ConfigMigration.js'
import { createReadOnlyDb, createSessionDb, parseFilename } from './utils.js'

/**
 * Runs all pending migrations (config and data) during app boot.
 * @param {Object} options
 * @param {Object} options.dependencies - Dependency configs map (name -> { rootDir, ... })
 * @param {string} options.connectionUri - MongoDB connection string
 * @param {string} options.rootDir - App root directory
 * @param {function} options.log - Logging function (level, ...args)
 * @param {boolean} [options.dryRun=false] - Run without persisting changes
 */
export async function runMigrations (options) {
  const { dependencies, connectionUri, rootDir, log, dryRun = false } = options

  const discovered = await discoverMigrations(dependencies, log)

  if (!discovered.length) return

  const client = new MongoClient(connectionUri)
  try {
    await client.connect()
    const db = client.db()
    const useTransactions = await supportsTransactions(db)

    const completed = dryRun ? [] : await getCompletedMigrations(db)
    const pending = filterPending(discovered, completed)

    if (!pending.length) {
      log('info', 'migrations', 'no pending migrations')
      return
    }
    const prefix = dryRun ? '[DRY RUN] ' : ''
    const mode = useTransactions ? 'transactions' : (dryRun ? 'read-only proxy' : 'no transactions')
    log('info', 'migrations', `${prefix}running ${pending.length} pending migration(s) (${mode})`)

    const errors = []
    for (const m of pending) {
      log('info', 'migrations', `${prefix}running ${m.module}@${m.version} [${m.type}]: ${m.description}`)
      try {
        await executeMigration(m, { dryRun, client, db, useTransactions, rootDir, log })
      } catch (error) {
        log('error', 'migrations', `${prefix}${m.module}@${m.version} failed: ${error.message}`)
        errors.push({ module: m.module, version: m.version, error })
      }
    }
    if (errors.length) {
      throw new Error(`${errors.length} migration(s) failed: ${errors.map(e => `${e.module}@${e.version}`).join(', ')}`)
    }
  } finally {
    await client.close()
  }
}

async function supportsTransactions (db) {
  try {
    const admin = db.admin()
    const { hosts } = await admin.command({ hello: 1 })
    return hosts?.length > 0
  } catch {
    return false
  }
}

async function discoverMigrations (dependencies, log) {
  const migrations = []
  await Promise.all(Object.values(dependencies).map(async dep => {
    const files = await glob('migrations/*.js', { cwd: dep.rootDir, absolute: true })
    for (const filePath of files) {
      const parsed = parseFilename(filePath)
      if (!parsed) {
        log('warn', 'migrations', `skipping invalid migration filename: ${filePath}`)
        continue
      }
      const { version, type } = parsed
      const { default: defineFn } = await import(filePath)

      if (type === 'conf') {
        const configMigration = new ConfigMigration()
        defineFn(configMigration)
        if (!configMigration.description) {
          log('warn', 'migrations', `skipping migration without describe(): ${filePath}`)
          continue
        }
        migrations.push({ module: dep.name, version, type, description: configMigration.description, configMigration })
      } else {
        const dsl = new DataMigration()
        defineFn(dsl)
        if (!dsl.description) {
          log('warn', 'migrations', `skipping migration without describe(): ${filePath}`)
          continue
        }
        migrations.push({ module: dep.name, version, type, description: dsl.description, dsl })
      }
    }
  }))
  return migrations
}

async function executeMigration (migration, ctx) {
  const { dryRun, client, db, useTransactions, rootDir, log } = ctx
  if (migration.type === 'conf') {
    return executeConfMigration(migration, { dryRun, db, rootDir, log })
  }
  if (useTransactions) {
    return executeWithTransaction(migration, { dryRun, client, db })
  }
  if (dryRun) {
    return executeWithProxy(migration, { db, log })
  }
  await migration.dsl.execute(db)
  await recordCompleted(db, migration)
}

async function executeConfMigration (migration, { dryRun, db, rootDir, log }) {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  const files = await glob('conf/*.config.js', { cwd: rootDir, absolute: true })
  for (const filePath of files) {
    const config = (await import(filePath)).default
    const before = JSON.stringify(config)
    migration.configMigration.execute(config)
    if (JSON.stringify(config) === before) continue
    const fileName = path.basename(filePath)
    if (dryRun) {
      log('info', 'migrations', `${prefix}would write ${fileName}`)
      continue
    }
    await fs.writeFile(filePath, `export default ${JSON.stringify(config, null, 2)}\n`, 'utf8')
    log('info', 'migrations', `updated ${fileName}`)
  }
  if (!dryRun) {
    await recordCompleted(db, migration)
  }
}

async function executeWithTransaction (migration, { dryRun, client, db }) {
  const session = client.startSession()
  try {
    session.startTransaction()
    const sessionDb = createSessionDb(db, session)
    await migration.dsl.execute(sessionDb)
    if (dryRun) {
      await session.abortTransaction()
    } else {
      await session.commitTransaction()
      await recordCompleted(db, migration)
    }
  } catch (error) {
    await session.abortTransaction()
    throw error
  } finally {
    await session.endSession()
  }
}

async function executeWithProxy (migration, { db, log }) {
  const readOnlyDb = createReadOnlyDb(db, log)
  await migration.dsl.execute(readOnlyDb)
}

function filterPending (discovered, completed) {
  const completedSet = new Set(completed.map(c => migrationKey(c)))
  return discovered
    .filter(m => !completedSet.has(migrationKey(m)))
    .sort((a, b) => {
      return semver.compare(a.version, b.version) ||
        a.module.localeCompare(b.module) ||
        typeOrder(a.type) - typeOrder(b.type)
    })
}

async function getCompletedMigrations (db) {
  return db.collection('migrations').find().toArray()
}

async function recordCompleted (db, migration) {
  await db.collection('migrations').insertOne({
    module: migration.module,
    version: migration.version,
    type: migration.type,
    description: migration.description,
    completedAt: new Date()
  })
}

function migrationKey (m) {
  return `${m.module}@${m.version}:${m.type || 'data'}`
}

function typeOrder (type) {
  return type === 'conf' ? 1 : 0
}
