import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, ApiError, isTransportFailure, onConnectionLost } from './api.js'

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

describe('transport failures', () => {
  it('reports a dead link as a transport failure, not an answer', async () => {
    // The socket never opened: fetch rejects, there is no status to read.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const err = await api.get('/api/connections/status').catch((e: unknown) => e)
    expect(isTransportFailure(err)).toBe(true)
  })

  it('does not mistake a server answer for a transport failure', async () => {
    // This is the distinction AuthContext relies on: a 401 says something about
    // the session, while a failed fetch says nothing at all. Treating the second
    // as the first bounces a signed-in operator to /connect during a blip.
    respondWith(401, { error: { code: 'UNAUTHORIZED', message: 'No active database session.' } })
    const err = await api.get('/api/connections/status').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(isTransportFailure(err)).toBe(false)
  })

  it('does not treat a feature 403 or a server error as a lost link', async () => {
    for (const status of [403, 500]) {
      respondWith(status, { error: { code: 'FEATURE_UNAVAILABLE', message: 'nope' } })
      const err = await api.get('/api/sql/saved').catch((e: unknown) => e)
      expect(isTransportFailure(err)).toBe(false)
    }
  })
})
