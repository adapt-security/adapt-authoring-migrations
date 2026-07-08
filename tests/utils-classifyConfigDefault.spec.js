import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyConfigDefault, CONFIG_OVERRIDES, CONFIG_DEFAULTS } from '../lib/utils/classifyConfigDefault.js'

describe('classifyConfigDefault', () => {
  it('should classify a plain object export as plain', () => {
    assert.equal(classifyConfigDefault({ 'mod-a': { key: 1 } }), 'plain')
  })

  it('should classify a withOverrides result as overrides', () => {
    const merged = { 'mod-a': { key: 1 } }
    Object.defineProperty(merged, CONFIG_OVERRIDES, {
      value: { overrides: { 'mod-a': { key: 1 } } },
      enumerable: false
    })
    assert.equal(classifyConfigDefault(merged), 'overrides')
  })

  it('should classify the baseline defaults as defaults', () => {
    const defaults = { 'mod-a': { key: 1 } }
    Object.defineProperty(defaults, CONFIG_DEFAULTS, { value: { role: 'defaults' }, enumerable: false })
    assert.equal(classifyConfigDefault(defaults), 'defaults')
  })

  it('should prefer defaults when both markers are present', () => {
    const value = {}
    Object.defineProperty(value, CONFIG_OVERRIDES, { value: {}, enumerable: false })
    Object.defineProperty(value, CONFIG_DEFAULTS, { value: {}, enumerable: false })
    assert.equal(classifyConfigDefault(value), 'defaults')
  })

  it('should classify non-objects as plain', () => {
    assert.equal(classifyConfigDefault(null), 'plain')
    assert.equal(classifyConfigDefault(undefined), 'plain')
  })
})
