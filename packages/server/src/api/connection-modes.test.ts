import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login, TestAgent, MockNeonHttpClient } from '../test/test-app.js'
import { NeonApiError } from '../providers/neon/client.js'

/**
 * Connection-mode tests: the three ways into the dashboard, and the promise that
 * none of them can leak a credential or reach a prohibited destination.
 *
 * Neon's HTTP API is mocked; no real provider or database is contacted.
 */
describe('Connection modes', () => {
  let app: Express
  let seed: { username: string; password: string }
  let neon: MockNeonHttpClient

  beforeAll(async () => {
    const t = await makeTestApp()
    app = t.app
    neon = t.neon
    seed = await seedUser(t.store)
    neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }))
  })

  // --- provider catalog ---------------------------------------------------

  it('lists the provider catalog publicly, marking planned providers unavailable', async () => {
    const res = await supertest(app).get('/api/providers')
    expect(res.status).toBe(200)
    const byId = Object.fromEntries(res.body.providers.map((p: any) => [p.id, p]))

    expect(byId.neon.available).toBe(true)
    expect(byId.neon.authMethods).toEqual(expect.arrayContaining(['connection', 'api']))
    expect(byId.neon.controlPlane).toBe(true)

    // Roadmap entries must never look selectable.
    for (const id of ['mysql', 'mariadb', 'supabase']) {
      expect(byId[id].available).toBe(false)
      expect(byId[id].authMethods).toEqual([])
      expect(typeof byId[id].blockedBy).toBe('string')
    }
  })

  it('derives auth methods from the registry, not from a hardcoded UI table', async () => {
    const res = await supertest(app).get('/api/providers')
    const neonEntry = res.body.providers.find((p: any) => p.id === 'neon')
    // If the Neon provider gained/lost a method, this endpoint must follow.
    expect(neonEntry.authMethods).toHaveLength(2)
    expect(neonEntry.capabilities.length).toBeGreaterThan(0)
  })

  // --- database URL mode --------------------------------------------------

  it('rejects malformed URLs without leaking internals', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    for (const bad of ['not-a-url', 'mysql://u:p@db.example.com/x', 'postgresql://u:p@/x']) {
      const res = await agent.post('/api/connections/preview', { providerId: 'neon', connectionString: bad }, csrfToken)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+/)
    }
  })

  it('rejects non-Neon hosts (SSRF) and IP literals', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    // Loopback is excluded here: the dev override deliberately allows it, and
    // the production rejection is covered by security/netlib.test.ts.
    const attempts = [
      'postgresql://u:p@169.254.169.254/latest/meta-data',
      'postgresql://u:p@10.0.0.5:5432/db',
      'postgresql://u:p@192.168.1.10:5432/db',
      'postgresql://u:p@[::1]:5432/db',
      'postgresql://u:p@metadata.google.internal/db',
      'postgresql://u:p@evil.example.com/db',
    ]
    for (const connectionString of attempts) {
      const res = await agent.post('/api/connections/preview', { providerId: 'neon', connectionString }, csrfToken)
      expect(res.status, connectionString).toBeGreaterThanOrEqual(400)
      expect(res.status, connectionString).toBeLessThan(500)
    }
  })

  it('reports a bracketed IPv6 literal as a disallowed address, not a malformed host', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const res = await agent.post(
      '/api/connections/preview',
      { providerId: 'neon', connectionString: 'postgresql://u:p@[2001:db8::1]:5432/db' },
      csrfToken,
    )
    expect(res.body.error.code).toBe('CONNECTION_UNSUPPORTED_HOST')
    expect(res.body.error.message).toMatch(/IP address literals are not permitted/i)
  })

  it('names the rejected host but never the password, so the error is actionable', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const res = await agent.post(
      '/api/connections/preview',
      { providerId: 'neon', connectionString: 'postgresql://u:leak-me-not-1234@db.selfhosted.example/db' },
      csrfToken,
    )
    expect(res.status).toBe(400)
    // Actionable: the operator can see which host was refused.
    expect(res.body.error.message).toContain('db.selfhosted.example')
    // Still secret-free.
    expect(JSON.stringify(res.body)).not.toContain('leak-me-not-1234')
  })

  it('never echoes the credential or the raw URL back to the browser', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const secret = 'sup3r-s3cret-passw0rd'
    const res = await agent.post(
      '/api/connections/preview',
      { providerId: 'neon', connectionString: `postgresql://role_x:${secret}@ep-x.neon.tech/db?sslmode=require` },
      csrfToken,
    )
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(secret)
    expect(body).not.toContain('sslmode')
    expect(body).not.toContain('role_x')
  })

  it('is not reachable without a dashboard session', async () => {
    const res = await supertest(app).post('/api/connections/preview').send({
      providerId: 'neon',
      connectionString: 'postgresql://u:p@ep-x.neon.tech/db',
    })
    expect(res.status).toBe(401)
  })

  it('rejects a provider that is not enabled', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const res = await agent.post(
      '/api/connections/url',
      { providerId: 'mysql', connectionString: 'mysql://u:p@db.example.com/x' },
      csrfToken,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  // --- optional display name ---------------------------------------------

  it('validates the optional display name and never treats it as a credential', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const tooLong = await agent.post(
      '/api/connections/preview',
      { providerId: 'neon', connectionString: 'postgresql://u:p@ep-x.neon.tech/db', displayName: 'x'.repeat(65) },
      csrfToken,
    )
    expect(tooLong.status).toBe(400)

    const controlChars = await agent.post(
      '/api/connections/preview',
      { providerId: 'neon', connectionString: 'postgresql://u:p@ep-x.neon.tech/db', displayName: 'ok\nforged' },
      csrfToken,
    )
    expect(controlChars.status).toBe(400)
  })

  // --- provider API key mode ---------------------------------------------

  it('verifies an API key against the provider API before creating a session', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }))
    const creds = await seedUser(t.store, 'api-user')

    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_key_abc123xyz' }, csrfToken)

    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.auth).toBe('api')
    // The key is used server-side and must not come back.
    expect(JSON.stringify(res.body)).not.toContain('neon_key_abc123xyz')
    // A provider request really happened (proves verification is not a stub).
    expect(t.neon._requests.some((r) => r.path === '/users/me')).toBe(true)
  })

  it('answers database routes in API mode with FEATURE_UNAVAILABLE, never UNAUTHORIZED', async () => {
    // Regression: a 401 here told the client its session was gone, so the UI
    // dropped the operator back to the connect screen on the first click of any
    // data page — an API-key session that "logs out" when used.
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }))
    const creds = await seedUser(t.store, 'api-mode-user')

    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    const connected = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_mode_key' }, csrfToken)
    expect(connected.status).toBe(200)

    for (const path of ['/api/data/stats', '/api/data/tree', '/api/data/tables', '/api/data/roles']) {
      const res = await agent.get(path)
      expect(res.status, `${path} must not be 401`).toBe(403)
      expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE')
      expect(res.body.error.message).toMatch(/no database is attached/i)
    }

    // Control-plane routes still work, and the session is still alive.
    t.neon._setHandler('GET', '/projects', () => ({ projects: [] }))
    const projects = await agent.get('/api/control/projects')
    expect(projects.status).toBe(200)
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(true)
    expect(status.body.auth).toBe('api')
  })

  it('fails safely on an invalid API key without leaking the key', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => {
      // Mirrors what FetchNeonHttpClient throws for a rejected key.
      throw new NeonApiError({ message: 'Invalid API key', providerStatus: 401 })
    })
    const creds = await seedUser(t.store, 'api-user-2')

    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_bad_key_zzz' }, csrfToken)

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(JSON.stringify(res.body)).not.toContain('neon_bad_key_zzz')

    // No half-open session may survive a failed verification.
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(false)
  })

  it('surfaces a provider outage as an error, not as a successful connection', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => {
      throw new NeonApiError({ message: 'Provider unavailable', providerStatus: 503 })
    })
    const creds = await seedUser(t.store, 'api-user-3')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_key_outage' }, csrfToken)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(false)
  })

  it('does not treat an arbitrary non-empty API key as valid', async () => {
    const t = await makeTestApp()
    // No handlers registered: any provider request is unexpected and throws.
    const creds = await seedUser(t.store, 'api-user-4')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'anything-at-all' }, csrfToken)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(t.neon._seenKeys.size).toBeGreaterThan(0)
  })

  // --- session isolation --------------------------------------------------

  it('keeps connections isolated between two dashboard users', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [] }))
    const alice = await seedUser(t.store, 'alice')
    const bob = await seedUser(t.store, 'bob')

    const a = await login(t.app, alice.username, alice.password)
    const connected = await a.agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_alice_key' }, a.csrfToken)
    expect(connected.status).toBe(200)

    // Same browser jar is irrelevant: Bob's session is a different ref.
    const b = await login(t.app, bob.username, bob.password)
    const bobStatus = await b.agent.get('/api/connections/status')
    expect(bobStatus.body.connected).toBe(false)

    // And Alice's connection is still hers.
    const aliceStatus = await a.agent.get('/api/connections/status')
    expect(aliceStatus.body.connected).toBe(true)
  })

  it('closes the connection on disconnect', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [] }))
    const creds = await seedUser(t.store, 'disc-user')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_disc_key' }, csrfToken)
    expect((await agent.get('/api/connections/status')).body.connected).toBe(true)

    const out = await agent.post('/api/connections/disconnect', {}, csrfToken)
    expect(out.status).toBe(200)
    expect((await agent.get('/api/connections/status')).body.connected).toBe(false)
  })

  // --- dashboard account mode (unchanged behaviour) ----------------------

  it('still supports the existing dashboard account sign-in', async () => {
    const res = await supertest(app).post('/api/auth/login').send({ username: seed.username, password: seed.password })
    expect(res.status).toBe(200)
    expect(res.body.authenticated).toBe(true)
    expect(res.body.user.username).toBe(seed.username)
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|argon2|\$argon2/)
  })

  it('refuses to sign in with a wrong password', async () => {
    const res = await supertest(app).post('/api/auth/login').send({ username: seed.username, password: 'nope-nope-nope' })
    expect(res.status).toBe(401)
  })

  it('requires CSRF for connection mutations', async () => {
    const agent = new TestAgent(app)
    await agent.post('/api/auth/login', { username: seed.username, password: seed.password })
    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_key_no_csrf' })
    expect(res.status).toBe(403)
  })
})
