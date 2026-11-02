import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login } from '../test/test-app.js'

/**
 * MongoDB Atlas connection-mode tests through the public API. The Atlas HTTP
 * and OAuth layers are mocked; no real network is contacted.
 */
describe('MongoDB Atlas connection modes', () => {
  let app: Express

  beforeAll(async () => {
    app = (await makeTestApp()).app
  })

  it('advertises MongoDB Atlas in the provider catalog with both auth methods', async () => {
    const res = await supertest(app).get('/api/providers')
    expect(res.status).toBe(200)
    const entry = res.body.providers.find((p: any) => p.id === 'mongodb-atlas')
    expect(entry).toBeDefined()
    expect(entry.available).toBe(true)
    expect(entry.authMethods).toEqual(expect.arrayContaining(['connection', 'api']))
    expect(entry.controlPlane).toBe(true)
  })

  it('connects with a service-account API key (clientId:secret)', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-api-user')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)

    const res = await agent.post(
      '/api/connections/api',
      { providerId: 'mongodb-atlas', apiKey: 'client-1:secret-1' },
      csrfToken,
    )
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.auth).toBe('api')
    expect(res.body.accountOnly).toBe(true)
    expect(res.body.metadata.host).toBe('cloud.mongodb.com')
    // The OAuth exchange really ran with the split credential.
    expect(t.atlasOauth._exchanges).toHaveLength(1)
    expect(t.atlasOauth._exchanges[0]).toEqual({ clientId: 'client-1', clientSecret: 'secret-1' })
    expect(JSON.stringify(res.body)).not.toContain('client-1')
    expect(JSON.stringify(res.body)).not.toContain('secret-1')
  })

  it('answers control-plane routes for a Mongo API-key session', async () => {
    const t = await makeTestApp()
    t.atlas._setHandler('GET', '/groups', () => ({
      results: [{ id: 'grp-1', name: 'Mongo Project', orgId: 'org-1' }],
    }))
    t.atlas._setHandler('GET', '/orgs', () => ({
      results: [{ id: 'org-1', name: 'Acme' }],
    }))
    const seed = await seedUser(t.store, 'mongo-api-user-2')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    await agent.post('/api/connections/api', { providerId: 'mongodb-atlas', apiKey: 'cid:secret' }, csrfToken)
    const projects = await agent.get('/api/control/projects')
    expect(projects.status).toBe(200)
    expect(projects.body.projects[0].name).toBe('Mongo Project')

    const orgs = await agent.get('/api/control/organizations')
    expect(orgs.status).toBe(200)
    expect(orgs.body.organizations[0].name).toBe('Acme')
  })

  it('never answers database routes in Mongo API mode with UNAUTHORIZED', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-api-user-3')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    await agent.post('/api/connections/api', { providerId: 'mongodb-atlas', apiKey: 'cid:secret' }, csrfToken)

    for (const path of ['/api/data/stats', '/api/data/tree', '/api/data/tables', '/api/data/roles']) {
      const res = await agent.get(path)
      expect(res.status, `${path} must not be 401`).toBe(403)
      expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE')
    }
  })

  it('rejects a raw API key without the clientId:secret shape', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-api-user-4')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    const res = await agent.post('/api/connections/api', { providerId: 'mongodb-atlas', apiKey: 'notapair' }, csrfToken)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(false)
  })

  it('rejects a Mongo URL for a disallowed host through preview', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-preview-user')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    const res = await agent.post(
      '/api/connections/preview',
      { providerId: 'mongodb-atlas', connectionString: 'mongodb://u:p@private.internal/foo' },
      csrfToken,
    )
    expect(res.status).toBe(400)
  })

  it('reports invalid service-account credentials as a safe 4xx without leaking the secret', async () => {
    const t = await makeTestApp()
    t.atlasOauth.failNext()
    const seed = await seedUser(t.store, 'mongo-bad-cred')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    const res = await agent.post(
      '/api/connections/api',
      { providerId: 'mongodb-atlas', apiKey: 'client-1:wrong-secret' },
      csrfToken,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(JSON.stringify(res.body)).not.toContain('wrong-secret')
    expect(JSON.stringify(res.body)).not.toContain('client-1')
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(false)
  })

  it('keeps control-plane-only capabilities when Mongo connects via API key', async () => {
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-caps-user')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)
    await agent.post('/api/connections/api', { providerId: 'mongodb-atlas', apiKey: 'cid:secret' }, csrfToken)
    const status = await agent.get('/api/connections/status')
    expect(status.body.connected).toBe(true)
    // control capability survives, sql does not.
    expect(status.body.capabilities.capabilities).toContain('control.listProjects')
    expect(status.body.capabilities.capabilities).not.toContain('sql.basic')
  })
})