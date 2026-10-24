import { describe, it, expect } from 'vitest'
import { makeTestApp, seedUser, login } from '../test/test-app.js'
import { createRegistry, serializeCapabilities } from '../providers/registry.js'

/**
 * Capability ids are declared as a `Set` by providers. `JSON.stringify` turns a
 * Set into `{}`, so any endpoint that forgets to serialize produced a body the
 * UI could not read: `capabilities.includes(...)` threw
 * "is not a function" and pages like Import/Export crashed on open.
 *
 * These tests pin the wire contract: every capability response is an array.
 */
describe('capability wire format', () => {
  it('serializes a capability set to a sorted array', () => {
    const registry = createRegistry()
    const wire = serializeCapabilities({
      auth: ['connection', 'api'],
      capabilities: new Set(['data.browse', 'control.listProjects', 'sql.execute'] as const),
    })

    expect(Array.isArray(wire.capabilities)).toBe(true)
    expect(wire.capabilities).toEqual(['control.listProjects', 'data.browse', 'sql.execute'])
    expect(Array.isArray(wire.auth)).toBe(true)
    expect(wire.auth).toEqual(['connection', 'api'])
  })

  it('returns empty arrays for an unknown provider', () => {
    expect(serializeCapabilities(undefined)).toEqual({ auth: [], capabilities: [] })
  })

  it('exposes capabilities as an array after an API-key connection', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    t.neon._setHandler('GET', '/users/me/organizations', () => ({ organizations: [] }))
    const creds = await seedUser(t.store)
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    const res = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_key_wire_test' }, csrfToken)
    expect(res.status).toBe(200)

    // The browser calls `.includes()` on this — it must never be an object.
    expect(Array.isArray(res.body.capabilities.capabilities)).toBe(true)
    expect(res.body.capabilities.capabilities.length).toBeGreaterThan(0)
    expect(res.body.capabilities.capabilities).toContain('control.listProjects')
    expect(Array.isArray(res.body.capabilities.auth)).toBe(true)
  })

  it('exposes capabilities as an array on the status endpoint', async () => {
    const t = await makeTestApp()
    t.neon._setHandler('GET', '/users/me', () => ({ id: 'user-1', email: 'ops@example.com' }))
    const creds = await seedUser(t.store)
    const { agent, csrfToken } = await login(t.app, creds.username, creds.password)

    const connect = await agent.post('/api/connections/api', { providerId: 'neon', apiKey: 'neon_key_wire_status' }, csrfToken)
    expect(connect.status).toBe(200)

    const status = await agent.get('/api/connections/status')
    expect(status.status).toBe(200)
    expect(status.body.connected).toBe(true)
    expect(Array.isArray(status.body.capabilities.capabilities)).toBe(true)
    expect(status.body.capabilities.capabilities.length).toBeGreaterThan(0)
  })
})
