import { describe, it, expect } from 'vitest'
import { providerFormExamples } from './provider-examples.js'
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

const mongo: ProviderCatalogEntry = {
  id: 'mongodb-atlas',
  name: 'MongoDB Atlas',
  kind: 'mongodb',
  available: true,
  authMethods: ['connection', 'api'],
  controlPlane: true,
  capabilities: [],
}

describe('providerFormExamples', () => {
  it('shows the Neon PostgreSQL example when Neon is selected', () => {
    const ex = providerFormExamples([neon, mongo], 'neon')
    expect(ex.connectionUrl).toContain('postgresql://')
    expect(ex.connectionUrl).toContain('neon.tech')
    expect(ex.apiKey).toBe('neon_xxxxxxxxxxxxxxxx')
    expect(ex.emptyUrlError).toContain('PostgreSQL')
    expect(ex.urlSubtitle).toContain('PostgreSQL')
  })

  it('shows a MongoDB example when MongoDB Atlas is selected (never Neon copy)', () => {
    const ex = providerFormExamples([neon, mongo], 'mongodb-atlas')
    expect(ex.connectionUrl).toContain('mongodb+srv://')
    expect(ex.connectionUrl).toContain('mongodb.net')
    expect(ex.connectionUrl).not.toContain('neon.tech')
    expect(ex.apiKey).toContain(':')
    expect(ex.apiKey).not.toContain('neon_')
    expect(ex.emptyUrlError).toContain('MongoDB')
    expect(ex.emptyUrlError).not.toContain('PostgreSQL')
    expect(ex.urlSubtitle).toContain('MongoDB')
    expect(ex.urlSubtitle).not.toContain('PostgreSQL')
  })

  it('falls back to the Neon example when the provider is unknown', () => {
    const ex = providerFormExamples([neon, mongo], 'made-up')
    expect(ex.connectionUrl).toContain('neon.tech')
    expect(ex.emptyUrlError).toContain('database')
  })

  it('falls back even when the catalog is still loading', () => {
    const ex = providerFormExamples(null, 'mongodb-atlas')
    expect(ex.connectionUrl.length).toBeGreaterThan(0)
  })
})