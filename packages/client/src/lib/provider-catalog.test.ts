import { describe, it, expect } from 'vitest'
import {
  resolveCatalog,
  supportsAuthMethod,
  catalogIssueMessage,
  FALLBACK_CATALOG,
} from './provider-catalog.js'
import { ProviderCatalogEntry } from './types.js'

const neon: ProviderCatalogEntry = {
  id: 'neon',
  name: 'Neon PostgreSQL',
  kind: 'postgres',
  available: true,
  authMethods: ['connection', 'api'],
  controlPlane: true,
  capabilities: [],
}

const mysql: ProviderCatalogEntry = {
  id: 'mysql',
  name: 'MySQL',
  kind: 'mysql',
  available: false,
  authMethods: [],
  controlPlane: false,
  capabilities: [],
}

describe('resolveCatalog', () => {
  it('returns null only while the first request is in flight', () => {
    expect(resolveCatalog({ providers: null, issue: null })).toBeNull()
  })

  it('falls back to Neon when the catalog request failed', () => {
    // Regression: a failed fetch used to leave the selector empty and disable
    // submit, so a deployment with no API origin looked like it had no provider.
    const catalog = resolveCatalog({ providers: null, issue: 'API origin missing' })
    expect(catalog).toEqual(FALLBACK_CATALOG)
    expect(catalog?.map((p) => p.id)).toEqual(['neon'])
  })

  it('prefers the server catalog once it loads', () => {
    const server = [neon, mysql]
    expect(resolveCatalog({ providers: server, issue: null })).toBe(server)
  })

  it('does not fall back while a stale catalog is still rendered', () => {
    const server = [neon]
    expect(resolveCatalog({ providers: server, issue: 'retry failed' })).toBe(server)
  })
})

describe('supportsAuthMethod', () => {
  it('enables both modes for Neon', () => {
    expect(supportsAuthMethod([neon], 'neon', 'connection')).toBe(true)
    expect(supportsAuthMethod([neon], 'neon', 'api')).toBe(true)
  })

  it('disables both modes for a planned provider', () => {
    expect(supportsAuthMethod([neon, mysql], 'mysql', 'connection')).toBe(false)
  })

  it('disables an unknown provider id', () => {
    expect(supportsAuthMethod([neon], 'oracle', 'connection')).toBe(false)
  })

  it('stays disabled when the catalog is unavailable and has no fallback', () => {
    expect(supportsAuthMethod(null, 'neon', 'connection')).toBe(false)
  })

  it('keeps the fallback usable, so the degraded form can still submit', () => {
    const catalog = resolveCatalog({ providers: null, issue: 'API_NOT_CONFIGURED' })
    expect(supportsAuthMethod(catalog, 'neon', 'connection')).toBe(true)
  })
})

describe('catalogIssueMessage', () => {
  it('names the misconfiguration instead of a generic failure', () => {
    expect(catalogIssueMessage('API_NOT_CONFIGURED')).toMatch(/no API origin configured/)
  })

  it('falls back to a generic message for other errors', () => {
    expect(catalogIssueMessage('INTERNAL')).toBe(
      'Could not load the provider catalog. Showing Neon only.',
    )
    expect(catalogIssueMessage(undefined)).toBe(
      'Could not load the provider catalog. Showing Neon only.',
    )
  })
})
