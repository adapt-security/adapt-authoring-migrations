import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFilename } from '../lib/utils/parseFilename.js'

describe('parseFilename', () => {
  describe('typeless filenames (default to data)', () => {
    it('should parse a plain semver filename', () => {
      const result = parseFilename('1.0.0.js')
      assert.deepEqual(result, { version: '1.0.0', type: 'data' })
    })

    it('should parse a semver with prerelease', () => {
      const result = parseFilename('2.0.0-rc.1.js')
      assert.deepEqual(result, { version: '2.0.0-rc.1', type: 'data' })
    })

    it('should work with absolute paths', () => {
      const result = parseFilename('/some/path/to/migrations/1.2.3.js')
      assert.deepEqual(result, { version: '1.2.3', type: 'data' })
    })
  })

  describe('typed filenames', () => {
    it('should parse a data type', () => {
      const result = parseFilename('1.0.0-data.js')
      assert.deepEqual(result, { version: '1.0.0', type: 'data', description: undefined })
    })

    it('should parse a conf type', () => {
      const result = parseFilename('1.0.0-conf.js')
      assert.deepEqual(result, { version: '1.0.0', type: 'conf', description: undefined })
    })

    it('should parse type with description', () => {
      const result = parseFilename('1.0.0-conf-move-auth-settings.js')
      assert.deepEqual(result, { version: '1.0.0', type: 'conf', description: 'move-auth-settings' })
    })

    it('should parse data type with description', () => {
      const result = parseFilename('2.1.0-data-rename-users.js')
      assert.deepEqual(result, { version: '2.1.0', type: 'data', description: 'rename-users' })
    })

    it('should handle semver prerelease with type', () => {
      const result = parseFilename('1.0.0-rc.1-conf.js')
      assert.deepEqual(result, { version: '1.0.0-rc.1', type: 'conf', description: undefined })
    })

    it('should handle semver prerelease with type and description', () => {
      const result = parseFilename('1.0.0-rc.1-data-fix-indexes.js')
      assert.deepEqual(result, { version: '1.0.0-rc.1', type: 'data', description: 'fix-indexes' })
    })
  })

  describe('invalid filenames', () => {
    it('should return null for non-semver', () => {
      assert.equal(parseFilename('not-a-version.js'), null)
    })

    it('should return null for empty basename', () => {
      assert.equal(parseFilename('.js'), null)
    })

    it('should return null for invalid version with valid type', () => {
      assert.equal(parseFilename('bad-conf.js'), null)
    })
  })
})
