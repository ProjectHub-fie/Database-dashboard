import { describe, expect, it } from 'vitest'
import { capabilitiesForAuth, serializeCapabilities } from './registry.js'
import { NeonProvider } from './neon/provider.js'
import type { ProviderCapabilities } from './types.js'

const caps: ProviderCapabilities = {
  auth: ['connection', 'api'],
  capabilities: new Set([
    'sql.basic',
    'browse.tables',
    'control.listProjects',
    'control.deleteProject',
    'monitoring.usage',
  ]) as ProviderCapabilities['capabilities'],
}

/**
 * A database URL cannot reach the provider's management API. If those ids are
 * advertised in connection mode the sidebar offers Projects/Branches buttons
 * that the server answers with 401, which reads as a broken app rather than an
 * unavailable feature.
 */
describe('capabilitiesForAuth', () => {
  it('withholds control-plane capabilities from a database connection', () => {
    const scoped = capabilitiesForAuth(caps, 'connection')!
    expect([...scoped.capabilities].sort()).toEqual(['browse.tables', 'sql.basic'])
  })

  it('keeps the full set with a provider API key', () => {
    const scoped = capabilitiesForAuth(caps, 'api')!
    expect([...scoped.capabilities]).toEqual([...caps.capabilities])
  })

  it('still declares both auth methods so the UI can offer them', () => {
    expect([...capabilitiesForAuth(caps, 'connection')!.auth]).toEqual(['connection', 'api'])
  })

  it('serializes to arrays for a scoped connection set', () => {
    const wire = serializeCapabilities(capabilitiesForAuth(caps, 'connection'))
    expect(Array.isArray(wire.capabilities)).toBe(true)
    expect(wire.capabilities).not.toContain('control.listProjects')
  })

  it('matches the real Neon provider', () => {
    const neon = new NeonProvider({ skipConnectionUrlHostValidation: true }).capabilities()
    const connection = [...capabilitiesForAuth(neon, 'connection')!.capabilities]
    expect(connection.some((c) => c.startsWith('control.'))).toBe(false)
    expect(connection).toContain('sql.basic')
    expect([...capabilitiesForAuth(neon, 'api')!.capabilities]).toContain('control.deleteProject')
  })
})
