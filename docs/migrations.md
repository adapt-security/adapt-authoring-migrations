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

Escape hatch for operations not covered by `replace` and `remove`. Receives the full config object and modifies it in place.

```javascript
migration.mutate(config => {
  config['adapt-authoring-core'].newKey = computeValue()
})
```

Empty module sections are automatically cleaned up after all operations run.

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

For each pending config migration, the framework:

1. Finds all `conf/*.config.js` files in the application root directory
2. Dynamically imports each file to get the config object
3. Serializes the config before running the migration
4. Runs all registered operations against the config object
5. Compares the serialized output — only writes back if the config actually changed
6. In dry-run mode, logs which files would be written without persisting

### Restart behaviour

Config files are loaded at startup, so changes won't take effect until the process restarts. After all migrations complete, if any config file migrations ran successfully (non-dry-run), the module throws a fatal error:

```
Config file(s) modified by N migration(s). Restart required to load updated configuration.
```

Process managers (pm2, systemd, Docker) will automatically restart the app, which then picks up the updated config and boots normally. The config migrations are already recorded as complete and will not re-run.

### Cross-module config moves

If a config key has moved from one module to another, the migration should live in the **destination** module. The `mutate()` function receives the full config object, so it can read from any module section and write to any other.

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
