import { describe, it, expect } from 'vitest'
import {
  resolveCatalog,
  supportsAuthMethod,
  catalogIssueMessage,
  reconcileProviderSelection,
  NO_PROVIDER,
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

describe('reconcileProviderSelection', () => {
  it('leaves the selector on the placeholder until the operator chooses', () => {
    // Regression: the form used to open with Neon already selected, so pressing
    // Connect without reading the field silently targeted Neon.
    expect(reconcileProviderSelection(NO_PROVIDER, [neon, mysql])).toBe(NO_PROVIDER)
  })

  it('keeps a choice that is still available', () => {
    expect(reconcileProviderSelection('neon', [neon, mysql])).toBe('neon')
  })

  it('clears a choice the catalog no longer offers', () => {
    expect(reconcileProviderSelection('postgres', [neon, mysql])).toBe(NO_PROVIDER)
  })

  it('clears a choice that became unavailable rather than substituting another', () => {
    // Auto-selecting the first available engine here would open the connection
    // against a provider the operator never picked.
    expect(reconcileProviderSelection('mysql', [neon, mysql])).toBe(NO_PROVIDER)
  })

  it('lands on the placeholder when the whole catalog disappears', () => {
    expect(reconcileProviderSelection('neon', [])).toBe(NO_PROVIDER)
  })
})

describe('placeholder gates submission', () => {
  it('reports no supported auth method while nothing is chosen', () => {
    // The submit buttons and "Test connection" disable on !supportsAuthMethod,
    // so this is what forces an explicit provider choice.
    expect(supportsAuthMethod([neon, mysql], NO_PROVIDER, 'connection')).toBe(false)
    expect(supportsAuthMethod([neon, mysql], NO_PROVIDER, 'api')).toBe(false)
  })

  it('accepts the same provider once chosen', () => {
    expect(supportsAuthMethod([neon, mysql], 'neon', 'connection')).toBe(true)
    expect(supportsAuthMethod([neon, mysql], 'neon', 'api')).toBe(true)
  })
})
