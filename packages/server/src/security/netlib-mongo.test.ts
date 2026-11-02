import { describe, it, expect, vi } from 'vitest'
import { verifyMongodbConnectionUrl, verifyMongodbHost } from './netlib.js'

// Real `*.mongodb.net` hosts exist in the public DNS, but a unit test must not
// depend on querying Atlas's actual clusters. Mock the resolver so the
// suffix/DNS-pinning logic runs against a controllable public address.
vi.mock('node:dns/promises', () => {
  const resolve4 = vi.fn(async () => ['52.1.2.3'])
  const resolve6 = vi.fn(async () => [])
  return { default: { resolve4, resolve6 }, resolve4, resolve6 }
})

describe('verifyMongodbConnectionUrl (DNS-mocked)', () => {
  it('accepts a realistic Atlas SRV host and pins its address', async () => {
    const verified = await verifyMongodbConnectionUrl(
      'mongodb+srv://dbuser:dbpass@cluster0.abc123.mongodb.net/myapp?retryWrites=true',
      { allowLocalhost: false },
    )
    expect(verified.host).toMatch(/\.mongodb\.net$/)
    expect(verified.database).toBe('myapp')
    expect(verified.role).toBe('dbuser')
    expect(verified.verified.address).toBe('52.1.2.3')
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
    const { resolve4 } = await import('node:dns/promises')
    vi.mocked(resolve4).mockResolvedValueOnce(['10.0.0.7'])
    await expect(
      verifyMongodbHost('cluster0.abc123.mongodb.net', { allowLocalhost: false }),
    ).rejects.toThrow(/not reachable|forbidden/i)
  })

  it('obscures the password in errors', async () => {
    const { resolve4 } = await import('node:dns/promises')
    vi.mocked(resolve4).mockResolvedValueOnce(['52.1.2.3'])
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
