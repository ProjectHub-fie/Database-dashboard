import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login } from '../test/test-app.js'

/**
 * Wire contract behind the account-gate UI:
 *
 *  - Under AUTH_REQUIRED=true (the default) every unsigned browser still gets
 *    an anonymous session ref, and provider-API-key mode is *public*: the key
 *    is bound to that ref and the provider decides what it may do. The client
 *    therefore renders the API-key tab unlocked even when signed out.
 *  - URL mode stays account-gated: a pasted database URL grants direct SQL
 *    access, so it always demands a real dashboard session. The client keeps
 *    the lock on the Database URL tab after sign-out, which requires
 *    `/api/auth/me` to keep reporting `authRequired`.
 */
describe('Auth-gate contract (AUTH_REQUIRED=true)', () => {
  let app: Express

  beforeAll(async () => {
    app = (await makeTestApp({ authRequired: true })).app
  })

  it('reports authRequired to the browser so the URL tab keeps its lock after logout', async () => {
    const res = await supertest(app).get('/api/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.authRequired).toBe(true)
    expect(res.body.authenticated).toBe(false)
  })

  it('allows an unsigned browser to open a provider-API-key session (the unlocked tab)', async () => {
    const t = await makeTestApp({ authRequired: true })
    const res = await new (await import('../test/test-app.js')).TestAgent(t.app).post(
      '/api/connections/api',
      { providerId: 'mongodb-atlas', apiKey: 'cid:secret' },
    )
    // CSRF is required even for the public path (TestAgent sends no CSRF).
    expect(res.status).toBe(403)
  })

  it('accepts an API-key connection from an anonymous browser with CSRF (public mode)', async () => {
    const t = await makeTestApp({ authRequired: true })
    // Anonymous browser: no dashboard login, only the session + CSRF cookies.
    const probe = await supertest(t.app).get('/api/auth/me')
    expect(probe.body.anonymous).toBe(true)

    const cookies = (probe.headers['set-cookie'] as unknown as string[] | undefined) ?? []
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
    const csrfRaw = cookies.find((c) => c.includes('dbh_csrf='))
    const csrf = csrfRaw ? decodeURIComponent(csrfRaw.split(';')[0].split('=').slice(1).join('=')) : ''

    const res = await supertest(t.app)
      .post('/api/connections/api')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ providerId: 'mongodb-atlas', apiKey: 'cid:secret' })
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.accountOnly).toBe(true)
  })

  it('still refuses an anonymous database-URL connection (the locked tab)', async () => {
    const t = await makeTestApp({ authRequired: true })
    const probe = await supertest(t.app).get('/api/auth/me')
    const cookies = ((probe.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ')
    const csrfRaw = (probe.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.includes('dbh_csrf='))
    const csrf = csrfRaw ? decodeURIComponent(csrfRaw.split(';')[0].split('=').slice(1).join('=')) : ''

    const res = await supertest(t.app)
      .post('/api/connections/url')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send({ providerId: 'neon', connectionString: 'postgresql://u:p@ep-x.neon.tech/db' })
    // 401 → the client reads "session lost"; for URL mode that is the correct
    // answer because the tab is locked behind a real dashboard account.
    expect(res.status).toBe(401)
  })

  it('prevents an anonymous API-key holder from silently switching to URL mode', async () => {
    const t = await makeTestApp({ authRequired: true })
    const probe = await supertest(t.app).get('/api/auth/me')
    const cookies = ((probe.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ')
    const csrfRaw = (probe.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.includes('dbh_csrf='))
    const csrf = csrfRaw ? decodeURIComponent(csrfRaw.split(';')[0].split('=').slice(1).join('=')) : ''
    const agent = supertest(t.app)
    const connected = await agent
      .post('/api/connections/api')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send({ providerId: 'mongodb-atlas', apiKey: 'cid:secret' })
    expect(connected.status).toBe(200)

    const urlAttempt = await agent
      .post('/api/connections/url')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send({ providerId: 'neon', connectionString: 'postgresql://u:p@ep-x.neon.tech/db' })
    expect(urlAttempt.status).toBe(401)
  })

  it('exposes authRequired on the account panel when signed in', async () => {
    const t = await makeTestApp({ authRequired: true })
    const seed = await seedUser(t.store, 'gate-user')
    const out = await login(t.app, seed.username, seed.password)
    const me = await out.agent.get('/api/auth/me')
    expect(me.body.authenticated).toBe(true)
    expect(me.body.authRequired).toBe(true)
  })

  it('public API-key sessions can reach the dashboard data pages (anonymous shell pass)', async () => {
    const t = await makeTestApp({ authRequired: true })
    const probe = await supertest(t.app).get('/api/auth/me')
    const cookies = ((probe.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ')
    const csrfRaw = (probe.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.includes('dbh_csrf='))
    const csrf = csrfRaw ? decodeURIComponent(csrfRaw.split(';')[0].split('=').slice(1).join('=')) : ''
    const agent = supertest(t.app)
    await agent.post('/api/connections/api').set('Cookie', cookies).set('x-csrf-token', csrf).send({ providerId: 'mongodb-atlas', apiKey: 'cid:secret' })

    const status = await agent.get('/api/connections/status').set('Cookie', cookies)
    expect(status.status).toBe(200)
    expect(status.body.connected).toBe(true)

    const projects = await agent.get('/api/control/projects').set('Cookie', cookies)
    // A provider session bound to the anonymous ref is the authorization; the
    // route must never 401 "session lost" for it.
    expect(projects.status).not.toBe(401)
  })
})