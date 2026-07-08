/** Built-in sensitive-key pattern, matched against a config leaf key name. */
export const DEFAULT_SENSITIVE_RE = /secret|password|passwd|token|apikey|api[_-]?key|credential|connection(uri|url|string)|privatekey|passphrase/i

/**
 * Builds a predicate that reports whether a config key name is sensitive.
 * Operator-supplied patterns are additive to the built-ins and can never disable
 * them.
 * @param {string[]} [redactKeys=[]] - Extra regex sources unioned with the built-ins
 * @returns {function(string): boolean}
 */
export function buildRedact (redactKeys = []) {
  let extra
  try {
    if (redactKeys?.length) extra = new RegExp(redactKeys.join('|'), 'i')
  } catch {
    extra = undefined
  }
  return key => DEFAULT_SENSITIVE_RE.test(key) || (extra ? extra.test(key) : false)
}

/**
 * Returns a copy of a value with any sensitive-keyed value (at any depth)
 * replaced by `[redacted]`, for safe display in a diff.
 * @param {*} value
 * @param {function(string): boolean} isSensitive
 * @returns {*}
 */
export function redactValue (value, isSensitive) {
  if (Array.isArray(value)) return value.map(v => redactValue(v, isSensitive))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitive(k) ? '[redacted]' : redactValue(v, isSensitive)
    }
    return out
  }
  return value
}
