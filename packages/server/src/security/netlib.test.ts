import { describe, it, expect } from 'vitest'
import { verifyNeonConnectionUrl, isForbiddenAddress, verifyNeonHost, LOCALHOST_HOSTS } from './netlib.js'

describe('verifyNeonConnectionUrl', () => {
  it('rejects non-Neon hosts', async () => {
    await expect(
      verifyNeonConnectionUrl('postgres://user:pass@example.com:5432/db', { allowLocalhost: false }),
    ).rejects.toThrow()
  })

  it('accepts a realistic Neon endpoint and pins its address', async () => {
    const verified = await verifyNeonConnectionUrl(
      'postgres://alex:secret@ep-misty-bird-123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
      { allowLocalhost: false },
    )
    expect(verified.host).toMatch(/neon\.tech$/)
    expect(verified.database).toBe('neondb')
    expect(verified.role).toBe('alex')
    expect(verified.verified.address).toMatch(/^\d+(\.\d+){3}$/)
    expect(verified.port).toBe(5432)
  })

  it('rejects hosts pointing at private networks even within neon.tech', async () => {
    // A malicious/typo host that resolves within the private range must not pass.
    await expect(
      verifyNeonConnectionUrl('postgres://u:p@127.0.0.1.nip.io:5432/db', { allowLocalhost: false }),
    ).rejects.toThrow()
  })

  it('masks plaintext passwords in own error messages', async () => {
    let message = ''
    try {
      await verifyNeonConnectionUrl('postgres://u:supersecretpwd@not-a-neon-host.example/db', { allowLocalhost: false })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('neon.tech')
    expect(message).not.toContain('supersecretpwd')
  })
})

describe('isForbiddenAddress (private / reserved ranges)', () => {
  it('classifies RFC1918, loopback, link-local and reserved as forbidden', () => {
    expect(isForbiddenAddress('10.0.0.1')).toBe(true)
    expect(isForbiddenAddress('192.168.0.1')).toBe(true)
    expect(isForbiddenAddress('172.16.0.1')).toBe(true)
    expect(isForbiddenAddress('127.0.0.1')).toBe(true)
    expect(isForbiddenAddress('169.254.1.1')).toBe(true)
    expect(isForbiddenAddress('0.0.0.0')).toBe(true)
    expect(isForbiddenAddress('::1')).toBe(true)
  })
  it('classifies public addresses as allowed', () => {
    expect(isForbiddenAddress('172.32.0.1')).toBe(false)
    expect(isForbiddenAddress('8.8.8.8')).toBe(false)
  })
})

describe('verifyNeonHost', () => {
  it('rejects non-Neon domains', async () => {
    await expect(verifyNeonHost('evil.com', { allowLocalhost: false })).rejects.toThrow()
  })
  it('rejects IP literals and numeric-looking labels', async () => {
    await expect(verifyNeonHost('192.168.1.1', { allowLocalhost: false })).rejects.toThrow()
  })
  it('localhsot list is exported for the dev-only escape hatch', () => {
    expect(Array.isArray(LOCALHOST_HOSTS)).toBe(true)
  })
})
describe('TLS cannot be disabled by user input', () => {
  it('ignores sslmode=disable/no-verify from the URL', async () => {
    for (const sslmode of ['disable', 'no-verify', 'allow', 'prefer']) {
      const verified = await verifyNeonConnectionUrl(
        `postgres://u:p@localhost:5432/db?sslmode=${sslmode}`,
        { allowLocalhost: true },
      )
      // The verified descriptor carries no ssl mode — TLS is always forced by
      // the pg client factory regardless of the submitted query string.
      expect(verified).not.toHaveProperty('ssl')
      expect(verified.host).toBe('localhost')
    }
  })
})
