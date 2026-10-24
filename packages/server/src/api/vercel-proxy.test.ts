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