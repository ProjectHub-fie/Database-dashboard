import { describe, it, expect } from 'vitest'
import { projectStatusFromEndpoints } from './control-plane-router.js'
import { makeTestApp, seedUser, login } from '../test/test-app.js'
import { NeonApiError } from '../providers/neon/client.js'

describe('projectStatusFromEndpoints', () => {
  it('returns not-ready when there are no endpoints', () => {
    expect(projectStatusFromEndpoints([])).toBe('not-ready')
  })

  it('picks paused over active', () => {
    expect(projectStatusFromEndpoints([{ state: 'active' }, { state: 'paused' }])).toBe('paused')
  })

  it('picks provisioning over idle', () => {
    expect(projectStatusFromEndpoints([{ state: 'idle' }, { state: 'provisioning' }])).toBe('provisioning')
  })

  it('returns active for an all-active project', () => {
    expect(projectStatusFromEndpoints([{ state: 'active' }, { state: 'ready' }])).toBe('active')
  })

  it('ranks unknown states below known informational states', () => {
    expect(projectStatusFromEndpoints([{ state: 'mysterious' }, { state: 'idle' }])).toBe('idle')
    expect(projectStatusFromEndpoints([{ state: 'mysterious' }])).toBe('mysterious')
  })

  it('is case-insensitive', () => {
    expect(projectStatusFromEndpoints([{ state: 'PAUSED' }])).toBe('paused')
  })
})

describe('GET /api/control/projects status badge (Neon)', () => {
  it('attaches an aggregate endpoint status to each project', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/projects', () => ({
      projects: [
        {
          id: 'paused-proj',
          name: 'Paused',
          region_id: 'aws-us-east-1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
        {
          id: 'live-proj',
          name: 'Live',
          region_id: 'aws-us-east-1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    }))
    t.neon._setHandler('GET', '/projects/:projectId/endpoints', (_body, params) => ({
      endpoints: [
        {
          id: `ep-${params.projectId}`,
          branch_id: 'br-1',
          current_state: params.projectId === 'paused-proj' ? 'paused' : 'active',
          type: 'read_write',
        },
      ],
    }))
    const creds = await seedUser(t.store, 'status-route-user')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    const connected = await agent.post(
      '/api/connections/api',
      { providerId: 'neon', apiKey: 'neon_status_key' },
      csrfToken,
    )
    expect(connected.status).toBe(200)

    const res = await agent.get('/api/control/projects')
    expect(res.status).toBe(200)
    expect(res.body.projects).toHaveLength(2)
    const byId = new Map(res.body.projects.map((p: { id: string }) => [p.id, p]))
    expect(byId.get('paused-proj')!.status).toBe('paused')
    expect(byId.get('live-proj')!.status).toBe('active')
  })

  it('keeps projects usable when an endpoints lookup fails (best-effort badge)', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/projects', () => ({ projects: [{ id: 'p1', name: 'A' }] }))
    t.neon._setHandler('GET', '/projects/:projectId/endpoints', () => {
      throw new NeonApiError({ message: 'gone', providerStatus: 404 })
    })
    const creds = await seedUser(t.store, 'status-route-user-2')
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)
    await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_status_key_2' }, csrfToken)
    const res = await agent.get('/api/control/projects')
    expect(res.status).toBe(200)
    expect(res.body.projects[0].id).toBe('p1')
    expect(res.body.projects[0].status).toBeUndefined()
  })
})