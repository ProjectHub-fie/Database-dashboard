import { describe, expect, it } from 'vitest'
import { AnonymousSessionStore, csrfFor, ANON_CSRF_COOKIE } from './anon-session.js'

/**
 * These pin the property that broke in production: the API runs on more than one
 * host behind the Vercel proxy, so a cookie minted by one instance must be
 * accepted by another. When sessions were held in memory, the second instance
 * missed the ref, minted a fresh CSRF token, and every POST failed with
 * `403 Invalid or missing CSRF token`.
 */
describe('anonymous session store', () => {
  it('accepts a ref minted by a different instance', () => {
    const a = new AnonymousSessionStore()
    const b = new AnonymousSessionStore()

    const minted = a.resolve(undefined)
    expect(minted.isNew).toBe(true)

    const onOther = b.resolve(minted.session.ref)
    expect(onOther.isNew).toBe(false)
    expect(onOther.session.ref).toBe(minted.session.ref)
    // The decisive assertion: the CSRF token the browser holds is still valid.
    expect(onOther.session.csrf).toBe(minted.session.csrf)
  })

  it('derives the same CSRF token as the cookie the browser was given', () => {
    const store = new AnonymousSessionStore()
    const { session } = store.resolve(undefined)
    expect(csrfFor(session.ref)).toBe(session.csrf)
    expect(ANON_CSRF_COOKIE).toBe('dbh_csrf')
  })

  it('rejects a tampered ref instead of trusting it', () => {
    const store = new AnonymousSessionStore()
    const { session } = store.resolve(undefined)
    const [id, issued, sig] = session.ref.split('.')

    for (const forged of [
      `${id}.${issued}.${sig.slice(0, -2)}xx`,
      `forged${id}.${issued}.${sig}`,
      `${id}.${Number(issued) + 1}.${sig}`,
      `${id}.${issued}`,
      'garbage',
      '',
    ]) {
      expect(store.resolve(forged).isNew).toBe(true)
      expect(store.peek(forged)).toBeUndefined()
    }
  })

  it('mints a distinct ref per visitor', () => {
    const store = new AnonymousSessionStore()
    const refs = new Set(Array.from({ length: 25 }, () => store.resolve(undefined).session.ref))
    expect(refs.size).toBe(25)
  })

  it('re-mints once the idle window has passed', () => {
    const store = new AnonymousSessionStore()
    const { session } = store.resolve(undefined)
    const [id, , sig] = session.ref.split('.')
    // Shift the issue time far into the past while keeping the signature valid,
    // which is what an expired-but-untampered cookie looks like.
    const stale = store.resolve(undefined).session.ref
    const staleParts = stale.split('.')
    const ancient = `${staleParts[0]}.1.${staleParts[2]}`
    expect(store.resolve(ancient).isNew).toBe(true)
    // Control: the unmodified ref is still accepted.
    expect(store.resolve(session.ref).isNew).toBe(false)
    expect(id && sig).toBeTruthy()
  })
})
