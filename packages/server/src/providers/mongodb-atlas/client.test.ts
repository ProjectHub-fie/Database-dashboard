import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { parseDigestChallenge, digestAuthorizationHeader } from './client.js'

describe('Atlas HTTP digest auth (legacy programmatic API keys)', () => {
  const challengeHeader =
    'Digest realm="MMS Public API", nonce="abc123nonce", qop="auth", opaque="opq", algorithm=MD5'

  it('parses the digest challenge fields', () => {
    const parsed = parseDigestChallenge(challengeHeader)
    expect(parsed.realm).toBe('MMS Public API')
    expect(parsed.nonce).toBe('abc123nonce')
    expect(parsed.qop).toEqual(['auth'])
    expect(parsed.opaque).toBe('opq')
    expect(parsed.algorithm).toBe('MD5')
  })

  it('throws on a challenge without realm or nonce', () => {
    expect(() => parseDigestChallenge('Digest qop="auth"')).toThrow(/incomplete digest challenge/i)
  })

  it('computes a qop=auth response an independent md5 can verify', () => {
    const hdr = digestAuthorizationHeader(
      { realm: 'MMS Public API', nonce: 'abc123nonce', qop: ['auth'], opaque: 'opq' },
      { digest: { username: 'pubkey', password: 'privkey' }, method: 'GET' },
      '/api/atlas/v2/groups',
    )
    const auth = hdr.Authorization ?? ''
    expect(auth.startsWith('Digest ')).toBe(true)
    expect(auth).toContain('username="pubkey"')
    expect(auth).toContain('realm="MMS Public API"')
    expect(auth).toContain('nonce="abc123nonce"')
    expect(auth).toContain('uri="/api/atlas/v2/groups"')
    expect(auth).toContain('qop=auth')
    expect(auth).toContain('nc=00000001')
    expect(auth).toMatch(/cnonce="[0-9a-f]+"/)
    expect(auth).toContain('opaque="opq"')

    const md5 = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
    const ha1 = md5('pubkey:MMS Public API:privkey')
    const ha2 = md5('GET:/api/atlas/v2/groups')
    const nc = '00000001'
    const cnonce = /cnonce="([^"]+)"/.exec(auth)?.[1] ?? ''
    const expected = md5(`${ha1}:abc123nonce:${nc}:${cnonce}:auth:${ha2}`)
    expect(auth).toContain(`response="${expected}"`)
  })

  it('falls back to the rfc2069 response when the challenge has no qop', () => {
    const hdr = digestAuthorizationHeader(
      { realm: 'MMS Public API', nonce: 'abc123' },
      { digest: { username: 'u', password: 'p' }, method: 'POST' },
      '/x',
    )
    const auth = hdr.Authorization ?? ''
    expect(auth).not.toContain('qop=')
    expect(auth).not.toContain('cnonce=')

    const md5 = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
    const ha1 = md5('u:MMS Public API:p')
    const ha2 = md5('POST:/x')
    const expected = md5(`${ha1}:abc123:${ha2}`)
    expect(auth).toContain(`response="${expected}"`)
  })

  it('returns no auth header without digest credentials', () => {
    const hdr = digestAuthorizationHeader(
      { realm: 'r', nonce: 'n', qop: ['auth'] },
      { digest: null, method: 'GET' },
      '/x',
    )
    expect(hdr).toEqual({})
  })
})