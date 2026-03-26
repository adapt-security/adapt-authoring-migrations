import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import createConfigContext from '../lib/createConfigContext.js'

describe('createConfigContext', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-ctx-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  describe('readFile', () => {
    it('should read a file relative to rootDir', async () => {
      await fs.writeFile(path.join(tmpDir, 'test.js'), 'hello')
      const ctx = createConfigContext(tmpDir, { dryRun: false, log: mock.fn() })
      const contents = await ctx.readFile('test.js')
      assert.equal(contents, 'hello')
    })

    it('should read nested paths', async () => {
      await fs.mkdir(path.join(tmpDir, 'conf'))
      await fs.writeFile(path.join(tmpDir, 'conf', 'config.js'), 'nested')
      const ctx = createConfigContext(tmpDir, { dryRun: false, log: mock.fn() })
      const contents = await ctx.readFile('conf/config.js')
      assert.equal(contents, 'nested')
    })
  })

  describe('writeFile', () => {
    it('should write a file relative to rootDir', async () => {
      const ctx = createConfigContext(tmpDir, { dryRun: false, log: mock.fn() })
      await ctx.writeFile('output.js', 'written')
      const contents = await fs.readFile(path.join(tmpDir, 'output.js'), 'utf8')
      assert.equal(contents, 'written')
    })

    it('should log instead of writing in dryRun mode', async () => {
      const log = mock.fn()
      const ctx = createConfigContext(tmpDir, { dryRun: true, log })
      await ctx.writeFile('output.js', 'should not write')

      const filePath = path.join(tmpDir, 'output.js')
      await assert.rejects(() => fs.access(filePath))
      assert.equal(log.mock.callCount(), 1)
      assert.ok(log.mock.calls[0].arguments[1].includes('[DRY RUN]'))
    })
  })

  describe('properties', () => {
    it('should expose dryRun flag', () => {
      const ctx = createConfigContext(tmpDir, { dryRun: true, log: mock.fn() })
      assert.equal(ctx.dryRun, true)
    })

    it('should expose log function', () => {
      const log = mock.fn()
      const ctx = createConfigContext(tmpDir, { dryRun: false, log })
      assert.equal(ctx.log, log)
    })
  })
})
