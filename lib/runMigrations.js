import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
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
 * @param {string} options.configFilePath - Path to the user config file
 * @param {string} options.rootDir - App root directory
 * @param {function} options.log - Logging function (level, id, ...args)
 * @param {boolean} [options.dryRun=false] - Run without persisting changes
 */
export async function runMigrations (options) {
  const { dependencies, configFilePath, rootDir, log, dryRun = false } = options

  let connectionUri
  let advisoryMode = false
  try {
    const userConfig = (await import(pathToFileURL(configFilePath).href)).default
    connectionUri = userConfig?.['adapt-authoring-mongodb']?.connectionUri
    advisoryMode = userConfig?.['adapt-authoring-migrations']?.advisoryMode ?? false
  } catch {
    // no config file
  }
  if (!connectionUri) return

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
        await executeMigration(m, { advisoryMode, dryRun, client, db, useTransactions, rootDir, log })
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
  await Promise.all(Object.entries(dependencies).map(async ([name, dep]) => {
    const files = await glob('migrations/*.js', { cwd: dep.rootDir, absolute: true })
    for (const filePath of files) {
      const parsed = parseFilename(filePath)
      if (!parsed) {
        log('warn', 'migrations', `skipping invalid migration filename: ${filePath}`)
        continue
      }
      const { version, type } = parsed
      const { default: defineFn } = await import(pathToFileURL(filePath).href)

      if (type === 'conf') {
        const configMigration = new ConfigMigration()
        defineFn(configMigration)
        if (!configMigration.description) {
          log('warn', 'migrations', `skipping migration without describe(): ${filePath}`)
          continue
        }
        migrations.push({ module: name, version, type, description: configMigration.description, configMigration })
      } else {
        const dsl = new DataMigration()
        defineFn(dsl)
        if (!dsl.description) {
          log('warn', 'migrations', `skipping migration without describe(): ${filePath}`)
          continue
        }
        migrations.push({ module: name, version, type, description: dsl.description, dsl })
      }
    }
  }))
  return migrations
}

async function executeMigration (migration, ctx) {
  const { advisoryMode, dryRun, client, db, useTransactions, rootDir, log } = ctx
  if (migration.type === 'conf') {
    return executeConfMigration(migration, { advisoryMode, dryRun, db, rootDir, log })
  }
  if (useTransactions) {
    return executeWithTransaction(migration, { dryRun, client, db, log })
  }
  if (dryRun) {
    return executeWithProxy(migration, { db, log })
  }
  await migration.dsl.execute(db, log)
  await recordCompleted(db, migration)
}

async function executeConfMigration (migration, { advisoryMode, dryRun, db, rootDir, log }) {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  const files = await glob('conf/*.config.js', { cwd: rootDir, absolute: true })
  for (const filePath of files) {
    const config = (await import(pathToFileURL(filePath).href)).default
    const before = JSON.stringify(config)
    const configClone = JSON.parse(before)
    migration.configMigration.execute(configClone)
    if (JSON.stringify(configClone) === before) continue
    const fileName = path.basename(filePath)
    if (advisoryMode) {
      log('warn', 'migrations', `[ADVISORY] ${fileName} requires manual config changes for ${migration.module}@${migration.version}`)
      logConfigDiff(config, configClone, log)
      continue
    }
    if (dryRun) {
      log('info', 'migrations', `${prefix}would write ${fileName}`)
      continue
    }
    await fs.writeFile(filePath, `export default ${JSON.stringify(configClone, null, 2)}\n`, 'utf8')
    log('info', 'migrations', `updated ${fileName}`)
  }
  if (!dryRun && !advisoryMode) {
    await recordCompleted(db, migration)
  }
}

async function executeWithTransaction (migration, { dryRun, client, db, log }) {
  const session = client.startSession()
  try {
    session.startTransaction()
    const sessionDb = createSessionDb(db, session)
    await migration.dsl.execute(sessionDb, log)
    if (dryRun) {
      await session.abortTransaction()
    } else {
      await recordCompleted(sessionDb, migration)
      await session.commitTransaction()
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
  await migration.dsl.execute(readOnlyDb, log)
}

export function filterPending (discovered, completed) {
  const completedSet = new Set(completed.map(c => migrationKey(c)))
  return discovered
    .filter(m => !completedSet.has(migrationKey(m)))
    .sort((a, b) => {
      return semver.compare(a.version, b.version) ||
        a.module.localeCompare(b.module) ||
        typeOrder(a.type) - typeOrder(b.type)
    })
}

/**
 * Logs the key-level diff between two config objects (before and after a migration).
 * Used to advise operators of the manual changes required when write access is unavailable.
 * @param {Object} before - Config before migration
 * @param {Object} after - Config after migration
 * @param {function} log - Logging function (level, id, ...args)
 */
export function logConfigDiff (before, after, log) {
  const allModules = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const mod of allModules) {
    if (!before[mod]) {
      for (const [key, value] of Object.entries(after[mod])) {
        log('warn', 'migrations', `  + ${mod}.${key}: ${JSON.stringify(value)}`)
      }
    } else if (!after[mod]) {
      for (const key of Object.keys(before[mod])) {
        log('warn', 'migrations', `  - ${mod}.${key}`)
      }
    } else {
      const allKeys = new Set([...Object.keys(before[mod]), ...Object.keys(after[mod])])
      for (const key of allKeys) {
        if (!(key in before[mod])) {
          log('warn', 'migrations', `  + ${mod}.${key}: ${JSON.stringify(after[mod][key])}`)
        } else if (!(key in after[mod])) {
          log('warn', 'migrations', `  - ${mod}.${key}`)
        } else if (JSON.stringify(before[mod][key]) !== JSON.stringify(after[mod][key])) {
          log('warn', 'migrations', `  ~ ${mod}.${key}: ${JSON.stringify(before[mod][key])} -> ${JSON.stringify(after[mod][key])}`)
        }
      }
    }
  }
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
