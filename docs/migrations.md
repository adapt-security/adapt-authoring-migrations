# Migrations

The migrations module provides a convention-based system for running data and config file migrations automatically on app startup. Use it to evolve your database schema, rename fields, manage indexes, transform stored data, or update config files as your modules are upgraded.

## How it works

1. On startup, the module scans all loaded modules for files in a `migrations/` directory
2. Each file is compared against the `migrations` collection to determine what has already run
3. Pending migrations are sorted by version and executed in order
4. Completed migrations are recorded so they never run twice
5. If any config file migrations ran, the app throws a fatal error to force a restart

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

Pending migrations are sorted globally by semver version, then alphabetically by module name, then by type (`data` before `conf`). This ensures data migrations take effect in the current boot before config migrations trigger a restart.

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

## Config file migrations

Config file migrations modify `.js` configuration files on disk. Each file must default-export a function that receives a migration object with `describe()` and `run()`:

```javascript
export default function (migration) {
  migration.describe('Rename authToken to accessToken in config')

  migration.run(async ({ readFile, writeFile, log }) => {
    const contents = await readFile('conf/config.js')
    const updated = contents.replace(/authToken/g, 'accessToken')
    await writeFile('conf/config.js', updated)
  })
}
```

### Context API

The `run()` callback receives a context object with:

- **`appDir`** — absolute path to the application root directory (where `conf/*.config.js` files live)
- **`readFile(relativePath)`** — reads a file relative to the module's root directory, returns a string
- **`writeFile(relativePath, contents)`** — writes a file relative to the module's root directory. In dry-run mode, logs the intended write without persisting
- **`log(level, message)`** — logs a message at the given level
- **`dryRun`** — boolean indicating whether the migration is running in dry-run mode

### Restart behaviour

Config files are loaded at startup, so changes won't take effect until the process restarts. After all migrations complete, if any config file migrations ran successfully (non-dry-run), the module throws a fatal error:

```
Config file(s) modified by N migration(s). Restart required to load updated configuration.
```

Process managers (pm2, systemd, Docker) will automatically restart the app, which then picks up the updated config and boots normally. The config migrations are already recorded as complete and will not re-run.

### Cross-module config moves

If a config key has moved from one module to another, the migration should live in the **destination** module. The `readFile` and `writeFile` helpers are scoped to the migration's own module root, but the migration function can use standard `fs` operations for cross-module changes if needed.

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
