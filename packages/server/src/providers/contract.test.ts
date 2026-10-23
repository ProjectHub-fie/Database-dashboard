import { describe, it, expect } from 'vitest'
import { assertProviderContract, createRegistry } from './registry.js'
import { NeonProvider } from './neon/provider.js'
import { Provider } from './types.js'

describe('provider registry contract', () => {
  it('registers and answers capabilities', () => {
    const reg = createRegistry()
    reg.register(new NeonProvider() as Provider<unknown>)
    expect(reg.get('neon')).toBeDefined()
    expect(reg.list()).toHaveLength(1)
    const caps = reg.capabilities('neon')!
    expect(caps.auth).toEqual(['connection', 'api'])
    expect(caps.capabilities.has('sql.basic')).toBe(true)
    expect(caps.capabilities.has('control.listProjects')).toBe(true)
    expect(caps.capabilities.has('control.deleteProject')).toBe(true)
  })

  it('rejects duplicate provider ids', () => {
    const reg = createRegistry()
    reg.register(new NeonProvider() as Provider<unknown>)
    expect(() => reg.register(new NeonProvider() as Provider<unknown>)).toThrow()
  })

  it('enforces the Provider contract at registration for Neon', () => {
    const neon = new NeonProvider() as Provider<unknown>
    expect(() => assertProviderContract(neon)).not.toThrow()
  })

  it('fails contract when api auth lacks controlPlaneFor', () => {
    const broken = {
      info: { id: 'x', name: 'X', kind: 'postgres', controlPlane: true, apiDocs: '' },
      capabilities: () => ({ auth: ['api'], capabilities: new Set(['control.listProjects']) }),
      connect: async () => ({}),
      disconnect: async () => {},
      createConnectionSession: () => ({}),
    } as unknown as Provider<unknown>
    expect(() => assertProviderContract(broken)).toThrow(/controlPlaneFor/)
  })

  it('fails contract when connection auth lacks a database adapter', () => {
    const broken = {
      info: { id: 'y', name: 'Y', kind: 'postgres', controlPlane: false, apiDocs: '' },
      capabilities: () => ({ auth: ['connection'], capabilities: new Set(['sql.basic']) }),
      connect: async () => ({}),
      disconnect: async () => {},
      createConnectionSession: () => ({}),
    } as unknown as Provider<unknown>
    expect(() => assertProviderContract(broken)).toThrow(/database adapter/)
  })
})

describe('neon provider shape', () => {
  it('declares a control-plane adapter factory that mints per-key clients', () => {
    const neon = new NeonProvider()
    const cp = neon.controlPlaneFor('brb_test_key_1234567890')
    expect(cp.providerId).toBe('neon')
    expect(cp.apiBaseUrl).toContain('console.neon.tech')
  })
})