import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Guards the Vercel reverse proxy (`/api/[...path].ts`). A self-referential
 * API_ORIGIN used to make the function call itself until Vercel answered 508
 * INFINITE_LOOP_DETECTED, which hides the real misconfiguration.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

async function loadHandler(): Promise<Handler> {
  const mod = (await import('../../../../api/[...path].ts')) as { default: Handler }
  return mod.default
}

function makeRes() {
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(chunk?: string) {
      if (chunk) body += chunk
    },
  }
  return { res: res as unknown as ServerResponse, headers, body: () => body }
}

function makeReq(headers: Record<string, string>, url = '/api/providers'): IncomingMessage {
  return { method: 'GET', url, headers } as unknown as IncomingMessage
}

/** A POST the proxy can drain: `readBody` async-iterates the request stream. */
function makePostReq(url: string, headers: Record<string, string> = { host: 'dbremote.vercel.app' }, payload = ''): IncomingMessage {
  const req = {
    method: 'POST',
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload)
    },
  }
  return req as unknown as IncomingMessage
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('vercel api proxy', () => {
  it('rejects an API_ORIGIN that points at the deployment itself', async () => {
    vi.stubEnv('API_ORIGIN', 'https://dbremote.vercel.app')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(body()).error.code).toBe('API_ORIGIN_LOOP')
    // The loop must be stopped before any outbound request is attempted.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ignores the port when comparing the deployment host', async () => {
    vi.stubEnv('API_ORIGIN', 'http://127.0.0.1:3001')
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: '127.0.0.1:3001' }), res)

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(body()).error.code).toBe('API_ORIGIN_LOOP')
  })

  it('rejects a serverless origin even when it differs from the request host', async () => {
    // On the Vercel edge the function sees the *deployment* host, not the public
    // alias, so a self-referential origin would otherwise slip past the hostname
    // comparison and silently proxy /api/* to the SPA fallback.
    vi.stubEnv('API_ORIGIN', 'https://dbremote.vercel.app')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: 'database-1a2b3c4d-rajroy1313s-projects.vercel.app' }), res)

    expect(res.statusCode).toBe(503)
    expect(JSON.parse(body()).error.code).toBe('API_ORIGIN_LOOP')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still proxies to a distinct upstream origin', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const handler = await loadHandler()
    const { res } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
  })
})

/**
 * A dead API host used to take the entire dashboard down: every /api call
 * returned 502, which the UI reports as "Could not load the provider catalog".
 * These tests pin the two behaviours that keep that from being fatal, and the
 * rule that makes failover safe: never replay a write whose outcome is unknown.
 */
describe('vercel api proxy failover', () => {
  function connectError(code: string): Error {
    return Object.assign(new Error('fetch failed'), { cause: { code } })
  }

  it('falls back to API_ORIGIN_FALLBACK when the primary refuses connections', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connectError('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('{"providers":[]}', { status: 200 }))
    const handler = await loadHandler()
    const { res } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const urls = fetchSpy.mock.calls.map((c) => String((c[0] as URL).hostname))
    expect(urls).toEqual(['api-a.example.com', 'api-b.example.com'])
  })

  it('does not replay a POST when the failure is ambiguous', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    // Socket reset after the request was sent: the write may have been applied.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }))
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makePostReq('/api/connections/api', undefined, '{"providerId":"neon"}'), res)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(body()).error.code).toBe('AMBIGUOUS_UPSTREAM')
  })

  it('may replay a POST that provably never connected', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(connectError('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('{"connected":true}', { status: 200 }))
    const handler = await loadHandler()
    const { res } = makeRes()

    await handler(makePostReq('/api/auth/login', undefined, '{"username":"a"}'), res)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(res.statusCode).toBe(200)
  })

  it('fails over when the origin tunnel answers with a non-JSON gateway error', async () => {
    // A dead workspace tunnel hangs, then the platform times out and returns
    // plain-text 502 from Vercel itself. That is not an exception, so it has to
    // be recognised by status + content-type or failover never runs.
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('{"providers":[]}', { status: 200 }))
    const handler = await loadHandler()
    const { res, headers } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(headers['x-dbh-origin']).toBe('fallback')
  })

  it('passes through a JSON 502 from the API instead of retrying', async () => {
    // The app always answers with its own error envelope; that must be returned
    // verbatim, not treated as infrastructure failure.
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    const appError = JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'nope' } })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(appError, { status: 502, headers: { 'content-type': 'application/json' } }))
    const handler = await loadHandler()
    const { res, body, headers } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(body()).error.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(headers['x-dbh-origin']).toBe('primary')
  })

  it('bounds each upstream attempt so a hung tunnel cannot reach the platform timeout', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce(new Response('{"providers":[]}', { status: 200 }))
    const handler = await loadHandler()
    const { res } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(200)
    // Every attempt must carry an abort signal, or the request has no ceiling.
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeDefined()
    }
  })

  it('reports 502 with an actionable code when every origin is down', async () => {
    vi.stubEnv('API_ORIGIN', 'https://api-a.example.com')
    vi.stubEnv('API_ORIGIN_FALLBACK', 'https://api-b.example.com')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connectError('ENOTFOUND'))
    const handler = await loadHandler()
    const { res, body } = makeRes()

    await handler(makeReq({ host: 'dbremote.vercel.app' }), res)

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(body()).error.code).toBe('UPSTREAM_UNAVAILABLE')
  })
})