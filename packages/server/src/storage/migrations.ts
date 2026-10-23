import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { runInTransaction } from './run-tx.js'

/**
 * Migrations for the dashboard's own storage. They only touch dashboard
 * metadata (users, sessions, audit log, saved queries) — never user data.
 * A database URL or API key is never persisted to the dashboard store.
 */
const MIGRATIONS: ReadonlyArray<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'users_and_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        accept_language TEXT,
        ip TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        session_id TEXT,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

      CREATE TABLE IF NOT EXISTS saved_queries (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_queries(user_id);

      CREATE TABLE IF NOT EXISTS audit_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        retention_days INTEGER NOT NULL DEFAULT 90
      );

      INSERT OR IGNORE INTO audit_settings (id, enabled, retention_days) VALUES (1, 1, 90);
    `,
  },
  {
    // Security events (sign-in, connection attempts, SQL, destructive actions)
    // are audited by default; operators may opt out in Settings.
    id: 2,
    name: 'audit_enabled_by_default',
    sql: `UPDATE audit_settings SET enabled = 1 WHERE id = 1 AND enabled = 0;`,
  },
  {
    // Tracks the last time the user re-entered their password so destructive
    // operations can require recent reauthentication independent of the
    // rolling last_seen_at idle clock.
    id: 3,
    name: 'session_reauth_at',
    sql: `
      ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
      UPDATE sessions SET reauth_at = created_at WHERE reauth_at IS NULL;
    `,
  },
]

export interface MigrationRow {
  id: number
  name: string
  applied_at: number
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const applied = new Set<number>(
    (db.prepare('SELECT id FROM schema_migrations').all() as unknown as MigrationRow[]).map(
      (r) => r.id,
    ),
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    runInTransaction(db, () => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        Date.now(),
      )
    })
  }
}

export function dbFileExists(dbPath: string): boolean {
  return fs.existsSync(dbPath)
}