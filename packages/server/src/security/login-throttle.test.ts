import { describe, it, expect } from 'vitest'
import { LoginThrottle } from './login-throttle.js'

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('LoginThrottle', () => {
  it('allows attempts below the failure cap', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 5, now: c.now })
    for (let i = 0; i < 4; i++) {
      expect(throttle.check('1.2.3.4', 'alice').allowed).toBe(true)
      throttle.recordFailure('1.2.3.4', 'alice')
    }
    expect(throttle.check('1.2.3.4', 'alice').allowed).toBe(true)
  })

  it('locks the username once the cap is reached', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 3, lockoutMs: 60_000, now: c.now })
    for (let i = 0; i < 3; i++) throttle.recordFailure('1.2.3.4', 'alice')
    const decision = throttle.check('1.2.3.4', 'alice')
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(60_000)
  })

  it('blocks the account across different source IPs', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 3, now: c.now })
    // A botnet spreading guesses over many addresses must not reset the account.
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      throttle.recordFailure(ip, 'target@example.com')
    }
    const decision = throttle.check('10.0.0.99', 'target@example.com')
    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('username')
  })

  it('blocks a single host spraying many usernames', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 3, maxIpFailures: 3, now: c.now })
    for (const user of ['a', 'b', 'c']) throttle.recordFailure('192.0.2.7', user)
    const decision = throttle.check('192.0.2.7', 'never-tried-before')
    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('ip')
  })

  it('matches usernames case-insensitively', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 2, now: c.now })
    throttle.recordFailure('1.1.1.1', 'Alice')
    throttle.recordFailure('1.1.1.1', 'ALICE')
    expect(throttle.check('1.1.1.1', 'alice').allowed).toBe(false)
  })

  it('releases the lock after the cooldown', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 2, lockoutMs: 5_000, now: c.now })
    throttle.recordFailure('1.2.3.4', 'bob')
    throttle.recordFailure('1.2.3.4', 'bob')
    expect(throttle.check('1.2.3.4', 'bob').allowed).toBe(false)
    c.advance(5_001)
    expect(throttle.check('1.2.3.4', 'bob').allowed).toBe(true)
  })

  it('forgets failures after a successful login', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 3, now: c.now })
    throttle.recordFailure('1.2.3.4', 'carol')
    throttle.recordFailure('1.2.3.4', 'carol')
    throttle.recordSuccess('1.2.3.4', 'carol')
    for (let i = 0; i < 2; i++) throttle.recordFailure('1.2.3.4', 'carol')
    expect(throttle.check('1.2.3.4', 'carol').allowed).toBe(true)
  })

  it('does not lock a colleague who shares the office IP', () => {
    const c = clock()
    // Defaults: account cap 5, IP cap 20.
    const throttle = new LoginThrottle({ now: c.now })
    for (let i = 0; i < 5; i++) throttle.recordFailure('203.0.113.9', 'dave')
    expect(throttle.check('203.0.113.9', 'dave').allowed).toBe(false)
    // Same NAT, different account: still free to sign in.
    expect(throttle.check('203.0.113.9', 'erin').allowed).toBe(true)
  })

  it('still stops one host after the IP cap, even across accounts', () => {
    const c = clock()
    const throttle = new LoginThrottle({ now: c.now })
    for (let i = 0; i < 20; i++) throttle.recordFailure('203.0.113.9', `victim${i}`)
    const decision = throttle.check('203.0.113.9', 'someone-else')
    expect(decision.allowed).toBe(false)
    expect(decision.scope).toBe('ip')
  })

  it('bounds memory by evicting idle keys but keeps active lockouts', () => {
    const c = clock()
    const throttle = new LoginThrottle({ maxFailures: 2, maxKeys: 4, windowMs: 1_000, lockoutMs: 60_000, now: c.now })
    throttle.recordFailure('10.0.0.1', 'locked')
    throttle.recordFailure('10.0.0.1', 'locked')
    expect(throttle.check('10.0.0.1', 'locked').allowed).toBe(false)
    c.advance(2_000)
    // Fill with unrelated usernames; the eviction must not clear the lockout.
    for (let i = 0; i < 20; i++) throttle.recordFailure(`10.9.0.${i}`, `user${i}`)
    expect(throttle.check('10.0.0.1', 'locked').allowed).toBe(false)
  })
})
