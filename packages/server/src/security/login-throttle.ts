/**
 * Login throttling.
 *
 * The global rate limiter caps total API traffic; it does not stop password
 * guessing, because 300 login attempts per minute is a usable brute-force rate.
 * This adds failure-driven lockout on two independent keys:
 *
 *   - the client IP, so one host cannot spray many usernames
 *   - the submitted username, so a botnet cannot focus one account
 *
 * A successful login clears both counters. Lockout expiry is a fixed cooldown,
 * not a permanent ban, so a legitimate user who mistyped a few times recovers
 * without administrator intervention.
 *
 * Counters live in process memory. On a multi-instance deployment (Vercel) each
 * instance keeps its own count, so the effective limit is per instance. That is
 * deliberate: this is defence in depth behind Argon2id hashing, not the only
 * control. A single shared store would be required for a hard global guarantee.
 */

export interface ThrottleDecision {
  allowed: boolean
  /** Milliseconds until the caller may try again. Only set when blocked. */
  retryAfterMs: number
  /** Which key triggered the block, for audit detail. Never sent to browsers. */
  scope?: 'ip' | 'username'
}

interface Bucket {
  failures: number
  /** Epoch ms when the current failure window started. */
  windowStart: number
  /** Epoch ms before which all attempts are rejected; 0 when unlocked. */
  lockedUntil: number
}

export interface LoginThrottleOptions {
  /** Failures against one account before it locks. */
  maxFailures?: number
  /**
   * Failures from one IP before the IP locks. Deliberately higher than the
   * per-account cap: many people share one address behind NAT or a corporate
   * proxy, and a low IP cap would let anyone lock out a whole office by
   * failing a few times on purpose. The account cap carries the brute-force
   * defence; the IP cap is for single-host spraying.
   */
  maxIpFailures?: number
  windowMs?: number
  lockoutMs?: number
  /** Cap on tracked keys, so a spray of unique usernames cannot grow memory. */
  maxKeys?: number
  now?: () => number
}

const DEFAULTS = {
  maxFailures: 5,
  maxIpFailures: 20,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
  maxKeys: 5_000,
}

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>()
  private readonly maxFailures: number
  private readonly maxIpFailures: number
  private readonly windowMs: number
  private readonly lockoutMs: number
  private readonly maxKeys: number
  private readonly now: () => number

  constructor(opts: LoginThrottleOptions = {}) {
    this.maxFailures = opts.maxFailures ?? DEFAULTS.maxFailures
    this.maxIpFailures = opts.maxIpFailures ?? DEFAULTS.maxIpFailures
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs
    this.lockoutMs = opts.lockoutMs ?? DEFAULTS.lockoutMs
    this.maxKeys = opts.maxKeys ?? DEFAULTS.maxKeys
    this.now = opts.now ?? (() => Date.now())
  }

  /** Check both keys before verifying a password. Reads only; never mutates. */
  check(ip: string | undefined, username: string): ThrottleDecision {
    const t = this.now()
    for (const [scope, key] of this.keys(ip, username)) {
      const bucket = this.buckets.get(key)
      if (bucket && bucket.lockedUntil > t) {
        return { allowed: false, retryAfterMs: bucket.lockedUntil - t, scope }
      }
    }
    return { allowed: true, retryAfterMs: 0 }
  }

  /** Record a failed credential check. Locks the key once the cap is reached. */
  recordFailure(ip: string | undefined, username: string): void {
    const t = this.now()
    for (const [scope, key] of this.keys(ip, username)) {
      const cap = scope === 'ip' ? this.maxIpFailures : this.maxFailures
      const bucket = this.buckets.get(key) ?? { failures: 0, windowStart: t, lockedUntil: 0 }
      if (t - bucket.windowStart > this.windowMs) {
        bucket.failures = 0
        bucket.windowStart = t
      }
      bucket.failures += 1
      if (bucket.failures >= cap) {
        bucket.lockedUntil = t + this.lockoutMs
        bucket.failures = 0
        bucket.windowStart = t
      }
      this.buckets.set(key, bucket)
    }
    this.evict()
  }

  /** Clear counters for a key pair after a successful login. */
  recordSuccess(ip: string | undefined, username: string): void {
    for (const [, key] of this.keys(ip, username)) this.buckets.delete(key)
  }

  private keys(ip: string | undefined, username: string): Array<['ip' | 'username', string]> {
    const keys: Array<['ip' | 'username', string]> = []
    if (ip) keys.push(['ip', `ip:${ip}`])
    keys.push(['username', `user:${username.toLowerCase()}`])
    return keys
  }

  /**
   * Bound memory when a spray of unique usernames fills the map. Expired and
   * unlocked buckets go first; active lockouts are kept, otherwise the eviction
   * would hand an attacker a way to clear the counters that block them.
   */
  private evict(): void {
    if (this.buckets.size <= this.maxKeys) return
    const t = this.now()
    for (const [key, bucket] of this.buckets) {
      if (this.buckets.size <= this.maxKeys) return
      const idle = bucket.lockedUntil <= t && t - bucket.windowStart > this.windowMs
      if (idle) this.buckets.delete(key)
    }
    // Still over cap (many concurrent lockouts): drop the soonest-expiring.
    if (this.buckets.size <= this.maxKeys) return
    const ordered = [...this.buckets.entries()].sort((a, b) => a[1].lockedUntil - b[1].lockedUntil)
    for (const [key] of ordered) {
      if (this.buckets.size <= this.maxKeys) return
      this.buckets.delete(key)
    }
  }
}

/** Process-wide throttle used by the login and reauthentication routes. */
export const loginThrottle = new LoginThrottle()
