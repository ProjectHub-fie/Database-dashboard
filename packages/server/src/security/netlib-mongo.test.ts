import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyMongodbConnectionUrl, verifyMongodbHost } from './netlib.js'

// Real `*.mongodb.net` hosts exist in the public DNS, but a unit test must not
// depend on querying Atlas's actual clusters. Mock the resolver so the
// suffix/DNS-pinning logic runs against a controllable public address.
vi.mock('node:dns/promises', () => {
  const resolve4 = vi.fn(async () => ['52.1.2.3'])
  const resolve6 = vi.fn(async () => [])
  const resolveSrv = vi.fn(async () => [])
  return { default: { resolve4, resolve6, resolveSrv }, resolve4, resolve6, resolveSrv }
})

async function dnsMocks() {
  const mod = (await import('node:dns/promises')) as { resolve4: any; resolve6: any; resolveSrv: any }
  return { resolve4: vi.mocked(mod.resolve4), resolve6: vi.mocked(mod.resolve6), resolveSrv: vi.mocked(mod.resolveSrv) }
}

beforeEach(async () => {
  const { resolve4, resolve6, resolveSrv } = await dnsMocks()
  resolve4.mockReset()
  resolve6.mockReset()
  resolveSrv.mockReset()
  resolve4.mockResolvedValue(['52.1.2.3'])
  resolve6.mockResolvedValue([])
  resolveSrv.mockResolvedValue([])
})

describe('verifyMongodbConnectionUrl (DNS-mocked)', () => {
  it('resolves an SRV host via its shard targets and pins each address', async () => {
    const { resolveSrv, resolve4 } = await dnsMocks()
    resolveSrv.mockResolvedValue([
      { name: 'cluster0-shard-00-00.abc123.mongodb.net.', priority: 0, weight: 0, port: 27017 },
      { name: 'cluster0-shard-00-01.abc123.mongodb.net.', priority: 0, weight: 0, port: 27017 },
    ])
    resolve4.mockResolvedValue(['52.1.2.3'])

    const verified = await verifyMongodbConnectionUrl(
      'mongodb+srv://dbuser:dbpass@cluster0.abc123.mongodb.net/myapp?retryWrites=true',
      { allowLocalhost: false },
    )
    expect(verified.host).toMatch(/\.mongodb\.net$/)
    expect(verified.database).toBe('myapp')
    expect(verified.role).toBe('dbuser')
    expect(verified.verified.address).toBe('52.1.2.3')
    // The shard map used by the driver's lookup callback.
    expect(verified.verified.srvMap?.get('cluster0-shard-00-00.abc123.mongodb.net')).toBe('52.1.2.3')
  })

  it('accepts a plain mongodb:// (non-SRV) Atlas host', async () => {
    const verified = await verifyMongodbConnectionUrl(
      'mongodb://dbuser:dbpass@cluster0-shard-00-00.abc123.mongodb.net:27017/myapp',
      { allowLocalhost: false },
    )
    expect(verified.port).toBe(27017)
    expect(verified.verified.isLocalhost).toBe(false)
  })

  it('rejects a mongodb.net host resolving to a private address', async () => {
    const { resolve4 } = await dnsMocks()
    resolve4.mockResolvedValue(['10.0.0.7'])
    await expect(
      verifyMongodbHost('cluster0.abc123.mongodb.net', { allowLocalhost: false }),
    ).rejects.toThrow(/not reachable|forbidden/i)
  })

  it('rejects an SRV target resolving to a private address', async () => {
    const { resolveSrv, resolve4 } = await dnsMocks()
    resolveSrv.mockResolvedValue([
      { name: 'evil-shard.abc123.mongodb.net.', priority: 0, weight: 0, port: 27017 },
    ])
    resolve4.mockResolvedValue(['10.0.0.7'])
    await expect(
      verifyMongodbConnectionUrl(
        'mongodb+srv://u:p@cluster0.abc123.mongodb.net/app',
        { allowLocalhost: false },
      ),
    ).rejects.toThrow(/not reachable|forbidden/i)
  })

  it('maps a raw DNS failure (ENOTFOUND) to a client 4xx instead of a 500', async () => {
    const { resolve4 } = await dnsMocks()
    const notFound = new Error('queryA ENOTFOUND cluster0.abc123.mongodb.net')
    ;(notFound as { code?: string }).code = 'ENOTFOUND'
    resolve4.mockRejectedValue(notFound)
    const err = await verifyMongodbConnectionUrl(
      'mongodb://u:p@cluster0.abc123.mongodb.net/myapp',
      { allowLocalhost: false },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeTruthy()
    expect(err).toHaveProperty('code', 'CONNECTION_FAILED')
    expect(err!.message).toMatch(/could not resolve database host/i)
    expect(err!.message).not.toContain('ENOTFOUND cluster0')
  })

  it('maps a missing SRV record to a client 4xx', async () => {
    const { resolveSrv } = await dnsMocks()
    const notFound = new Error('querySrv ENOTFOUND _mongodb._tcp.cluster0.abc123.mongodb.net')
    ;(notFound as { code?: string }).code = 'ENOTFOUND'
    resolveSrv.mockRejectedValue(notFound)
    const err = await verifyMongodbConnectionUrl(
      'mongodb+srv://u:p@cluster0.abc123.mongodb.net/app',
      { allowLocalhost: false },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeTruthy()
    expect(err).toHaveProperty('code', 'CONNECTION_FAILED')
    expect(err!.message).toMatch(/srv record/i)
  })

  it('obscures the password in errors', async () => {
    let message = ''
    try {
      await verifyMongodbConnectionUrl(
        'mongodb://u:supersecret-mongo@cluster0.abc123.mongodb.net/myapp',
        { allowLocalhost: false },
      )
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toContain('supersecret-mongo')
  })
})
