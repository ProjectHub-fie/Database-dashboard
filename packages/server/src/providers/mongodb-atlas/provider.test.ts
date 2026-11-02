import { describe, it, expect, beforeEach } from 'vitest'
import { MongoDbProvider } from './provider.js'
import { mockAtlasHttp, mockAtlasOauth } from '../../test/mock-atlas.js'

describe('MongoDB Atlas provider', () => {
  let atlas: ReturnType<typeof mockAtlasHttp>
  let oauth: ReturnType<typeof mockAtlasOauth>

  beforeEach(() => {
    atlas = mockAtlasHttp()
    oauth = mockAtlasOauth()
  })

  it('declares the connection + api auth methods and the document capabilities', () => {
    const provider = new MongoDbProvider({ skipConnectionUrlHostValidation: true })
    const caps = provider.capabilities()
    expect([...caps.auth]).toEqual(['connection', 'api'])
    expect(provider.info.kind).toBe('mongodb')
    // No SQL for Mongo.
    expect(caps.capabilities.has('sql.basic')).toBe(false)
    expect(caps.capabilities.has('browse.documents')).toBe(true)
    expect(caps.capabilities.has('control.listProjects')).toBe(true)
  })

  it('validates a service-account credential via the OAuth exchange', async () => {
    const provider = new MongoDbProvider({
      atlas: { http: atlas, oauth },
      skipConnectionUrlHostValidation: true,
    })
    const control = provider.controlPlaneFor('client-id-1:client-secret-1')
    const result = await control.validateApiKey()
    expect(oauth._exchanges).toHaveLength(1)
    expect(oauth._exchanges[0]).toEqual({ clientId: 'client-id-1', clientSecret: 'client-secret-1' })
    expect(result.organizationScoped).toBe(true)
  })

  it("rejects a raw credential without the ':' separator", () => {
    const provider = new MongoDbProvider({ skipConnectionUrlHostValidation: true })
    expect(() => provider.controlPlaneFor('nope-not-split')).toThrow(/clientId:secret/)
  })

  it('refuses a connection string whose host is not on the Atlas allowlist', async () => {
    const provider = new MongoDbProvider({
      atlas: { http: atlas, oauth },
      // Allow localhost only; evil self-host mongo must still be blocked.
      skipConnectionUrlHostValidation: false,
    })
    await expect(
      provider.connect({ kind: 'connection', connectionString: 'mongodb://u:pass@db.internal.example/foo' }),
    ).rejects.toMatchObject({ code: 'CONNECTION_UNSUPPORTED_HOST' })
  })

  it('returns an account-only session for a valid Atlas service account', async () => {
    const provider = new MongoDbProvider({
      atlas: { http: atlas, oauth },
      skipConnectionUrlHostValidation: true,
    })
    const out = await provider.connect({ kind: 'api', apiKey: 'cid:secret' })
    expect(out.accountOnly).toBe(true)
    expect(out.connection).toBeNull()
    expect(out.metadata.host).toBe('cloud.mongodb.com')
  })
})