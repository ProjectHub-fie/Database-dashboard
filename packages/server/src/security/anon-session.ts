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
 * The ref and its CSRF companion are **stateless**: the ref carries its issue
 * time and an HMAC under `config.cookieSecret`, and the CSRF token is an HMAC of
 * the ref. Any instance sharing that secret can validate either without shared
 * storage, which this API needs because it runs on more than one host behind the
 * Vercel proxy.
 *
 * Storing them per process instead (the original design) meant a request that
 * landed on a different instance — or on any instance after a restart — missed
 * the session, so the server minted a fresh CSRF token while the browser kept
 * sending the old one. Every such POST failed with
 * `403 Invalid or missing CSRF token`.
 *
 * Provider credentials, pools and SQL cursors stay in memory (see
 * `provider-sessions.ts`); only the session identity is stateless.
 */

export const ANON_COOKIE = 'dbh_anon'
export const ANON_CSRF_COOKIE = 'dbh_csrf'

export interface AnonSession {
  ref: string
  csrf: string
  createdAt: number
  lastActive: number
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function hmac(scope: string, value: string): string {
  return b64url(
    crypto.createHmac('sha256', config.cookieSecret).update(`${scope}:${value}`).digest().subarray(0, 24),
  )
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/** CSRF token for a session ref. Deterministic, so every instance derives the same. */
export function csrfFor(ref: string): string {
  return hmac('csrf', ref)
}

export class AnonymousSessionStore {
  /** Refs this process has seen; used for size diagnostics and sweep only. */
  private readonly seen = new Map<string, number>()

  /** Verify a ref's signature and read its issue time, without trusting the client. */
  private verify(rawRef: string): { ref: string; issuedAt: number } | undefined {
    const parts = rawRef.split('.')
    if (parts.length !== 3) return undefined
    const [id, issued, sig] = parts
    if (!id || !issued || !sig) return undefined
    const issuedAt = Number.parseInt(issued, 10)
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return undefined
    if (!safeEqual(sig, hmac('anon', `${id}.${issued}`))) return undefined
    return { ref: rawRef, issuedAt }
  }

  private mint(now: number): AnonSession {
    const id = b64url(crypto.randomBytes(24))
    const ref = `${id}.${now}.${hmac('anon', `${id}.${now}`)}`
    this.seen.set(ref, now)
    return { ref, csrf: csrfFor(ref), createdAt: now, lastActive: now }
  }

  /**
   * Resolve a live ref, or mint one. A signature-valid ref is honoured even when
   * this process has never seen it, so instances and restarts agree; `isNew` is
   * true only when the browser must be handed fresh cookies.
   */
  resolve(rawRef: string | undefined): { session: AnonSession; isNew: boolean } {
    const now = Date.now()
    if (rawRef) {
      const verified = this.verify(rawRef)
      // Idle expiry counts from the original issue time: without shared storage
      // there is no per-request clock to slide, and a cookie that outlives the
      // idle window is a worse trade than a re-mint after it.
      if (verified && now - verified.issuedAt <= config.idleSessionTtlMs) {
        this.seen.set(verified.ref, now)
        return {
          session: {
            ref: verified.ref,
            csrf: csrfFor(verified.ref),
            createdAt: verified.issuedAt,
            lastActive: now,
          },
          isNew: false,
        }
      }
      this.seen.delete(rawRef)
    }
    return { session: this.mint(now), isNew: true }
  }

  touch(ref: string): void {
    if (this.seen.has(ref)) this.seen.set(ref, Date.now())
  }

  peek(rawRef: string): AnonSession | undefined {
    const verified = this.verify(rawRef)
    if (!verified) return undefined
    const now = Date.now()
    if (now - verified.issuedAt > config.idleSessionTtlMs) return undefined
    return {
      ref: verified.ref,
      csrf: csrfFor(verified.ref),
      createdAt: verified.issuedAt,
      lastActive: this.seen.get(verified.ref) ?? verified.issuedAt,
    }
  }

  remove(ref: string): void {
    this.seen.delete(ref)
  }

  async sweepIdle(): Promise<number> {
    const now = Date.now()
    let removed = 0
    for (const [ref, lastActive] of this.seen) {
      if (now - lastActive > config.idleSessionTtlMs) {
        this.seen.delete(ref)
        removed++
      }
    }
    return removed
  }

  size(): number {
    return this.seen.size
  }
}
