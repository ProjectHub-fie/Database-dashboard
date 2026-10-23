import { DatabaseSync } from 'node:sqlite'

/**
 * Transaction helper for node:sqlite (which lacks better-sqlite3's
 * .transaction() helper). Runs `fn` inside BEGIN/COMMIT, rolling back on error.
 */
export function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* connection already torn down */
    }
    throw err
  }
}
