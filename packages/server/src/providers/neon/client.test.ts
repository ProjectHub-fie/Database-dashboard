import { describe, expect, it } from 'vitest'
import { NeonApiError, NeonControlPlane, type NeonHttpClient } from './client.js'

/** Records calls and answers per-path, so ordering is observable. */
function fakeHttp(handlers: Record<string, () => unknown>) {
  const calls: string[] = []
  const http: NeonHttpClient = {
    async request<T>(opts: { method: string; path: string }): Promise<T> {
      calls.push(`${opts.method} ${opts.path}`)
      const handler = handlers[opts.path]
      if (!handler) throw new Error(`unexpected path ${opts.path}`)
      return (await handler()) as T
    },
  }
  return { http, calls }
}

const err = (providerStatus: number) =>
  new NeonApiError({ message: 'x', providerStatus, detail: 'x' })

/**
 * Neon refuses `GET /users/me` for organization API keys with
 * `404 not allowed for organization API keys`. Treating that as a bad
 * credential rejected every org-scoped key, which is the least-privilege kind.
 */
describe('NeonControlPlane.validateApiKey', () => {
  it('accepts an organization-scoped key that cannot read /users/me', async () => {
    const { http, calls } = fakeHttp({
      '/users/me': () => {
        throw err(404)
      },
      '/projects': () => ({ projects: [] }),
    })
    const result = await new NeonControlPlane('napi_org', http).validateApiKey()

    expect(result.organizationScoped).toBe(true)
    expect(result.organizations).toEqual([])
    expect(calls).toContain('GET /projects')
  })

  it('still rejects an invalid key on 401 and never falls through to /projects', async () => {
    const { http, calls } = fakeHttp({
      '/users/me': () => {
        throw err(401)
      },
    })
    await expect(new NeonControlPlane('napi_bad', http).validateApiKey()).rejects.toMatchObject({
      providerStatus: 401,
    })
    expect(calls).not.toContain('GET /projects')
  })

  it('validates an org-scoped key through /projects, so a dead key cannot pass', async () => {
    const { http } = fakeHttp({
      '/users/me': () => {
        throw err(404)
      },
      '/projects': () => {
        throw err(401)
      },
    })
    await expect(new NeonControlPlane('napi_revoked', http).validateApiKey()).rejects.toMatchObject({
      providerStatus: 401,
    })
  })

  it('returns personal organizations for a user key', async () => {
    const { http } = fakeHttp({
      '/users/me': () => ({ id: 'user-1' }),
      '/users/me/organizations': () => ({
        organizations: [{ id: 'org-1', name: 'Acme', handle: 'acme' }],
      }),
    })
    const result = await new NeonControlPlane('napi_user', http).validateApiKey()

    expect(result.accountId).toBe('user-1')
    expect(result.organizationScoped).toBeUndefined()
    expect(result.organizations?.map((o) => o.id)).toEqual(['org-1'])
  })

  it('treats an unreadable organization list as empty rather than fatal', async () => {
    const { http } = fakeHttp({
      '/users/me': () => ({ id: 'user-1' }),
      '/users/me/organizations': () => {
        throw err(403)
      },
    })
    const result = await new NeonControlPlane('napi_user', http).validateApiKey()
    expect(result.organizations).toEqual([])
  })
})

describe('NeonControlPlane.listOrganizations', () => {
  it('returns an empty list for organization-scoped keys', async () => {
    const { http } = fakeHttp({
      '/users/me/organizations': () => {
        throw err(404)
      },
    })
    await expect(new NeonControlPlane('napi_org', http).listOrganizations()).resolves.toEqual([])
  })
})

/**
 * Roles are branch-scoped in Neon: `GET /projects/{id}/branches/{bid}/roles`.
 * The attach flow needs the real list because `connection_uri` requires a
 * `role_name` and gives no way to discover one.
 */
describe('NeonControlPlane.listRoles', () => {
  it('lists roles for the given branch and normalizes authentication_method', async () => {
    const { http, calls } = fakeHttp({
      '/projects/p1/branches/br-1/roles': () => ({
        roles: [
          { name: 'neondb_owner', branch_id: 'br-1', protected: false, authentication_method: 'password' },
          { name: 'app_reader', branch_id: 'br-1', protected: false, authentication_method: 'password' },
          { name: 'ci_nologin', branch_id: 'br-1', protected: true, authentication_method: 'no_login' },
        ],
      }),
    })
    const roles = await new NeonControlPlane('napi_x', http).listRoles({ projectId: 'p1', branchId: 'br-1' })

    expect(calls).toEqual(['GET /projects/p1/branches/br-1/roles'])
    expect(roles.map((r) => r.name)).toEqual(['neondb_owner', 'app_reader', 'ci_nologin'])
    expect(roles[0].authenticationMethod).toBe('password')
    // The passwordless role must be distinguishable so the UI can refuse it.
    expect(roles[2].authenticationMethod).toBe('no_login')
    expect(roles[2].protected).toBe(true)
  })

  it('defaults branchId from the request when the API omits it', async () => {
    const { http } = fakeHttp({
      '/projects/p1/branches/br-9/roles': () => ({ roles: [{ name: 'r' }] }),
    })
    const roles = await new NeonControlPlane('napi_x', http).listRoles({ projectId: 'p1', branchId: 'br-9' })
    expect(roles[0].branchId).toBe('br-9')
  })

  it('returns an empty list rather than throwing when a branch has no roles', async () => {
    const { http } = fakeHttp({ '/projects/p1/branches/br-2/roles': () => ({}) })
    await expect(
      new NeonControlPlane('napi_x', http).listRoles({ projectId: 'p1', branchId: 'br-2' }),
    ).resolves.toEqual([])
  })

  it('never puts the role password in the normalized output', async () => {
    const { http } = fakeHttp({
      '/projects/p1/branches/br-1/roles': () => ({
        roles: [{ name: 'neondb_owner', branch_id: 'br-1', authentication_method: 'password', password: 'super-secret' }],
      }),
    })
    const roles = await new NeonControlPlane('napi_x', http).listRoles({ projectId: 'p1', branchId: 'br-1' })
    expect(JSON.stringify(roles)).not.toContain('super-secret')
  })
})
