import { describe, it, expect } from 'vitest'
import { PostgresAdapter } from '../adapters/postgres.js'
import { AppError, isClientError } from '../lib/errors.js'
import { asAppError } from '../lib/errors.js'

describe('database error translation to safe HTTP codes', () => {
  const adapter = new PostgresAdapter()
  it('maps auth failures to 401 UNAUTHORIZED (not 500)', () => {
    const err = adapter.translatePgError({ code: '28P01', message: 'password authentication failed for user "x"' })
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.status).toBe(401)
    expect(isClientError(err)).toBe(true)
    // safe user-facing message, no password/role detail
    expect(err.message).toBe('Authentication failed: invalid role or password')
    expect(err.detail).toContain('password authentication failed') // internal only
  })
  it('maps unsupported host / provider errors to 4xx', () => {
    const host = new AppError({ code: 'CONNECTION_UNSUPPORTED_HOST', message: 'x' })
    const prov = new AppError({ code: 'PROVIDER_ERROR', message: 'y' })
    const perm = new AppError({ code: 'PERMISSION_DENIED', message: 'z' })
    expect(host.status).toBe(400)
    expect(prov.status).toBe(400)
    expect(perm.status).toBe(400)
    expect(isClientError(host)).toBe(true)
  })
  it('exposes generic INTERNAL for unknown errors but keeps detail server-side', () => {
    const e = asAppError(new Error('secret stack detail'))
    expect(e.status).toBe(500)
    expect(e.message).toBe('Internal server error')
    expect(e.detail).toBe('secret stack detail')
  })
})
