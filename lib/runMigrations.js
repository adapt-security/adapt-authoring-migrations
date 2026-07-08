import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { glob } from 'glob'
import semver from 'semver'
import { MongoClient } from 'mongodb'
import DataMigration from './DataMigration.js'
import ConfigMigration from './ConfigMigration.js'
import {
  createReadOnlyDb, createSessionDb, parseFilename,
  serializeConfig, classifyConfigDefault, CONFIG_OVERRIDES, buildRedact, redactValue
} from './utils.js'

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
  let readOnlyConfig = false
  let redactKeys = []
  try {
    const userConfig = (await import(pathToFileURL(configFilePath).href)).default
    connectionUri = userConfig?.['adapt-authoring-mongodb']?.connectionUri
    readOnlyConfig = userConfig?.['adapt-authoring-migrations']?.readOnlyConfig ?? false
    redactKeys = userConfig?.['adapt-authoring-migrations']?.redactKeys ?? []
  } catch {
    // no config file
  }
  if (!connectionUri) return

  const redact = buildRedact(redactKeys)
  const confState = { loaded: false, files: new Map() }

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
        await executeMigration(m, { readOnlyConfig, dryRun, client, db, useTransactions, rootDir, log, redact, confState })
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
  const { readOnlyConfig, dryRun, client, db, useTransactions, rootDir, log, redact, confState } = ctx
  if (migration.type === 'conf') {
    return executeConfMigration(migration, { readOnlyConfig, dryRun, db, rootDir, log, redact, confState })
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

/**
 * Loads every conf/*.config.js once per runMigrations invocation into a shared
 * working-copy cache (classified by {@link classifyConfigDefault}), so multiple
 * config migrations compose on one file instead of each overwriting the last.
 * @param {string} rootDir
 * @param {{ loaded: boolean, files: Map }} confState
 */
async function loadConfFiles (rootDir, confState) {
  if (confState.loaded) return
  const files = await glob('conf/*.config.js', { cwd: rootDir, absolute: true })
  for (const filePath of files) {
    const original = (await import(pathToFileURL(filePath).href)).default
    const kind = classifyConfigDefault(original)
    if (kind === 'overrides') {
      const meta = original[CONFIG_OVERRIDES]
      confState.files.set(filePath, {
        kind,
        meta,
        working: structuredClone(meta.overrides),
        baselineMerged: structuredClone(original)
      })
    } else if (kind === 'plain') {
      confState.files.set(filePath, { kind, working: structuredClone(original) })
    } else {
      confState.files.set(filePath, { kind })
    }
  }
  confState.writable = true
  try {
    await fs.access(path.join(rootDir, 'conf'), fs.constants.W_OK)
  } catch (error) {
    if (error.code !== 'ENOENT') confState.writable = false
  }
  confState.loaded = true
}

/** Renders a cached config file entry back to JavaScript source. */
function serializeConfFile (entry) {
  if (entry.kind === 'overrides') {
    const helper = entry.meta.helper || 'withOverrides'
    const specifier = entry.meta.importSpecifier || './defaults.config.js'
    return `import { ${helper} } from '${specifier}'\n\nexport default ${helper}(${serializeConfig(entry.working)})\n`
  }
  return `export default ${serializeConfig(entry.working)}\n`
}

const WRITE_DENIED = new Set(['EACCES', 'EROFS', 'EPERM'])

export async function executeConfMigration (migration, { readOnlyConfig, dryRun, db, rootDir, log, redact = buildRedact(), confState }) {
  const prefix = dryRun ? '[DRY RUN] ' : ''
  await loadConfFiles(rootDir, confState)
  const reportOnly = readOnlyConfig || !confState.writable
  const reportManual = (fileName, before, after, why) => {
    log('warn', 'migrations', `[READ-ONLY CONFIG]${why} ${fileName} requires manual config changes for ${migration.module}@${migration.version}`)
    logConfigDiff(before, after, log, 'warn', redact)
  }
  let recordable = true
  for (const [filePath, entry] of confState.files) {
    if (entry.kind === 'defaults') continue
    const fileName = path.basename(filePath)
    const before = structuredClone(entry.working)
    const context = entry.kind === 'overrides'
      ? { merged: structuredClone(entry.baselineMerged), isOverrides: true }
      : { merged: entry.working, isOverrides: false }
    try {
      migration.configMigration.execute(entry.working, context)
    } catch (error) {
      log('warn', 'migrations', `${prefix}skipping ${fileName} for ${migration.module}@${migration.version}: ${error.message} (mutate must be null-safe on withOverrides installs - read defaults via context.merged)`)
      entry.working = before
      recordable = false
      continue
    }
    if (serializeConfig(entry.working) === serializeConfig(before)) continue
    if (reportOnly) {
      reportManual(fileName, before, entry.working, readOnlyConfig ? '' : ' (conf dir is not writable)')
      recordable = false
      continue
    }
    if (dryRun) {
      log('info', 'migrations', `${prefix}would write ${fileName}`)
      logConfigDiff(before, entry.working, log, 'info', redact)
      continue
    }
    try {
      await fs.writeFile(filePath, serializeConfFile(entry), 'utf8')
      log('info', 'migrations', `updated ${fileName}`)
    } catch (error) {
      if (!WRITE_DENIED.has(error.code)) throw error
      reportManual(fileName, before, entry.working, ` (not writable: ${error.code})`)
      recordable = false
    }
  }
  if (!dryRun && !reportOnly && recordable) {
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
 * Used to show operators the changes that a migration would make or requires manually.
 * Secret values are masked: a sensitive leaf key prints `[redacted]`, and secrets
 * nested inside a non-sensitive key's object value are masked in place.
 * @param {Object} before - Config before migration
 * @param {Object} after - Config after migration
 * @param {function} log - Logging function (level, id, ...args)
 * @param {string} [level='info'] - Log level to use
 * @param {function(string): boolean} [redact] - Sensitive-key predicate
 */
export function logConfigDiff (before, after, log, level = 'info', redact = buildRedact()) {
  const display = (key, value) => redact(key) ? '[redacted]' : JSON.stringify(redactValue(value, redact))
  const allModules = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const mod of allModules) {
    if (!before[mod]) {
      for (const [key, value] of Object.entries(after[mod])) {
        log(level, 'migrations', `  + ${mod}.${key}: ${display(key, value)}`)
      }
    } else if (!after[mod]) {
      for (const key of Object.keys(before[mod])) {
        log(level, 'migrations', `  - ${mod}.${key}`)
      }
    } else {
      const allKeys = new Set([...Object.keys(before[mod]), ...Object.keys(after[mod])])
      for (const key of allKeys) {
        if (!(key in before[mod])) {
          log(level, 'migrations', `  + ${mod}.${key}: ${display(key, after[mod][key])}`)
        } else if (!(key in after[mod])) {
          log(level, 'migrations', `  - ${mod}.${key}`)
        } else if (JSON.stringify(before[mod][key]) !== JSON.stringify(after[mod][key])) {
          log(level, 'migrations', `  ~ ${mod}.${key}: ${display(key, before[mod][key])} -> ${display(key, after[mod][key])}`)
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
