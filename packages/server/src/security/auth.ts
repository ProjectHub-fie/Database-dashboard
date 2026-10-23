import crypto from 'node:crypto'
import argon2 from 'argon2'
import { Store, Session, User } from '../storage/store.js'
import { AppError } from '../lib/errors.js'
import { config } from '../config.js'
import { createLogger } from '../lib/logger.js'

const SESSION_COOKIE = 'dbh_sid'
const CSRF_COOKIE = 'dbh_csrf'

const argon2idOptions: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB, 5-minute free tier guidance
  timeCost: 2,
  parallelism: 1,
}

export { SESSION_COOKIE, CSRF_COOKIE }

export interface SessionAccount {
  session: Session
  user: User
}

export class AuthService {
  private readonly logger = createLogger()

  constructor(private readonly store: Store) {}

  /** Hash a password with Argon2id (OWASP preferred config). */
  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, argon2idOptions)
  }

  verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password).catch(() => false)
  }

  async createInitialAdmin(): Promise<boolean> {
    if (this.store.countUsers() > 0) return false
    const username = process.env.ADMIN_USERNAME ?? 'admin'
    const password = process.env.ADMIN_INITIAL_PASSWORD
    if (!password) return false // refuse to invent default credentials
    if (password.length < 12) {
      throw new AppError({
        code: 'INTERNAL',
        message: 'ADMIN_INITIAL_PASSWORD must be at least 12 characters',
      })
    }
    const hash = await this.hashPassword(password)
    this.store.createUser(username, hash)
    this.logger.info({ event: 'initial_admin_created', username }, 'initial admin account created from env')
    return true
  }

  async authenticate(username: string, password: string): Promise<User> {
    const user = this.store.getUserByUsername(username)
    if (!user) {
      // Run a dummy verify to keep timing uniform for unknown users.
      await this.verifyPassword(
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password,
      )
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid username or password' })
    }
    const ok = await this.verifyPassword(user.passwordHash, password)
    if (!ok) {
      throw new AppError({ code: 'UNAUTHORIZED', message: 'Invalid username or password' })
    }
    return user
  }

  createSession(user: User, opts: { ip?: string } = {}): SessionAccount & { rawToken: string } {
    const sessionId = crypto.randomBytes(24).toString('base64url')
    const token = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    const session = this.store.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: this.digestToken(token),
      csrfToken: crypto.randomBytes(24).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + config.sessionTtlMs,
      ip: opts.ip ?? null,
      reauthAt: now,
    })
    return { rawToken: token, ...{ session, user } }
  }

  private digestToken(token: string): string {
    return crypto.createHmac('sha256', this.sessionDigestKey()).update(token).digest('hex')
  }

  private sessionDigestKey(): string {
    return crypto.createHash('sha256').update(config.cookieSecret).digest('hex')
  }

  sessionCookieName(): string {
    return SESSION_COOKIE
  }

  csrfCookieName(): string {
    return CSRF_COOKIE
  }

  /** Validate a raw session token and return the live session + user. */
  validateSession(rawToken: string): SessionAccount | null {
    if (!rawToken) return null
    const tokenHash = this.digestToken(rawToken)
    const session = this.store.getSessionByTokenHash(tokenHash)
    if (!session) return null
    if (session.revoked) return null
    const now = Date.now()
    if (session.expiresAt < now) {
      this.store.revokeSession(session.id)
      return null
    }
    if (now - session.lastSeenAt > config.idleSessionTtlMs) {
      this.store.revokeSession(session.id)
      return null
    }
    const user = this.store.getUserById(session.userId)
    if (!user) {
      this.store.revokeSession(session.id)
      return null
    }
    this.store.touchSession(session.id, now)
    return { session, user }
  }

  /** Revoke a single session (used by logout and disconnect). */
  revokeSession(sessionId: string): void {
    this.store.revokeSession(sessionId)
  }

  revokeAllForUser(userId: number, exceptId?: string): void {
    this.store.revokeAllSessions(userId, exceptId)
  }

  sweep(now: number): void {
    this.store.sweepSessions(now)
  }
}