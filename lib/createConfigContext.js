import fs from 'fs/promises'
import path from 'path'

/**
 * Creates the context object passed to a conf migration's run() function.
 * All file paths are resolved relative to the module's root directory.
 * In dryRun mode, writeFile logs the intended write instead of persisting.
 *
 * @param {string} rootDir - The module's root directory
 * @param {object} options
 * @param {boolean} options.dryRun - Whether to suppress writes
 * @param {Function} options.log - Logging function (level, message)
 * @returns {{ readFile: Function, writeFile: Function, log: Function, dryRun: boolean }}
 */
function createConfigContext (rootDir, { dryRun, log }) {
  return {
    dryRun,
    log,
    async readFile (relativePath) {
      const resolved = path.resolve(rootDir, relativePath)
      return fs.readFile(resolved, 'utf8')
    },
    async writeFile (relativePath, contents) {
      const resolved = path.resolve(rootDir, relativePath)
      if (dryRun) {
        log('info', `[DRY RUN] would write ${resolved} (${contents.length} bytes)`)
        return
      }
      await fs.writeFile(resolved, contents, 'utf8')
    }
  }
}

export default createConfigContext
