import { describe, expect, it, beforeAll } from 'vitest'
import type { Express } from 'express'
import { makeTestApp, TestAgent } from '../test/test-app.js'

/**
 * The browser client distinguishes "this API route does not exist" from "the
 * hosting platform never built the API" purely by content type: the former must
 * be the JSON envelope, the latter is an HTML page. Express's default 404 is
 * HTML, so an unmatched `/api` route used to look exactly like a broken
 * deployment and surfaced as a bare "Request failed (404)".
 */
describe('API 404 contract', () => {
  let app: Express
  let agent: TestAgent

  beforeAll(async () => {
    const t = await makeTestApp({ authRequired: false })
    app = t.app
    agent = new TestAgent(app)
  })

  it('answers an unmatched /api route with the JSON envelope, not HTML', async () => {
    const res = await agent.get('/api/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(String(res.headers['content-type'])).toContain('application/json')
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND')
    expect(res.body.error.message).toContain('/api/definitely-not-a-route')
  })

  it('names the method so a wrong verb is obvious at a glance', async () => {
    // `/api/schema/tables` is POST-only; a GET is a routing mistake, not a
    // missing feature, and the message has to say so.
    const res = await agent.get('/api/schema/tables')
    expect(res.status).toBe(404)
    expect(res.body.error.message).toMatch(/^No API route for GET /)
  })

  it('never leaks an HTML body from an unknown API path', async () => {
    const res = await agent.get('/api/../../etc/passwd')
    expect(String(res.headers['content-type'] ?? '')).not.toContain('text/html')
  })

  it('exposes the health probe through the /api prefix the deployments use', async () => {
    // Vercel proxies only /api/*, so the probe must exist under that prefix to
    // prove the proxy function and the upstream API are both alive.
    const res = await agent.get('/api/healthz')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
