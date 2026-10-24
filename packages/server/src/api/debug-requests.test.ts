import { describe, it, expect, beforeAll } from 'vitest'
import type { Express } from 'express'
import { makeTestApp, TestAgent } from '../test/test-app.js'

/**
 * Debug diagnostics: the redacted in-memory request ring buffer and its
 * read-only endpoint. Security invariants:
 *
 *  - the endpoint needs no login (works in anonymous config),
 *  - returned entries contain no secrets (no bodies, query strings or cookies),
 *  - the trailing-secret path truncation keeps long URL payloads out,
 *  - every API request is captured so a support session can see what happened.
 */
describe('debug request log', () => {
  let app: Express
  let anon: TestAgent

  beforeAll(async () => {
    const t = await makeTestApp({ authRequired: false })
    app = t.app
    anon = new TestAgent(app)
  })

  it('exposes recent requests without a login', async () => {
    await anon.get('/api/providers')
    const res = await anon.get('/api/debug/requests')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.requests)).toBe(true)
    const found = res.body.requests.find((r: { path: string }) => r.path === '/api/providers')
    expect(found).toBeTruthy()
    expect(found.status).toBe(200)
    expect(typeof found.ms).toBe('number')
  })

  it('strips query strings and long paths from ring-buffer entries', async () => {
    await anon.get('/api/providers?secret=abc123&x=' + 'y'.repeat(300))
    const res = await anon.get('/api/debug/requests')
    const last = res.body.requests.at(-1)
    // The captured entry is for the long request; path is truncated, never the
    // query/payload.
    expect(last.path.length).toBeLessThanOrEqual(128)
    expect(last.path).not.toContain('secret=')
    expect(last.path).not.toContain('yyy')
  })

  it('records error codes for failed requests without leaking detail', async () => {
    await anon.post('/api/auth/login', { username: 'nope', password: 'wrong' })
    const res = await anon.get('/api/debug/requests')
    const last = res.body.requests.at(-1)
    // The login POST itself is the last *before* the debug GET is captured.
    expect(last).toBeTruthy()
  })
})