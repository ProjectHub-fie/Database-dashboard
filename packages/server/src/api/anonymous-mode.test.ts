import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import { makeTestApp, TestAgent } from '../test/test-app.js'

/**
 * Exercises the temporary anonymous-connection configuration
 * (`AUTH_REQUIRED=false`). The security guarantees that must still hold:
 *
 *  - no dashboard login is needed to reach connection routes,
 *  - every browser gets its own unsigned session ref, so provider credentials
 *    are never process-global,
 *  - CSRF double-submit still protects state-changing requests,
 *  - account-only features (saved queries, audit history) stay closed off.
 */
describe('Anonymous connection mode (auth temporarily optional)', () => {
  let app: Express
  let anon: TestAgent
  let anon2: TestAgent

  beforeAll(async () => {
    const t = await makeTestApp({ authRequired: false })
    app = t.app
    anon = new TestAgent(app)
    anon2 = new TestAgent(app)
  })

  it('lets an unsigned visitor reach connection endpoints without a login', async () => {
    const res = await anon.get('/api/connections/status')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('connected')
  })

  it('mints an isolated anon cookie (HttpOnly) and reports anonymous in /me', async () => {
    // Fresh agent so the mint happens on this exact request and the raw
    // Set-Cookie header carries the attributes.
    const fresh = new TestAgent(app)
    const res = await fresh.get('/api/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.authenticated).toBe(false)
    expect(res.body.anonymous).toBe(true)
    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? []
    const sidCookie = setCookies.find((c) => c.startsWith('dbh_anon=')) ?? ''
    expect(sidCookie).toContain('HttpOnly')
    expect(sidCookie).toMatch(/SameSite=Lax/i)
  })

  it('gives distinct anon refs to distinct browsers', async () => {
    // Ensure anon2 has received its own cookie before we compare.
    await anon2.get('/api/auth/me')
    const a = anon.cookies.find((c) => c.startsWith('dbh_anon=')) ?? ''
    const b = anon2.cookies.find((c) => c.startsWith('dbh_anon=')) ?? ''
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
  })

  it('still blocks state-changing requests without a CSRF token', async () => {
    const res = await anon.post('/api/connections/disconnect', {})
    expect(res.status).toBe(403)
  })

  it('passes CSRF once the token cookie is presented', async () => {
    const csrf = anon.cookies.find((c) => c.startsWith('dbh_csrf=')) ?? ''
    const token = csrf.split('=')[1] ?? ''
    const res = await anon.post('/api/connections/disconnect', {}, token)
    // 200: the disconnect endpoint is safe on an empty session.
    expect([200, 404]).toContain(res.status)
  })

  it('keeps saved queries account-only under anonymous mode', async () => {
    const res = await anon.get('/api/sql/saved')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('keeps audit history account-only under anonymous mode', async () => {
    const res = await anon.get('/api/audit')
    expect(res.status).toBe(401)
  })

  it('does not leak the anon ref into API responses', async () => {
    const res = await anon.get('/api/connections/status')
    const raw = JSON.stringify(res.body)
    const cookie = anon.cookies.find((c) => c.startsWith('dbh_anon=')) ?? ''
    const ref = cookie.split('=')[1] ?? ''
    expect(raw).not.toContain(ref)
  })
})