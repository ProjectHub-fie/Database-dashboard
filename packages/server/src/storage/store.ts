import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
type DatabaseSync = import('node:sqlite').DatabaseSync
const DatabaseSyncCtor = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
import { migrate } from './migrations.js'
import { createLogger, AppLogger } from '../lib/logger.js'

export interface Session {
  id: string
  userId: number
  tokenHash: string
  csrfToken: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revoked: number
  revokedAt: number | null
  ip: string | null
  reauthAt: number | null
}

export interface User {
  id: number
  username: string
  passwordHash: string
  role: string
  createdAt: number
  mustChangePassword: number
}

export interface AuditEvent {
  id?: number
  userId: number | null
  sessionId: string | null
  event: string
  actor: string
  status: string
  target?: string | null
  detail?: string | null
  createdAt: number
}

export interface SavedQuery {
  id: string
  userId: number
  name: string
  sql: string
  createdAt: number
  updatedAt: number
}

type Row = Record<string, unknown>

function mapUser(row: Row): User {
  return {
    id: Number(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: String(row.role),
    createdAt: Number(row.created_at),
    mustChangePassword: Number(row.must_change_password),
  }
}

function mapSession(row: Row): Session {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    tokenHash: String(row.token_hash),
    csrfToken: String(row.csrf_token),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
    revoked: Number(row.revoked),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
    reauthAt: row.reauth_at === null || row.reauth_at === undefined ? null : Number(row.reauth_at),
  }
}

function mapSavedQuery(row: Row): SavedQuery {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    name: String(row.name),
    sql: String(row.sql),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * Dashboard metadata store. Connections to user databases are held in memory
 * only (session-managed); nothing user-database-related is persisted here.
 */
export class Store {
  readonly db: DatabaseSync
  private readonly logger: AppLogger

  constructor(dbPath: string | ':memory:', opts: { logger?: AppLogger } = {}) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath)
      fs.mkdirSync(dir, { recursive: true })
    }
    this.db = new DatabaseSyncCtor(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    // Wait for a competing writer instead of failing with SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    migrate(this.db)
    this.logger = opts.logger ?? createLogger()
    this.logger.info({ mode: dbPath === ':memory:' ? 'memory' : 'file' }, 'dashboard store opened')
  }

  // ---- users -------------------------------------------------------------

  createUser(username: string, passwordHash: string): User {
    const now = Date.now()
    const info = this.db
      .prepare(
        'INSERT INTO users (username, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, 1)',
      )
      .run(username, passwordHash, 'admin', now)
    return this.getUserById(Number(info.lastInsertRowid))!
  }

  getUserById(id: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    return row ? mapUser(row) : undefined
  }

  getUserByUsername(username: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    return row ? mapUser(row) : undefined
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  updatePassword(userId: number, passwordHash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(passwordHash, userId)
  }

  deleteUser(userId: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  }

  // ---- sessions ------------------------------------------------------------

  createSession(s: Omit<Session, 'revoked' | 'revokedAt'>): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, last_seen_at, expires_at, ip, reauth_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.userId, s.tokenHash, s.csrfToken, s.createdAt, s.lastSeenAt, s.expiresAt, s.ip, s.createdAt)
    return this.getSession(s.id)!
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? (mapSession(row) as Session) : undefined
  }

  getSessionByTokenHash(hash: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash)
    return row ? (mapSession(row) as Session) : undefined
  }

  touchSession(id: string, lastSeenAt: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id)
  }

  markReauthed(id: string, at: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, reauth_at = ? WHERE id = ?').run(at, at, id)
  }

  /** Set only the reauth clock (used by tests to simulate stale reauth). */
  setSessionReauthAt(id: string, at: number): void {
    this.db.prepare('UPDATE sessions SET reauth_at = ? WHERE id = ?').run(at, id)
  }

  getSessionReauthAt(id: string): number {
    const row = this.db.prepare('SELECT reauth_at FROM sessions WHERE id = ?').get(id) as
      | { reauth_at: number | null }
      | undefined
    return row?.reauth_at ?? 0
  }

  revokeSession(id: string): void {
    this.db
      .prepare('UPDATE sessions SET revoked = 1, revoked_at = ? WHERE id = ?')
      .run(Date.now(), id)
  }

  revokeAllSessions(userId: number, exceptId?: string): void {
    if (exceptId) {
      this.db
        .prepare("UPDATE sessions SET revoked = 1, revoked_at = ? WHERE user_id = ? AND id != ?")
        .run(Date.now(), userId, exceptId)
    } else {
      this.db
        .prepare('UPDATE sessions SET revoked = 1, revoked_at = ? WHERE user_id = ?')
        .run(Date.now(), userId)
    }
  }

  listUserSessions(userId: number): Array<Omit<Session, 'tokenHash' | 'csrfToken'>> {
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, created_at AS createdAt, last_seen_at AS lastSeenAt,
                expires_at AS expiresAt, revoked, revoked_at AS revokedAt, ip
         FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as Array<Omit<Session, 'tokenHash' | 'csrfToken'>>
    return rows
  }

  /** Remove expired, revoked, and orphaned sessions. Returns deleted count. */
  sweepSessions(now: number): number {
    const info = this.db
      .prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked = 1')
      .run(now - 7 * 24 * 60 * 60 * 1000)
    return Number(info.changes)
  }

  // ---- audit ---------------------------------------------------------------

  writeAudit(row: Omit<AuditEvent, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (user_id, session_id, event, actor, status, target, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.userId,
        row.sessionId,
        row.event,
        row.actor,
        row.status,
        row.target ?? null,
        row.detail ?? null,
        row.createdAt,
      )
  }

  listAudit(opts: { limit: number; offset: number; event?: string }): { rows: AuditEvent[]; total: number } {
    const where = opts.event ? ' WHERE event = ?' : ''
    const cond: Array<string | number> = []
    if (opts.event) cond.push(opts.event)
    const params = [...cond, opts.limit, opts.offset]
    const rows = this.db
      .prepare(
        `SELECT id, user_id AS userId, session_id AS sessionId, event, actor, status, target, detail,
                created_at AS createdAt
         FROM audit_log${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as unknown as AuditEvent[]
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log${where}`)
      .get(...cond) as unknown as { n: number }
    return { rows, total: n }
  }

  listAuditEvents(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT event FROM audit_log ORDER BY event')
      .all() as Array<{ event: string }>
    return rows.map((r) => r.event)
  }

  pruneAudit(now: number, retentionDays: number): number {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    const info = this.db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff)
    return Number(info.changes)
  }

  getAuditSettings(): { enabled: boolean; retentionDays: number } {
    const row = this.db
      .prepare('SELECT enabled, retention_days AS retentionDays FROM audit_settings WHERE id = 1')
      .get() as { enabled: number; retentionDays: number }
    return { enabled: row.enabled === 1, retentionDays: row.retentionDays }
  }

  setAuditEnabled(enabled: boolean, retentionDays: number): void {
    this.db
      .prepare('UPDATE audit_settings SET enabled = ?, retention_days = ? WHERE id = 1')
      .run(enabled ? 1 : 0, retentionDays)
  }

  // ---- saved queries ---------------------------------------------------------

  saveQuery(q: SavedQuery): void {
    this.db
      .prepare(
        `INSERT INTO saved_queries (id, user_id, name, sql, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sql = excluded.sql, updated_at = excluded.updated_at`,
      )
      .run(q.id, q.userId, q.name, q.sql, q.createdAt, q.updatedAt)
  }

  listSavedQueries(userId: number): SavedQuery[] {
    const rows = this.db
      .prepare('SELECT * FROM saved_queries WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>
    return rows.map((r) => mapSavedQuery(r))
  }

  getSavedQuery(id: string, userId: number): SavedQuery | undefined {
    const row = this.db
      .prepare('SELECT * FROM saved_queries WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined
    return row ? mapSavedQuery(row) : undefined
  }

  deleteSavedQuery(id: string, userId: number): boolean {
    const info = this.db.prepare('DELETE FROM saved_queries WHERE id = ? AND user_id = ?').run(id, userId)
    return Number(info.changes) > 0
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}