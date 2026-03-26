import path from 'path'
import semver from 'semver'

const TYPES = ['data', 'conf']
const TYPE_PATTERN = new RegExp(`^(.+)-(${TYPES.join('|')})(?:-(.+))?$`)

/**
 * Parses a migration filename into version, type, and optional description.
 *
 * Supported formats:
 *   1.0.0.js           → { version: '1.0.0', type: 'data' }
 *   1.0.0-data.js      → { version: '1.0.0', type: 'data' }
 *   1.0.0-conf.js      → { version: '1.0.0', type: 'conf' }
 *   1.0.0-conf-desc.js → { version: '1.0.0', type: 'conf', description: 'desc' }
 *
 * @param {string} filePath - Absolute or relative file path
 * @returns {{ version: string, type: string, description: string|undefined }|null}
 *   Parsed result, or null if the filename is not a valid migration
 */
export function parseFilename (filePath) {
  const basename = path.basename(filePath, '.js')
  const match = basename.match(TYPE_PATTERN)
  if (match) {
    const [, version, type, description] = match
    if (!semver.valid(version)) return null
    return { version, type, description }
  }
  if (!semver.valid(basename)) return null
  return { version: basename, type: 'data' }
}
