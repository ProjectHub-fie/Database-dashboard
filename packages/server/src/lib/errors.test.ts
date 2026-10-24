import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { asAppError, AppError } from './errors.js'

describe('asAppError', () => {
  it('passes AppError through untouched', () => {
    const original = new AppError({ code: 'NOT_FOUND', message: 'missing' })
    expect(asAppError(original)).toBe(original)
  })

  it('maps Zod failures to a 400 instead of a 500', () => {
    const schema = z.object({ providerId: z.literal('neon') })
    const parsed = schema.safeParse({ providerId: 'other' })
    expect(parsed.success).toBe(false)

    const err = asAppError(parsed.error)
    expect(err.status).toBe(400)
    expect(err.code).toBe('BAD_REQUEST')
    expect(err.message).toContain('providerId')
  })

  it('does not surface stack traces or raw internals for unknown errors', () => {
    const err = asAppError(new Error('relation "x" does not exist at pg.js:12:3'))
    expect(err.status).toBe(500)
    expect(err.message).toBe('Internal server error')
    expect(err.message).not.toContain('pg.js')
    // The original message is retained only for server-side logs.
    expect(err.detail).toContain('relation')
  })
})
