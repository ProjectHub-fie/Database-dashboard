import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, ApiError, onConnectionLost } from './api.js'

/**
 * Pins the contract between server status codes and the client's "the
 * connection is gone" handler. A false positive here signs the operator out of
 * a perfectly healthy session just for opening a page.
 */
function respondWith(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connection-lost handling', () => {
  it('clears the connection on UNAUTHORIZED from a data route', async () => {
    respondWith(401, { error: { code: 'UNAUTHORIZED', message: 'No active database session. Connect first.' } })
    let lost = 0
    const off = onConnectionLost(() => lost++)
    await expect(api.get('/api/sql/history')).rejects.toBeInstanceOf(ApiError)
    off()
    expect(lost).toBe(1)
  })

  it('keeps the connection when a feature is simply unavailable to this session', async () => {
    // Regression: account-only routes answered 401 to anonymous sessions, so
    // opening SQL Studio or Security cleared the connection and bounced the
    // operator to /connect. A 403 means "not for this session", not "session lost".
    respondWith(403, {
      error: { code: 'FEATURE_UNAVAILABLE', message: 'This feature needs a dashboard account.' },
    })
    let lost = 0
    const off = onConnectionLost(() => lost++)
    await expect(api.get('/api/sql/saved')).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' })
    off()
    expect(lost).toBe(0)
  })

  it('never treats auth-route 401s as a lost connection', async () => {
    // Writes read the CSRF cookie; Node has no document.
    vi.stubGlobal('document', { cookie: '' })
    respondWith(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid username or password' } })
    let lost = 0
    const off = onConnectionLost(() => lost++)
    await expect(api.post('/api/auth/login', {})).rejects.toBeInstanceOf(ApiError)
    off()
    expect(lost).toBe(0)
  })
})
