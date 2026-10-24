import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login, TestAgent } from '../test/test-app.js'

describe('Application authentication and authorization', () => {
  let app: Express
  let seed: { username: string; password: string }

  beforeAll(async () => {
    const t = await makeTestApp()
    app = t.app
    seed = await seedUser(t.store)
  })

  it('rejects unauthenticated access to dashboard routes', async () => {
    const res = await supertest(app).get('/api/connections/status')
    expect(res.status).toBe(401)
    expect(res.body.error).toBeDefined()
  })

  it('logs in with a valid password and sets HttpOnly + SameSite cookies', async () => {
    const res = await supertest(app).post('/api/auth/login').send({ username: seed.username, password: seed.password })
    expect(res.status).toBe(200)
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? []
    const sid = cookies.find((c) => c.startsWith('dbh_sid=')) ?? ''
    expect(sid).toContain('HttpOnly')
    expect(sid).toMatch(/SameSite=Lax/i)
    const csrf = cookies.find((c) => c.startsWith('dbh_csrf=')) ?? ''
    expect(csrf).not.toContain('HttpOnly')
  })

  it('rejects wrong password with a generic message (no user enumeration)', async () => {
    const bad = await supertest(app).post('/api/auth/login').send({ username: 'ghost-user-xyz', password: 'whatever-123' })
    const good = await supertest(app).post('/api/auth/login').send({ username: seed.username, password: 'wrong-wrong-wrong' })
    expect(bad.status).toBe(401)
    expect(good.status).toBe(401)
    expect(bad.body.error.message).toBe('Invalid username or password')
    expect(good.body.error.message).toBe('Invalid username or password')
  })

  it('requires CSRF token for state-changing requests', async () => {
    const agent = new TestAgent(app)
    await agent.post('/api/auth/login', { username: seed.username, password: seed.password })
    const res = await agent.post('/api/auth/logout', {})
    expect(res.status).toBe(403)
  })

  it('never exposes password hashes or roles in /api/auth/me', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'no-leak', 'password-123456!')
    const { agent } = await login(t.app, seed.username, seed.password)
    const res = await agent.get('/api/auth/me')
    expect(res.status).toBe(200)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('passwordHash')
    expect(raw).not.toContain('$argon2')
    expect(raw).not.toContain('"role"')
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      username: 'no-leak',
      mustChangePassword: true,
    })
  })

  it('prevents cross-user session access', async () => {
    const t = await makeTestApp()
    const seedA = await seedUser(t.store, 'alice', 'alice-password-123!')
    const seedB = await seedUser(t.store, 'bob', 'bob-password-456!')
    const { agent: agentA, csrfToken: csrfA } = await login(t.app, seedA.username, seedA.password)
    const { agent: agentB } = await login(t.app, seedB.username, seedB.password)

    t.neon._setHandler('GET', '/users/me', () => ({ id: 'acct-1' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [{ id: 'org-1', name: 'Org' }] }))
    const conn = await agentA.post('/api/connections/api', { providerId: 'neon', apiKey: 'SOME_API_KEY' }, csrfA)
    expect(conn.status).toBe(200)

    // Alice can see her connected status; Bob cannot (session isolation).
    const statusA = await agentA.get('/api/connections/status')
    expect(statusA.body.connected).toBe(true)
    const statusB = await agentB.get('/api/connections/status')
    expect(statusB.body.connected).toBe(false)
  })

  it('logout revokes the dashboard session and closes its connection', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'logout-user', 'logout-password-123!')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'acct-1' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [] }))
    await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'SOME_API_KEY' }, csrfToken)

    expect(t.sessions.count()).toBeGreaterThan(0)
    const logout = await agent.post('/api/auth/logout', {}, csrfToken)
    expect(logout.status).toBe(200)
    expect(t.sessions.count()).toBe(0)
    const me = await agent.get('/api/auth/me')
    expect(me.body.authenticated).toBe(false)
  })
})

describe('Recent reauthentication for destructive actions', () => {
  it('blocks the delete endpoint until POST /api/auth/reauth succeeds', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'reauth-user', 'reauth-password-123!')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    const user = t.store.getUserByUsername('reauth-user')
    const sessions = t.store.listUserSessions(user!.id)
    const sessionId = sessions[0]?.id
    expect(sessionId).toBeTruthy()
    // 1. Rewind only the reauth clock past the TTL (last_seen stays fresh so
    // the session isn't idle-revoked).
    t.store.setSessionReauthAt(String(sessionId), Date.now() - 60 * 60 * 1000)

    t.neon._setHandler('GET', '/users/me', () => ({ id: 'acct-1' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [] }))
    t.neon._setHandler('GET', '/projects', () => ({ projects: [] }))
    t.neon._setHandler('GET', '/projects/p1/branches', () => ({ branches: [] }))
    t.neon._setHandler('GET', '/projects/p1/databases', () => ({ databases: [] }))
    t.neon._setHandler('DELETE', '/projects/p1', () => ({ operations: [{ id: 'op1', status: 'finished', action: 'delete_project' }] }))
    await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'SOME_API_KEY' }, csrfToken)

    // 2. Delete without recent reauth → 401 NEEDS_REAUTH (re-auth blocked).
    const denied = await agent.delete('/api/control/projects/p1?confirm=p1', csrfToken)
    expect(denied.status).toBe(401)
    expect(denied.body.error.code).toBe('NEEDS_REAUTH')

    // 3. Reauthenticate, then the delete succeeds.
    const reauth = await agent.post('/api/auth/reauth', { password: seed.password }, csrfToken)
    expect(reauth.status).toBe(200)
    expect(reauth.body.ok).toBe(true)
    const okDelete = await agent.delete('/api/control/projects/p1?confirm=p1', csrfToken)
    expect(okDelete.status).toBe(200)
    expect(okDelete.body.operation).toBeDefined()
  })
})

describe('Dashboard password rotation', () => {
  it('changes the password, clears mustChangePassword, and revokes other sessions', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'rotate-user', 'initial-password-123!')
    const first = await login(t.app, seed.username, seed.password)
    const second = await login(t.app, seed.username, seed.password)

    // A brand-new account is flagged until the operator rotates the password.
    const me = await first.agent.get('/api/auth/me')
    expect(me.body.user.mustChangePassword).toBe(true)

    const res = await first.agent.post(
      '/api/auth/change-password',
      { currentPassword: seed.password, newPassword: 'brand-new-password-456!' },
      first.csrfToken,
    )
    expect(res.status).toBe(200)

    // The active session survives; the other session is revoked.
    const stillMe = await first.agent.get('/api/auth/me')
    expect(stillMe.body.authenticated).toBe(true)
    expect(stillMe.body.user.mustChangePassword).toBe(false)
    const other = await second.agent.get('/api/auth/me')
    expect(other.body.authenticated).toBe(false)

    // Old credentials no longer work; the new ones do.
    const oldLogin = await new TestAgent(t.app).post('/api/auth/login', {
      username: seed.username,
      password: seed.password,
    })
    expect(oldLogin.status).toBe(401)
    const newLogin = await new TestAgent(t.app).post('/api/auth/login', {
      username: seed.username,
      password: 'brand-new-password-456!',
    })
    expect(newLogin.status).toBe(200)
  })

  it('rejects a wrong current password and short new passwords', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'rotate-user-2', 'initial-password-123!')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)

    const wrong = await agent.post(
      '/api/auth/change-password',
      { currentPassword: 'not-the-password', newPassword: 'another-password-789!' },
      csrfToken,
    )
    expect(wrong.status).toBe(401)

    const short = await agent.post(
      '/api/auth/change-password',
      { currentPassword: seed.password, newPassword: 'too-short' },
      csrfToken,
    )
    expect(short.status).toBe(400)
    expect(short.body.error.code).toBe('BAD_REQUEST')
  })
})
