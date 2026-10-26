import fs from 'node:fs'
import path from 'node:path'

const CURRENT = 'db-remote.sqlite'
const LEGACY = 'db-horizon.sqlite'

/**
 * Resolve the dashboard SQLite file, reusing a pre-rename `db-horizon.sqlite`
 * when it exists. Without this fallback the brand rename would silently start
 * a fresh store on an already-running deployment and orphan its users, saved
 * queries and audit history.
 */
export function dashboardStorePath(dataDir: string): string {
  if (!dataDir) return ':memory:'
  const current = path.join(dataDir, CURRENT)
  const legacy = path.join(dataDir, LEGACY)
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy
  return current
}
