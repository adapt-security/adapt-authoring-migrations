import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRedact, redactValue, DEFAULT_SENSITIVE_RE } from '../lib/utils/redactConfig.js'

describe('buildRedact', () => {
  it('should match built-in sensitive key names', () => {
    const redact = buildRedact()
    for (const k of ['tokenSecret', 'sessionSecret', 'connectionUri', 'apiKey', 'password', 'privateKey']) {
      assert.equal(redact(k), true, k)
    }
  })

  it('should not match ordinary keys', () => {
    const redact = buildRedact()
    for (const k of ['port', 'host', 'logLevels', 'trustProxy']) {
      assert.equal(redact(k), false, k)
    }
  })

  it('should add operator patterns additively', () => {
    const redact = buildRedact(['mysecretfield'])
    assert.equal(redact('mysecretfield'), true)
    assert.equal(redact('tokenSecret'), true)
    assert.equal(redact('port'), false)
  })

  it('should ignore an invalid operator pattern but keep built-ins', () => {
    const redact = buildRedact(['('])
    assert.equal(redact('apiKey'), true)
    assert.equal(redact('port'), false)
  })

  it('should expose the default pattern', () => {
    assert.ok(DEFAULT_SENSITIVE_RE.test('tokenSecret'))
  })
})

describe('redactValue', () => {
  const redact = buildRedact()

  it('should pass scalars through unchanged', () => {
    assert.equal(redactValue('x', redact), 'x')
    assert.equal(redactValue(5, redact), 5)
  })

  it('should mask sensitive keys nested in an object', () => {
    const out = redactValue({ apiKey: 'sk-123', model: 'haiku' }, redact)
    assert.deepEqual(out, { apiKey: '[redacted]', model: 'haiku' })
  })

  it('should recurse into nested objects and arrays', () => {
    const out = redactValue({ list: [{ token: 'abc', name: 'ok' }] }, redact)
    assert.deepEqual(out, { list: [{ token: '[redacted]', name: 'ok' }] })
  })
})
