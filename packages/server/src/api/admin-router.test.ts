import { describe, it, expect, vi } from 'vitest'
import type { Request } from 'express'
import { makeTestApp, seedUser, login } from '../test/test-app.js'
import { originsFor } from './admin-router.js'

function fakeReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

describe('originsFor', () => {
  it('uses configured origins when present', () => {
    const req = fakeReq({ host: 'app.example', 'x-forwarded-proto': 'https' })
    expect(originsFor(req, ['https://api.example'])).toEqual(['https://api.example'])
  })

  it('falls back to the request origin when nothing is configured', () => {
    const req = fakeReq({ host: 'tunnel-1.dev', 'x-forwarded-proto': 'https' })
    expect(originsFor(req, [])).toEqual(['https://tunnel-1.dev'])
  })

  it('drops non-http(s) origins and credentials', () => {
    const req = fakeReq({ host: 'h.example', 'x-forwarded-proto': 'https' })
    expect(originsFor(req, ['ftp://x', 'https://user:pass@h.example'])).toEqual([])
  })

  it('deduplicates repeated origins', () => {
    const req = fakeReq({ host: 'h.example', 'x-forwarded-proto': 'https' })
    expect(originsFor(req, ['https://a.example', 'https://a.example'])).toEqual(['https://a.example'])
  })
})

describe('admin router', () => {
  it('gates the admin API to the admin role', async () => {
    const t = await makeTestApp()
    const hash = await t.auth.hashPassword('ordinary-password-123!')
    t.store.createUser('nonadmin', hash, 'user')
    const { agent } = await login(t.app, 'nonadmin', 'ordinary-password-123!')
    const res = await agent.get('/api/admin/users')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('creates and lists accounts as an admin', async () => {
    const t = await makeTestApp()
    const creds = await seedUser(t.store, 'admin-provisioner')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    const created = await agent.post(
      '/api/admin/users',
      { username: 'newops', password: 'a-long-password-here' },
      csrfToken,
    )
    expect(created.status).toBe(200)
    expect(created.body.user.username).toBe('newops')
    expect(created.body.user.mustChangePassword).toBe(true)

    const list = await agent.get('/api/admin/users')
    expect(list.status).toBe(200)
    const names = list.body.users.map((u: { username: string }) => u.username)
    expect(names).toContain('newops')
  })

  it('rejects duplicate usernames with 409', async () => {
    const t = await makeTestApp()
    const creds = await seedUser(t.store, 'dup-admin')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    await agent.post('/api/admin/users', { username: 'dupe', password: 'a-long-password-here' }, csrfToken)
    const dup = await agent.post(
      '/api/admin/users',
      { username: 'dupe', password: 'another-long-password' },
      csrfToken,
    )
    expect(dup.status).toBe(409)
  })

  it('probes configured origins and reports the result', async () => {
    const t = await makeTestApp({ adminApiOrigins: ['https://origin-a.test'] })
    const creds = await seedUser(t.store, 'probe-admin')
    const { agent } = await login(t.app, creds.username, creds.password)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await agent.get('/api/admin/checks')
      expect(res.status).toBe(200)
      expect(res.body.checks).toHaveLength(1)
      expect(res.body.checks[0].origin).toBe('https://origin-a.test')
      expect(res.body.checks[0].ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledWith('https://origin-a.test/api/healthz', expect.anything())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})