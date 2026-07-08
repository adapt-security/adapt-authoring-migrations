/**
 * Global symbol carried by a config file's default export when it was produced
 * by a `withOverrides(overrides)` helper. Its value is
 * `{ overrides, importSpecifier, helper }` describing how to re-serialise the
 * file. Non-enumerable, so the app's config loader (`Object.entries`) and
 * `JSON.stringify` never see it. Global (`Symbol.for`) so the umbrella app that
 * writes it and this published module that reads it agree without a shared import.
 */
export const CONFIG_OVERRIDES = Symbol.for('adapt-authoring:configOverrides')

/**
 * Global symbol marking the baseline defaults object a `withOverrides` helper
 * merges onto. Config migrations skip files carrying it: the baseline is
 * maintained by hand in the same release that ships the migration.
 */
export const CONFIG_DEFAULTS = Symbol.for('adapt-authoring:configDefaults')

/**
 * Classifies a config file's default export so the migration engine knows how to
 * transform and re-serialise it.
 * @param {*} value - The imported default export
 * @returns {'defaults'|'overrides'|'plain'} `defaults` = skip (baseline),
 * `overrides` = transform the authored overrides and re-emit via the helper,
 * `plain` = a plain object export (legacy behaviour)
 */
export function classifyConfigDefault (value) {
  if (value && typeof value === 'object') {
    if (value[CONFIG_DEFAULTS]) return 'defaults'
    if (value[CONFIG_OVERRIDES]) return 'overrides'
  }
  return 'plain'
}

export default classifyConfigDefault
