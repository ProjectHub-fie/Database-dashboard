import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login, MockNeonHttpClient } from '../test/test-app.js'
import { NeonApiError } from '../providers/neon/client.js'

/**
 * API-key mode with an attached database.
 *
 * Two external systems are faked, nothing else:
 *  - DNS, so a fake `*.neon.tech` host can be resolved to a public address
 *    (the host allowlist, private-range rejection and socket pinning under test
 *    all still run for real).
 *  - the `pg` client, so no socket is opened. The attach route's decision-making
 *    — URI handling, redaction, session state — is the real code path.
 */
vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: async () => ['18.0.0.1'],
    resolve6: async () => [],
  },
}))

const connectCalls: Array<{ password: string; host: string; database: string }> = []

vi.mock('../adapters/postgres.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/postgres.js')>('../adapters/postgres.js')
  return {
    ...actual,
    buildPgClient: (opts: {
      host: string
      port: number
      database: string
      role: string
      password: string
      pinnedAddress: string
    }) => {
      connectCalls.push({ password: opts.password, host: opts.host, database: opts.database })
      if (opts.password === 'wrong-password') {
        return {
          connect: async () => {
            throw Object.assign(new Error('password authentication failed'), { code: '28P01' })
          },
          end: async () => undefined,
          connection: { stream: () => undefined },
        }
      }
      return {
        connect: async () => undefined,
        end: async () => undefined,
        query: async () => ({ rows: [], fields: [], command: 'SELECT', rowCount: 0 }),
        connection: { stream: () => undefined },
      }
    },
  }
})

const NEON_URI = 'postgresql://neondb_owner:super-secret-value@ep-attach-123.us-east-2.aws.neon.tech/neondb?sslmode=require'

describe('API-key mode: attaching a database', () => {
  let app: Express
  let neon: MockNeonHttpClient
  let seed: { username: string; password: string }

  beforeAll(async () => {
    const t = await makeTestApp()
    app = t.app
    neon = t.neon
    seed = await seedUser(t.store, 'attach-user')
    neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [{ id: 'org-1', name: 'Acme' }] }))
    neon._setHandler('GET', '/projects/:projectId', () => ({
      project: { id: 'proj-1', name: 'Acme Prod', region_id: 'aws-us-east-2' },
    }))
    neon._setHandler('GET', '/projects/:projectId/branches', () => ({
      branches: [{ id: 'br-main', name: 'main', primary: true }],
    }))
  })

  async function connectedAgent() {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_attach_key' }, csrfToken)
    expect(res.status).toBe(200)
    return { agent, csrfToken }
  }

  it('opens a real SQL session and returns no credential material', async () => {
    connectCalls.length = 0
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({ uri: NEON_URI }))
    const { agent, csrfToken } = await connectedAgent()

    // Before attaching, database routes are correctly unavailable.
    const before = await agent.get('/api/data/tree')
    expect(before.body.error.code).toBe('FEATURE_UNAVAILABLE')

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )

    expect(res.status).toBe(200)
    expect(res.body.accountOnly).toBe(false)
    expect(res.body.metadata.database).toBe('neondb')
    expect(res.body.metadata.role).toBe('neondb_owner')
    expect(res.body.metadata.projectName).toBe('Acme Prod')
    expect(res.body.metadata.branchName).toBe('main')

    // The URI carries the password: it must not survive the boundary.
    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain('super-secret-value')
    expect(wire).not.toContain(NEON_URI)
    expect(wire).not.toContain('sslmode')

    // The credential was used server-side to open the connection.
    expect(connectCalls).toHaveLength(1)
    expect(connectCalls[0]!.password).toBe('super-secret-value')

    // Control-plane features survive: auth stays 'api'.
    const status = await agent.get('/api/connections/status')
    expect(status.body.auth).toBe('api')
    expect(status.body.accountOnly).toBe(false)
    expect(status.body.capabilities.capabilities).toContain('sql.basic')
    expect(status.body.capabilities.capabilities).toContain('control.listProjects')

    // The previously blocked routes are now served by the live session.
    const tree = await agent.get('/api/data/tree')
    expect(tree.status).toBe(200)
  })

  it('fails safely when the provider will not issue a URI', async () => {
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => {
      throw new NeonApiError({ message: 'Forbidden', providerStatus: 403 })
    })
    const { agent, csrfToken } = await connectedAgent()

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value')

    // A failed attach must not leave a half-open session pretending to be connected.
    const status = await agent.get('/api/connections/status')
    expect(status.body.accountOnly).toBe(true)
  })

  it('reports a bad credential as a permission error without echoing it', async () => {
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({
      uri: 'postgresql://neondb_owner:wrong-password@ep-attach-123.us-east-2.aws.neon.tech/neondb',
    }))
    const { agent, csrfToken } = await connectedAgent()

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(res.body)).not.toContain('wrong-password')
  })

  it('rejects an unapproved host even when the provider returns it', async () => {
    // A compromised or misconfigured control plane must not become an SSRF
    // primitive: the URI is validated exactly like a pasted URL.
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({
      uri: 'postgresql://u:super-secret-value@internal.example.com:5432/neondb',
    }))
    const { agent, csrfToken } = await connectedAgent()

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CONNECTION_UNSUPPORTED_HOST')
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value')
  })

  it('rejects a private-network destination', async () => {
    const dns = await import('node:dns/promises')
    const spy = vi.spyOn(dns.default, 'resolve4').mockResolvedValueOnce(['10.0.0.5'])
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({ uri: NEON_URI }))
    const { agent, csrfToken } = await connectedAgent()

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CONNECTION_UNSUPPORTED_HOST')
    spy.mockRestore()
  })

  it('validates identifiers and requires a CSRF token', async () => {
    const { agent, csrfToken } = await connectedAgent()

    const badIdent = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb; DROP TABLE x' },
      csrfToken,
    )
    expect(badIdent.status).toBe(400)

    const noCsrf = await agent.post('/api/connections/database', {
      projectId: 'proj-1',
      branchId: 'br-main',
      databaseName: 'neondb',
    })
    expect(noCsrf.status).toBe(403)
  })

  it('refuses to attach from a database-URL session', async () => {
    const { agent, csrfToken } = await login(app, seed.username, seed.password)
    const url = await agent.post(
      '/api/connections/url',
      {
        providerId: 'neon',
        connectionString: 'postgresql://neondb_owner:url-mode-pass@ep-url-1.us-east-2.aws.neon.tech/neondb',
      },
      csrfToken,
    )
    expect(url.status).toBe(200)

    const res = await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('detaches back to management-only without dropping the API key', async () => {
    neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({ uri: NEON_URI }))
    const { agent, csrfToken } = await connectedAgent()
    await agent.post(
      '/api/connections/database',
      { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
      csrfToken,
    )

    const res = await agent.post('/api/connections/database/detach', {}, csrfToken)
    expect(res.status).toBe(200)
    expect(res.body.accountOnly).toBe(true)

    // The control plane still works, the SQL surface is gone again.
    neon._setHandler('GET', '/projects', () => ({ projects: [] }))
    const projects = await agent.get('/api/control/projects')
    expect(projects.status).toBe(200)
    const tree = await agent.get('/api/data/tree')
    expect(tree.body.error.code).toBe('FEATURE_UNAVAILABLE')
  })

  /**
   * `connection_uri` takes `role_name` and fails later with an opaque auth
   * error for anything it does not like, so the attach route validates the
   * choice against the branch's real roles first.
   */
  describe('role selection', () => {
    // `connectCalls` is shared across the file; without this the assertions
    // below would read a connection opened by an earlier test.
    beforeEach(() => {
      connectCalls.length = 0
    })

    const ROLES = {
      roles: [
        { name: 'neondb_owner', branch_id: 'br-main', protected: false, authentication_method: 'password' },
        { name: 'app_reader', branch_id: 'br-main', protected: false, authentication_method: 'password' },
        { name: 'ci_nologin', branch_id: 'br-main', protected: true, authentication_method: 'no_login' },
      ],
    }

    it('opens the session as the requested role', async () => {
      neon._setHandler('GET', '/projects/:projectId/branches/:branchId/roles', () => ROLES)
      neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({
        uri: 'postgresql://app_reader:reader-secret@ep-attach-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
      }))
      const { agent, csrfToken } = await connectedAgent()

      const res = await agent.post(
        '/api/connections/database',
        { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb', role: 'app_reader' },
        csrfToken,
      )

      expect(res.status).toBe(200)
      expect(res.body.metadata.role).toBe('app_reader')
      expect(connectCalls[0]!.password).toBe('reader-secret')
      expect(JSON.stringify(res.body)).not.toContain('reader-secret')
    })

    it('rejects a role that does not exist on the branch before calling connection_uri', async () => {
      neon._setHandler('GET', '/projects/:projectId/branches/:branchId/roles', () => ROLES)
      const { agent, csrfToken } = await connectedAgent()

      const res = await agent.post(
        '/api/connections/database',
        { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb', role: 'ghost_role' },
        csrfToken,
      )

      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('BAD_REQUEST')
      expect(res.body.error.message).toContain('ghost_role')
      expect(connectCalls).toHaveLength(0)
      // No half-open session left behind.
      const status = await agent.get('/api/connections/status')
      expect(status.body.accountOnly).toBe(true)
    })

    it('refuses a passwordless role and explains how to fix it', async () => {
      neon._setHandler('GET', '/projects/:projectId/branches/:branchId/roles', () => ROLES)
      const { agent, csrfToken } = await connectedAgent()

      const res = await agent.post(
        '/api/connections/database',
        { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb', role: 'ci_nologin' },
        csrfToken,
      )

      expect(res.status).toBe(400)
      expect(res.body.error.message).toContain('no_login')
      // The message has to tell the operator what to do next.
      expect(res.body.error.message.toLowerCase()).toContain('reset')
      expect(connectCalls).toHaveLength(0)
    })

    it('reports an actionably when the URI comes back without a password', async () => {
      neon._setHandler('GET', '/projects/:projectId/branches/:branchId/roles', () => ROLES)
      neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({
        uri: 'postgresql://app_reader@ep-attach-123.us-east-2.aws.neon.tech/neondb',
      }))
      const { agent, csrfToken } = await connectedAgent()

      const res = await agent.post(
        '/api/connections/database',
        { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb', role: 'app_reader' },
        csrfToken,
      )

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.body.error.message.toLowerCase()).toContain('password')
      expect(connectCalls).toHaveLength(0)
    })

    it('still attaches without a role when the provider list is unavailable', async () => {
      // Backward compatible: an older/limited provider that cannot list roles
      // must not be blocked from the flow that already worked.
      neon._setHandler('GET', '/projects/:projectId/connection_uri', () => ({ uri: NEON_URI }))
      const { agent, csrfToken } = await connectedAgent()

      const res = await agent.post(
        '/api/connections/database',
        { projectId: 'proj-1', branchId: 'br-main', databaseName: 'neondb' },
        csrfToken,
      )
      expect(res.status).toBe(200)
      expect(res.body.metadata.role).toBe('neondb_owner')
    })
  })

  it('is not reachable without a dashboard session', async () => {
    const res = await supertest(app).post('/api/connections/database').send({
      projectId: 'proj-1',
      branchId: 'br-main',
      databaseName: 'neondb',
    })
    expect(res.status).toBe(401)
  })
})
