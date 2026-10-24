import crypto from 'node:crypto'
import { config } from '../config.js'

/**
 * Anonymous connection sessions.
 *
 * Used only while `config.authRequired` is false. Without a dashboard account
 * there is still a session boundary: every browser gets an unguessable ref in an
 * HttpOnly cookie, and that ref is the key for its provider credentials. Two
 * browsers therefore never share a pool, and knowing one ref does not reveal
 * another. Ref values are 192-bit random, so the ref doubles as the capability.
 *
 * Nothing here is persisted: refs live in memory and die with the process, the
 * same lifetime as the credentials they index.
 */

export const ANON_COOKIE = 'dbh_anon'
export const ANON_CSRF_COOKIE = 'dbh_csrf'

export interface AnonSession {
  ref: string
  csrf: string
  createdAt: number
  lastActive: number
}

export class AnonymousSessionStore {
  private readonly byRef = new Map<string, AnonSession>()

  /** Resolve a live ref, or mint one. Expired refs are replaced, never reused. */
  resolve(rawRef: string | undefined): { session: AnonSession; isNew: boolean } {
    const now = Date.now()
    if (rawRef) {
      const existing = this.byRef.get(rawRef)
      if (existing && now - existing.lastActive <= config.idleSessionTtlMs) {
        existing.lastActive = now
        return { session: existing, isNew: false }
      }
      if (existing) this.byRef.delete(rawRef)
    }
    const session: AnonSession = {
      ref: crypto.randomBytes(24).toString('base64url'),
      csrf: crypto.randomBytes(24).toString('base64url'),
      createdAt: now,
      lastActive: now,
    }
    this.byRef.set(session.ref, session)
    return { session, isNew: true }
  }

  touch(ref: string): void {
    const s = this.byRef.get(ref)
    if (s) s.lastActive = Date.now()
  }

  peek(ref: string): AnonSession | undefined {
    return this.byRef.get(ref)
  }

  remove(ref: string): void {
    this.byRef.delete(ref)
  }

  async sweepIdle(): Promise<number> {
    const now = Date.now()
    let removed = 0
    for (const [ref, s] of this.byRef) {
      if (now - s.lastActive > config.idleSessionTtlMs) {
        this.byRef.delete(ref)
        removed++
      }
    }
    return removed
  }

  size(): number {
    return this.byRef.size
  }
}
