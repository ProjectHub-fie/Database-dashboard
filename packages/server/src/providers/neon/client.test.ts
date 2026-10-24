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
