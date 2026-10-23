import { describe, it, expect } from 'vitest'
import { redact, redactObject, redactConnectionUrl } from './redact.js'

describe('redact', () => {
  it('masks known secret values', () => {
    expect(redact('password=SuperSecret99!', { secrets: ['SuperSecret99!'] })).not.toContain('SuperSecret99!')
  })

  it('strips authorization headers', () => {
    expect(redact('Authorization: Bearer ntoai_.abcdef')).not.toContain('ntoai_')
    expect(redact('x-api-key: sk-xyz')).not.toContain('sk-xyz')
  })

  it('masks query params in URLs', () => {
    const out = redact('https://host/path?api_key=ABCDEF123&x=1')
    expect(out).not.toContain('ABCDEF123')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts postgres connection strings', () => {
    expect(redact('postgres://user:pass@host/db')).not.toContain('pass')
  })
})

describe('redactObject', () => {
  it('redacts secret-shaped keys recursively', () => {
    const out = redactObject({ connection: { password: 'p@ss', host: 'x' }, apiKey: 'k', nested: { ok: true } })
    expect(JSON.stringify(out)).not.toContain('p@ss')
    expect(JSON.stringify(out)).not.toContain('"apiKey":"k"')
    expect((out as any).nested.ok).toBe(true)
  })
})

describe('redactConnectionUrl', () => {
  it('hides username and password', () => {
    const out = redactConnectionUrl('postgres://user:pass123@db.example/x')
    expect(out).not.toContain('pass123')
    expect(out).not.toContain('user@')
    expect(out).toContain('@db.example')
  })
})