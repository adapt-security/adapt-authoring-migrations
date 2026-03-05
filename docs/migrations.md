# Database migrations

The migrations module provides a convention-based system for running database migrations automatically on app startup. Use it to evolve your database schema, rename fields, manage indexes, or transform stored data as your modules are upgraded.

## How it works

1. On startup, the module scans all loaded modules for files in a `migrations/` directory
2. Each file is compared against the `migrations` collection to determine what has already run
3. Pending migrations are sorted by version and executed in order
4. Completed migrations are recorded so they never run twice

## Writing a migration

Add a `migrations/` directory to your module and create a file named with a valid semver version:

```
adapt-authoring-mymodule/
└── migrations/
    ├── 1.0.0.js
    ├── 1.1.0.js
    └── 2.0.0.js
```

Each file must default-export a function that receives a DSL context object:

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

## DSL reference

### describe(text)

Sets a required human-readable description for the migration.

```javascript
migration.describe('Add default theme setting to all courses')
```

### where(query)

Targets documents in a collection. The `collection` property names the MongoDB collection; all other properties form the query filter.

```javascript
migration.where({
  collection: 'courses',
  themeSettings: { $exists: false }
})
```

### mutate(fn)

Transforms each document matched by the preceding `where()`. The function receives the document object and modifies it in place. Each document is saved back individually via `replaceOne`.

```javascript
migration.where({ collection: 'courses' })
migration.mutate(doc => {
  doc.themeSettings = { preset: 'default' }
})
```

### check(fn)

Validates each document matched by the preceding `where()`. Throw an error to abort the migration.

```javascript
migration.where({ collection: 'users', email: { $exists: true } })
migration.check(doc => {
  if (!doc.email.includes('@')) {
    throw new Error(`Invalid email for user ${doc._id}`)
  }
})
```

### setIndex(collection, spec, options?)

Creates or ensures a MongoDB index on a collection.

```javascript
migration.setIndex('users', { email: 1 }, { unique: true })
```

### dropIndex(collection, name)

Removes an index by name.

```javascript
migration.dropIndex('users', 'email_1')
```

### renameCollection(from, to)

Renames a MongoDB collection.

```javascript
migration.renameCollection('sessions', 'authsessions')
```

### runCommand(fn)

Escape hatch for operations not covered by the DSL. The function receives the native MongoDB `Db` object.

```javascript
migration.runCommand(async db => {
  await db.collection('logs').deleteMany({ level: 'debug' })
})
```

## Chaining

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

## Execution order

Pending migrations are sorted globally by semver version, then alphabetically by module name for same-version ties. This provides a deterministic, repeatable order across all modules.

## State tracking

Completed migrations are recorded in the `migrations` collection:

```javascript
{
  module: 'adapt-authoring-mymodule',
  version: '1.1.0',
  description: 'Add default theme setting to all courses',
  completedAt: ISODate('2026-03-05T12:00:00Z')
}
```

You can query this collection directly to audit which migrations have run.

## Error handling

If a migration fails, the error is thrown and the app will not start. This fail-fast behaviour ensures data integrity — you should fix the issue and restart rather than running the app with a partially migrated database.

Migrations that completed before the failure are already recorded and will not re-run on the next startup.

## File naming

Migration filenames must be valid semver versions (e.g. `1.0.0.js`, `2.0.0-rc.1.js`). Files with invalid version names are skipped with a warning.

Choose versions that correspond to the module release that requires the migration. For example, if you're releasing `adapt-authoring-mymodule@1.2.0` with a schema change, name the migration `1.2.0.js`.
