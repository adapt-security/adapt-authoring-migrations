# Migrations

The migrations module provides a convention-based system for running data and config file migrations automatically on app startup. Use it to evolve your database schema, rename fields, manage indexes, transform stored data, or update config files as your modules are upgraded.

## How it works

1. On startup, the module scans all loaded modules for files in a `migrations/` directory
2. Each file is compared against the `migrations` collection to determine what has already run
3. Pending migrations are sorted by version and executed in order
4. Completed migrations are recorded so they never run twice
5. Any config file changes are written to disk, but only take effect on the next restart

## File naming

Migration filenames follow the pattern `<semver>-<type>[-<description>].js`:

```
adapt-authoring-mymodule/
└── migrations/
    ├── 1.0.0-data.js
    ├── 1.0.0-conf-move-auth-settings.js
    ├── 1.1.0-data-rename-users.js
    └── 2.0.0-conf.js
```

- **type** is either `data` (database migration) or `conf` (config file migration)
- **description** is an optional slug providing extra context about the migration
- Files without a type (e.g. `1.0.0.js`) default to `data` for backwards compatibility

Choose versions that correspond to the module release that requires the migration. For example, if you're releasing `adapt-authoring-mymodule@1.2.0` with a schema change, name the migration `1.2.0-data.js`.

## Execution order

Pending migrations are sorted globally by semver version, then alphabetically by module name, then by type (`data` before `conf`). This ensures data migrations take effect in the current boot before config migrations, whose file changes only take effect on the next restart.

## Data migrations

Each data migration file must default-export a function that receives a DSL context object:

```javascript
export default function (migration) {
  migration.describe('Rename _isAvailable to _isEnabled on content objects')

  migration.where({
    collection: 'contentobjects',
    _isAvailable: { $exists: true }
  })
  migration.mutate(doc => {
    doc._isEnabled = doc._isAvailable
    delete doc._isAvailable
  })
}
```

Every migration **must** call `describe()` with a human-readable summary. Migrations without a description are skipped with a warning.

### DSL reference

#### describe(text)

Sets a required human-readable description for the migration.

```javascript
migration.describe('Add default theme setting to all courses')
```

#### where(query)

Targets documents in a collection. The `collection` property names the MongoDB collection; all other properties form the query filter.

```javascript
migration.where({
  collection: 'courses',
  themeSettings: { $exists: false }
})
```

#### mutate(fn)

Transforms each document matched by the preceding `where()`. The function receives the document object and modifies it in place. Each document is saved back individually via `replaceOne`.

```javascript
migration.where({ collection: 'courses' })
migration.mutate(doc => {
  doc.themeSettings = { preset: 'default' }
})
```

#### check(fn)

Validates each document matched by the preceding `where()`. Throw an error to abort the migration.

```javascript
migration.where({ collection: 'users', email: { $exists: true } })
migration.check(doc => {
  if (!doc.email.includes('@')) {
    throw new Error(`Invalid email for user ${doc._id}`)
  }
})
```

#### setIndex(collection, spec, options?)

Creates or ensures a MongoDB index on a collection.

```javascript
migration.setIndex('users', { email: 1 }, { unique: true })
```

#### dropIndex(collection, name)

Removes an index by name.

```javascript
migration.dropIndex('users', 'email_1')
```

#### renameCollection(from, to)

Renames a MongoDB collection.

```javascript
migration.renameCollection('sessions', 'authsessions')
```

#### runCommand(fn)

Escape hatch for operations not covered by the DSL. The function receives the native MongoDB `Db` object.

```javascript
migration.runCommand(async db => {
  await db.collection('logs').deleteMany({ level: 'debug' })
})
```

### Chaining

All DSL methods (except `describe`) return `this`, so you can chain multiple operations in a single migration:

```javascript
export default function (migration) {
  migration.describe('Restructure user preferences')

  migration
    .where({ collection: 'users', preferences: { $exists: true } })
    .mutate(doc => {
      doc.settings = doc.preferences
      delete doc.preferences
    })
    .setIndex('users', { 'settings.theme': 1 })
    .dropIndex('users', 'preferences_1')
}
```

### Transactions and DDL operations

On a deployment that supports transactions (a replica set, including MongoDB Atlas), each data migration runs inside a single multi-document transaction so that a partial failure rolls back cleanly. On a standalone `mongod` there are no transactions and each operation is applied directly.

MongoDB does **not** permit DDL and certain other commands inside a multi-document transaction. This means a migration that uses `setIndex` (`createIndex`), `dropIndex`, `renameCollection`, or a `runCommand` that issues DDL / `distinct` / `listCollections` will **throw on a replica set** — even though the same migration runs fine on a standalone `mongod`, where the transaction path is never taken. Because standalone is the usual local/CI setup, this discrepancy is easy to miss until it fails on Atlas.

The same applies in [dry-run mode](#dry-run-mode): on a replica set a dry run uses the (aborted) transaction path, so a dry run of a DDL migration fails there too; the read-only proxy that would otherwise log the DDL is only used on standalone.

Keep index and collection changes in their own migration files, separate from document mutations, so that when this bites you can identify and re-work the offending migration in isolation. For operations that must run outside a transaction, perform them via `runCommand` against a deployment where you can control the session, or apply them as a manual operational step recorded alongside the release.

## Config file migrations

Config file migrations transform the application's `conf/*.config.js` files. The framework automatically discovers config files, loads each one, runs the migration's operations, and writes back any changes. Each file must default-export a function that receives a migration object:

```javascript
export default function (migration) {
  migration.describe('Move logger config keys to core')

  migration
    .where('adapt-authoring-logger')
    .replace('levels', 'adapt-authoring-core', 'logLevels')
    .replace('showTimestamp', 'adapt-authoring-core', 'showLogTimestamp')
    .remove('mute', 'dateFormat')
}
```

### DSL reference

#### where(moduleName)

Sets the source module for subsequent operations. If the named module section does not exist in a config file, all operations for that `where()` block are skipped.

```javascript
migration.where('adapt-authoring-logger')
```

#### replace(key, destModule, destKey?)

Replaces a config key in the current `where()` module with a key in the destination module. If `destKey` is omitted, the key name is preserved. Creates the destination module section if it doesn't exist. Use the same module name for source and destination to rename a key within a section.

```javascript
migration.replace('levels', 'adapt-authoring-core', 'logLevels')  // replace + rename
migration.replace('defaultLang', 'adapt-authoring-core')           // replace, keep name
migration.replace('oldKey', 'adapt-authoring-core', 'newKey')      // rename within same section
```

#### remove(...keys)

Removes one or more keys from the current `where()` module section.

```javascript
migration.remove('mute', 'dateFormat')
```

#### mutate(fn)

Escape hatch for operations not covered by `replace` and `remove`. Receives `(config, context)` and modifies `config` in place.

```javascript
migration.mutate(config => {
  config['adapt-authoring-core'].newKey = computeValue()
})
```

On a [`withOverrides` install](#the-withoverrides-round-trip) `config` is the file's authored **overrides** — a module section that only exists in the baseline defaults will be absent. Write null-safely, and read a baseline value via `context.merged` (a snapshot of the fully-merged config at boot):

```javascript
migration.mutate((config, context) => {
  const current = context.merged['adapt-authoring-core'].logLevels
  config['adapt-authoring-core'] ??= {}
  config['adapt-authoring-core'].logLevels = [...current, 'verbose']
})
```

A `mutate` that throws (e.g. assumes a section that isn't in the overrides) is reported as a per-file warning; that file is skipped and the migration is left pending so it re-runs once the mutate is made null-safe. Empty module sections are automatically cleaned up after all operations run.

### Chaining

All DSL methods return `this`, so you can chain operations and use multiple `where()` blocks:

```javascript
export default function (migration) {
  migration.describe('Consolidate absorbed module config')

  migration
    .where('adapt-authoring-logger')
    .replace('levels', 'adapt-authoring-core', 'logLevels')
    .replace('showTimestamp', 'adapt-authoring-core', 'showLogTimestamp')
    .remove('mute', 'dateFormat')
    .where('adapt-authoring-lang')
    .replace('defaultLang', 'adapt-authoring-core')
}
```

### How config files are processed

On the first config migration of a boot, every `conf/*.config.js` file is imported once into a shared working-copy cache, keyed by file. Each pending config migration then runs against that cache, so multiple migrations **compose** on the same file instead of each overwriting the last. For each file, the framework:

1. Runs the migration's operations against the cached working copy
2. Compares the serialized output — only writes back if the config actually changed
3. Preserves `key: undefined` entries (used to unset an inherited default), which plain JSON would drop
4. In dry-run mode, logs which files would be written without persisting

### The withOverrides round-trip

An instance may keep its `conf/*.config.js` as a plain object (`export default { ... }`) or layer its settings over a shared baseline:

```javascript
// conf/defaults.config.js — the shared baseline
export function withOverrides (overrides) { /* deep-merge onto defaults */ }
export default defaults

// conf/production.config.js — only this instance's overrides
import { withOverrides } from './defaults.config.js'
export default withOverrides({ 'adapt-authoring-server': { port: 5678 } })
```

Config migrations round-trip both styles. Each imported config file is classified by two non-enumerable markers a `withOverrides` helper attaches (`Symbol.for('adapt-authoring:configOverrides')` on the merged result, `Symbol.for('adapt-authoring:configDefaults')` on the baseline):

- **plain** — a plain object export. Operations run against the whole object; re-emitted as `export default { ... }` (the original behaviour).
- **overrides** — a `withOverrides({...})` file. Operations run against the authored **overrides only** (not the merged defaults); re-emitted as `export default withOverrides({ ... })` so the wrapper and inherited defaults are preserved rather than inlined. A key that lives only in the baseline is a no-op here — the baseline carries that change.
- **defaults** — the baseline file itself. **Skipped**: it is maintained by hand in the same release that ships the migration.

A plain instance needs no markers and is unaffected. To adopt the pattern, have your baseline's `withOverrides` attach the markers (non-enumerable, so the config loader and `JSON.stringify` never see them; global `Symbol.for` so this module reads them without importing your config).

### Restart behaviour

Config files are read once at startup — before migrations run — so changes a migration writes to disk **take effect on the next restart**, not the current boot. Nothing is thrown to force this; run under a process manager (pm2, systemd, Docker) if you want an automatic restart after config changes. The migrations are recorded as complete and will not re-run.

### Read-only config

Some deployments keep `conf/*.config.js` under version control or config management and don't want the app writing to them. Set `readOnlyConfig` to `true` in the `adapt-authoring-migrations` section of your app config to make config migrations report the required changes instead of applying them:

```javascript
{
  'adapt-authoring-migrations': {
    readOnlyConfig: true
  }
}
```

When enabled, each config migration that would change a file logs a `[READ-ONLY CONFIG]` warning naming the file and the module@version, followed by the same key-level diff shown in dry-run mode, then skips the write — you apply the change by hand.

The migration is **not** recorded as complete, so it re-runs (and re-warns) on every boot until you make the change manually; once the config matches, the computed diff is empty and the warning stops. This affects config migrations only — data migrations still run and are recorded as normal.

Report-only mode is also entered **automatically** when the `conf` directory isn't writable — the module checks write access up front, and defensively falls back if a write is denied (`EACCES`/`EROFS`/`EPERM`). So on a deployment with a read-only conf dir you get the same report-and-diff behaviour with no configuration; the warning notes `(conf dir is not writable)`. Set `readOnlyConfig: true` only to force report-only where the conf dir *is* writable but you still don't want the app to touch it (e.g. version-controlled config).

#### Secret redaction

The key-level diff (in read-only and dry-run modes) never prints secret values. A leaf key that looks sensitive — matching `secret`, `password`, `token`, `apiKey`, `credential`, `connectionUri`, `privateKey`, `passphrase` and similar — is shown as `[redacted]` (`~ …auth.tokenSecret: [redacted] -> [redacted]`), and secrets nested inside a non-sensitive key's object value are masked in place. Add extra patterns with `redactKeys` (regex sources, additive to the built-ins — they can never disable them):

```javascript
{
  'adapt-authoring-migrations': {
    readOnlyConfig: true,
    redactKeys: ['licenceKey', 'internalToken']
  }
}
```

### Cross-module config moves

If a config key has moved from one module to another, the migration should live in the **destination** module. The `mutate()` function receives the full config object, so it can read from any module section and write to any other.

## Dry-run mode

Pass the `--dry-run` flag on startup to preview pending migrations without persisting any changes:

```bash
npm start -- --dry-run
```

Every pending migration is discovered and executed, but all writes are rolled back or suppressed, so you can review exactly what would change before running for real. Log lines are prefixed with `[DRY RUN]`, and the reported mode tells you which mechanism is in use.

Behaviour differs by deployment:

- **Replica set (transactions available)** — each data migration runs for real inside a transaction that is then aborted. Reads and mutations execute against live data, so `where()` matching and `check()` validation are exercised exactly as in a real run, but nothing is committed.
- **Standalone mongod (no transactions)** — data migrations run through a read-only proxy. Reads execute normally, but write methods (`insertOne`, `updateMany`, `drop`, `createIndex`, `renameCollection`, etc.) are intercepted and logged instead of executed, e.g. `[DRY RUN] courses.updateMany({...})`.

Config file migrations compute the change and log a key-level diff (`+` added, `-` removed, `~` changed, [secrets redacted](#secret-redaction)) followed by `would write <file>`, but leave the files untouched.

A dry run never records anything in the `migrations` collection. Completion state is also ignored, so a dry run reports **every** discovered migration as pending — including ones already applied — giving you the full set that would run against a fresh database.

## State tracking

Completed migrations are recorded in the `migrations` collection:

```javascript
{
  module: 'adapt-authoring-mymodule',
  version: '1.1.0',
  type: 'data',
  description: 'Add default theme setting to all courses',
  completedAt: ISODate('2026-03-05T12:00:00Z')
}
```

The `type` field distinguishes `data` and `conf` migrations. A module can have both types at the same version. Records without a `type` field (from older versions of the module) are treated as `data`.

You can query this collection directly to audit which migrations have run.

## Error handling

If a migration fails, the error is logged and remaining migrations continue to run. After all migrations have been attempted, a summary error is thrown listing all failures. This fail-fast behaviour ensures data integrity — you should fix the issue and restart rather than running the app with a partially migrated state.

Migrations that completed before the failure are already recorded and will not re-run on the next startup.
