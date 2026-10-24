import { describe, it, expect } from 'vitest'
import { isForbiddenAddress, verifyNeonConnectionUrl, verifyNeonHost } from '../security/netlib.js'
import { AppError } from '../lib/errors.js'

/**
 * These are the guarantees that keep the dashboard from becoming an SSRF pivot.
 * None of them depend on the shape of user input beyond the URL itself: an
 * attacker who controls the connection string controls the hostname, and only
 * the host allowlist plus address checks stand between that and the internal
 * network.
 */
describe('outbound host restrictions (SSRF guard)', () => {
  it('rejects private, loopback and link-local IPv4 ranges', () => {
    const forbidden = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '192.0.2.10',
    ]
    for (const ip of forbidden) expect(isForbiddenAddress(ip), ip).toBe(true)
  })

  it('rejects IPv6 loopback, unique-local and link-local addresses', () => {
    for (const ip of ['::1', 'fc00::1', 'fd00::1', 'fe80::1']) {
      expect(isForbiddenAddress(ip), ip).toBe(true)
    }
  })

  it('allows ordinary public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '104.18.0.1']) {
      expect(isForbiddenAddress(ip), ip).toBe(false)
    }
  })

  it('rejects IP address literals as database hosts', async () => {
    for (const host of ['169.254.169.254', '10.0.0.5', '127.0.0.1', '::1']) {
      await expect(verifyNeonHost(host, { allowLocalhost: false })).rejects.toMatchObject({
        code: 'CONNECTION_UNSUPPORTED_HOST',
      })
    }
  })

  it('rejects non-Neon hostnames even when they resolve publicly', async () => {
    for (const host of ['evil.example.com', 'neon.tech.attacker.io', 'internal.corp']) {
      await expect(verifyNeonHost(host, { allowLocalhost: false })).rejects.toMatchObject({
        code: 'CONNECTION_UNSUPPORTED_HOST',
      })
    }
  })

  it('refuses localhost in production-style mode', async () => {
    await expect(verifyNeonHost('localhost', { allowLocalhost: false })).rejects.toMatchObject({
      code: 'CONNECTION_UNSUPPORTED_HOST',
    })
  })

  it('rejects garbage that is not a URL', async () => {
    await expect(verifyNeonConnectionUrl('not a url at all')).rejects.toBeInstanceOf(AppError)
  })

  it('rejects non-postgres schemes', async () => {
    await expect(
      verifyNeonConnectionUrl('mysql://user:pass@ep-x.us-east-2.aws.neon.tech/db'),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('TLS handling cannot be weakened by the connection string', () => {
  it('ignores sslmode=disable and still marks the connection TLS-required', async () => {
    const parsed = await verifyNeonConnectionUrl(
      'postgresql://role:pw@localhost:5432/appdb?sslmode=disable',
      { allowLocalhost: true },
    )
    // sslmode is never forwarded from user input; the pin is always TLS.
    expect(parsed.verified).toBeDefined()
    expect(parsed.host).toBe('localhost')
  })

  it('keeps the password out of the returned metadata', async () => {
    const parsed = await verifyNeonConnectionUrl(
      'postgresql://role:s3cret-pw@localhost:5432/appdb?sslmode=require',
      { allowLocalhost: true },
    )
    const serialized = JSON.stringify({ host: parsed.host, port: parsed.port, database: parsed.database })
    expect(serialized).not.toContain('s3cret-pw')
    // The password is tracked only so callers can redact it from logs.
    expect(parsed.secrets).toContain('s3cret-pw')
  })
})
