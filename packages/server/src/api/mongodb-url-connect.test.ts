import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { Express } from 'express'
import supertest from 'supertest'
import { makeTestApp, seedUser, login } from '../test/test-app.js'

/**
 * URL-mode connection tests for MongoDB Atlas through the public API. These
 * pin the "Internal server error" bug: a mongodb+srv:// URL used to make
 * verifyMongodbHost resolve the SRV root with A records (raw ENOTFOUND → 500).
 * Both the DNS resolver and the mongodb driver are mocked; no real network.
 */
const srvTargets = [
  { name: 'cluster0-shard-00-00.abc123.mongodb.net.', priority: 0, weight: 0, port: 27017 },
  { name: 'cluster0-shard-00-01.abc123.mongodb.net.', priority: 0, weight: 0, port: 27017 },
]

vi.mock('node:dns/promises', () => {
  const resolve4 = vi.fn(async () => ['52.1.2.3'])
  const resolve6 = vi.fn(async () => [])
  const resolveSrv = vi.fn(async () => srvTargets)
  return { default: { resolve4, resolve6, resolveSrv }, resolve4, resolve6, resolveSrv }
})

const { driverLog } = vi.hoisted(() => ({
  driverLog: [] as Array<{ uri: string; opts: Record<string, unknown> }>,
}))

vi.mock('mongodb', () => {
  class FakeMongoClient {
    constructor(public uri: string, public opts: Record<string, unknown>) {
      driverLog.push({ uri, opts })
    }
    async connect(): Promise<void> {}

    close(): Promise<void> {
      return Promise.resolve()
    }

    db() {
      return {}
    }
  }
  return {
    MongoClient: FakeMongoClient,
    ObjectId: class {
      toHexString(): string {
        return '0123456789abcdef01234567'
      }
    },
  }
})

describe('MongoDB Atlas URL-mode connection', () => {
  let app: Express

  beforeAll(async () => {
    app = (await makeTestApp()).app
  })

  it('connects via mongodb+srv:// and gives the driver an all-aware pinned lookup', async () => {
    driverLog.length = 0
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-srv-user')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)

    const res = await agent.post(
      '/api/connections/url',
      {
        providerId: 'mongodb-atlas',
        connectionString:
          'mongodb+srv://dbuser:dbpass@cluster0.abc123.mongodb.net/myapp?retryWrites=true',
      },
      csrfToken,
    )
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.metadata.database).toBe('myapp')

    expect(driverLog).toHaveLength(1)
    expect(driverLog[0]!.uri).toBe(
      'mongodb+srv://dbuser:dbpass@cluster0.abc123.mongodb.net/myapp?retryWrites=true',
    )
    const lookup = driverLog[0]!.opts.lookup as unknown as (h: string, o: unknown, cb: Function) => void
    expect(typeof lookup).toBe('function')

    // The lookup must answer the driver's { all: true } shape, not the broken
    // form that produced "Invalid IP address: undefined".
    let allResult: unknown
    let plainResult: unknown
    lookup('cluster0-shard-00-00.abc123.mongodb.net', { all: true }, (...args: unknown[]) => {
      allResult = args
    })
    lookup('cluster0-shard-00-00.abc123.mongodb.net', {}, (...args: unknown[]) => {
      plainResult = args
    })
    expect(allResult).toHaveLength(3)
    expect((allResult as unknown[])[1]).toEqual([{ address: '52.1.2.3', family: 4 }])
    expect(plainResult).toHaveLength(3)
    expect((plainResult as unknown[])[1]).toBe('52.1.2.3')
  })

  it('connects via plain mongodb:// and pins a direct address', async () => {
    driverLog.length = 0
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-url-user')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)

    const res = await agent.post(
      '/api/connections/url',
      {
        providerId: 'mongodb-atlas',
        connectionString: 'mongodb://dbuser:dbpass@cluster0-shard-00-00.abc123.mongodb.net:27017/myapp',
      },
      csrfToken,
    )
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.metadata.host).toMatch(/\.mongodb\.net$/)
  })

  it('answers a DNS failure for mongodb+srv:// with a 4xx, not a 500', async () => {
    const dns = (await import('node:dns/promises')) as { resolveSrv: any }
    vi.mocked(dns.resolveSrv).mockRejectedValueOnce(
      Object.assign(new Error('querySrv ENOTFOUND _mongodb._tcp.cluster0.abc123.mongodb.net'), { code: 'ENOTFOUND' }),
    )
    const t = await makeTestApp()
    const seed = await seedUser(t.store, 'mongo-srv-fail')
    const { agent, csrfToken } = await login(t.app, seed.username, seed.password)

    const res = await agent.post(
      '/api/connections/url',
      {
        providerId: 'mongodb-atlas',
        connectionString: 'mongodb+srv://u:p@cluster0.abc123.mongodb.net/myapp',
      },
      csrfToken,
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(res.body.error.code).toBe('CONNECTION_FAILED')
    // Re-arm the shared mock for later tests.
    vi.mocked(dns.resolveSrv).mockResolvedValue(srvTargets)
  })
})