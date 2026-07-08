/**
 * Serialises a config value to a valid JavaScript source expression. Mirrors
 * `JSON.stringify(value, null, 2)` but preserves `undefined`-valued keys (config
 * files use `key: undefined` to unset an inherited default), which JSON drops.
 * @param {*} value - The value to serialise
 * @param {number} [level=0] - Current indentation depth (internal)
 * @returns {string} A parseable JS expression
 */
export function serializeConfig (value, level = 0) {
  const pad = '  '.repeat(level)
  const padInner = '  '.repeat(level + 1)
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    const items = value.map(v => padInner + serializeConfig(v, level + 1))
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'number': return String(value)
    case 'boolean': return String(value)
    case 'object': {
      const keys = Object.keys(value)
      if (!keys.length) return '{}'
      const entries = keys.map(k => `${padInner}${JSON.stringify(k)}: ${serializeConfig(value[k], level + 1)}`)
      return `{\n${entries.join(',\n')}\n${pad}}`
    }
    default: return 'undefined'
  }
}

export default serializeConfig
